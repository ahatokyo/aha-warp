// ============================================================
// PETCHA モニター応募 自動記録（LINE Messaging API Webhook受け）
//   公開URL: https://petcha.aha-tokyo.com/api/line-webhook
//
// 設定手順（LINE側）:
//   1. LINE Developers > PETCHAのMessaging APIチャネル > Webhook設定に上記URLを登録
//      →「Webhookの利用」をON →「検証」ボタンで疎通確認
//   2. チャネルシークレット / 長期チャネルアクセストークンを Vercel 環境変数へ:
//        PETCHA_LINE_CHANNEL_SECRET       （署名検証用。必須）
//        PETCHA_LINE_CHANNEL_ACCESS_TOKEN （表示名取得用。無ければ表示名なしで記録）
//   ※ LINE公式アカウントの「チャット」運用とWebhookは併用可能。
//     このエンドポイントは一切返信しない（記録のみ）ため、チャット画面・手動返信・
//     チャットタグ・応答メッセージ設定には影響しない。
//
// 仕様:
//   - テキストメッセージをNFKC正規化＋空白除去し、「モニター希望」を部分一致で判定
//     （前後の絵文字・挨拶・改行を許容。完全一致にしない）
//   - pecha_monitor_applications に記録。同一userIdは最初の1件のみ有効（冪等。
//     ユニークインデックスが最終防衛。LINEのwebhook再送でも二重記録されない）
//   - 先着順は LINE イベントの timestamp を採用（再送・処理遅延の影響を受けない）
//   - 応募受付の自動返信は現時点でスコープ外（手動対応）。将来足す場合は
//     下の「AUTO-REPLY挿入位置」に event.replyToken を使った返信を実装する
// 状態: PETCHA_LINE_CHANNEL_SECRET 未設定のうちは 503 で待機（Stripe webhookと同方式）
// ============================================================

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

// 署名検証のため raw body が必要 → Vercel の自動JSONパースを無効化
export const config = { api: { bodyParser: false } };

const CHANNEL_SECRET = process.env.PETCHA_LINE_CHANNEL_SECRET || '';
const CHANNEL_ACCESS_TOKEN = process.env.PETCHA_LINE_CHANNEL_ACCESS_TOKEN || '';

const MONITOR_KEYWORD = 'モニター希望';   // 判定キーワード（正規化後の部分一致）

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 表記ゆれ吸収: NFKC正規化（全角/半角・互換文字）＋空白/改行の除去
function normalizeText(s) {
  return String(s || '').normalize('NFKC').replace(/\s+/g, '');
}

// 表示名の取得（ベストエフォート。友だち解除等で取れなくても記録は続行）
async function fetchDisplayName(userId) {
  if (!CHANNEL_ACCESS_TOKEN) return null;
  try {
    const r = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
      headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` }
    });
    if (!r.ok) return null;
    const p = await r.json();
    return p.displayName || null;
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).end(); return; }
  if (!CHANNEL_SECRET || !supabase) { res.status(503).end('not configured'); return; }

  // --- 署名検証（x-line-signature = HMAC-SHA256(channel secret, raw body) の base64） ---
  const raw = await readRawBody(req);
  const expected = crypto.createHmac('sha256', CHANNEL_SECRET).update(raw).digest('base64');
  const given = req.headers['x-line-signature'] || '';
  const a = Buffer.from(expected), b = Buffer.from(String(given));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.error('line-webhook: signature mismatch');
    res.status(401).end('bad signature');
    return;
  }

  let body;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch (e) { res.status(400).end('bad json'); return; }

  // LINEの「検証」ボタンは events が空で届く → そのまま200
  const events = Array.isArray(body && body.events) ? body.events : [];

  for (const event of events) {
    try {
      if (event.type !== 'message') continue;
      if (!event.message || event.message.type !== 'text') continue;
      const userId = event.source && event.source.userId;
      if (!userId) continue;
      if (!normalizeText(event.message.text).includes(MONITOR_KEYWORD)) continue;

      // 冪等: 既に応募済みならスキップ（連番の欠番を避けるため先にチェック。
      // 同時到達のレースはユニークインデックス側の 23505 で握る）
      const { data: exists, error: selErr } = await supabase
        .from('pecha_monitor_applications')
        .select('id')
        .eq('line_user_id', userId)
        .limit(1);
      if (selErr) { console.error('monitor select error:', selErr); continue; }
      if (exists && exists.length) continue;

      const displayName = await fetchDisplayName(userId);
      const appliedAt = event.timestamp
        ? new Date(event.timestamp).toISOString()   // 先着順はLINEイベント時刻を正とする
        : new Date().toISOString();

      const { error: insErr } = await supabase.from('pecha_monitor_applications').insert({
        line_user_id: userId,
        display_name: displayName,
        raw_text: String(event.message.text || '').slice(0, 500),
        applied_at: appliedAt
      });
      if (insErr) {
        if (insErr.code === '23505') continue;   // 同時到達の重複 → 初回のみ有効
        console.error('monitor insert error:', insErr);
        continue;
      }
      console.log('monitor application recorded:', { userId, displayName });

      // --- AUTO-REPLY挿入位置（将来用・現在はスコープ外） ---
      // 応募受付の自動返信を足す場合はここで event.replyToken を使い
      // POST https://api.line.me/v2/bot/message/reply を呼ぶ。
      // 例: await replyText(event.replyToken, '応募を受け付けました🐾');
    } catch (e) {
      console.error('line-webhook event error (ignored):', e);
    }
  }

  // LINEプラットフォームには常に200を返す（個別イベントの失敗で再送ループにしない）
  res.status(200).json({ received: true });
}

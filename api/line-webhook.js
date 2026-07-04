// ============================================================
// モバティ公式LINE (@633vvlal) Messaging API Webhook受け（統合版）
//   公開URL: https://petcha.aha-tokyo.com/api/line-webhook
//
// 経緯: PETCHAの配信母体はモバティのチャネルで、Webhookは1チャネルに1本のみ。
//   旧 line-webhook-ai (https://line-webhook-ai.vercel.app/api/webhook) の処理を
//   本ファイルに合流させ、Webhook URLをこちらへ切り替える（2026-07-04 CEO方針）。
//   旧リポジトリの api/survey.js はwebhookではない（フロントから直接POST）ため
//   影響なし＝line-webhook-ai プロジェクトはそのまま残す。
//
// 担当処理（1つのイベントに対し上から順に判定）:
//   A. メニュークリック記録（旧webhookから移植・挙動維持）:
//      テキストが「AI診断」「セミナー申込」に完全一致（trim後）
//      → Googleスプレッドシート「クリック履歴」へ記録 ＋ 該当URLを自動返信
//   B. モニター応募記録（新規）: 「モニター希望」を含むテキスト
//      → pecha_monitor_applications へ冪等INSERT。返信なし（手動対応）
//   C. 友だち追加（旧webhookから移植・挙動維持）:
//      referrerId に ai_shindan を含む follow → セミナー案内を自動返信
//
// 旧webhookとの差分: x-line-signature の署名検証を追加（旧は未検証だった）
//
// 必要な環境変数（Vercel / aha-warp プロジェクト）:
//   LINE_CHANNEL_SECRET       … @633vvlal チャネルシークレット（LINE Developers > チャネル基本設定）
//   LINE_CHANNEL_ACCESS_TOKEN … 同チャネルの長期トークン（旧line-webhook-aiの同名envからコピー可）
//   GOOGLE_CREDENTIALS        … サービスアカウントJSON文字列（旧line-webhook-aiの同名envからコピー可）
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY … 既存設定を利用（モニター応募記録用）
// 状態: LINE_CHANNEL_SECRET 未設定のうちは 503 で待機
// ============================================================

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';

// 署名検証のため raw body が必要 → Vercel の自動JSONパースを無効化
export const config = { api: { bodyParser: false } };

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';

// --- B. モニター応募 ---
const MONITOR_KEYWORD = 'モニター希望';   // 判定キーワード（正規化後の部分一致）

// --- A. メニュークリック記録（旧 line-webhook-ai/api/webhook.js から移植。値は変更しない） ---
const CLICK_SPREADSHEET_ID = '1ltwJaeAjfBmiZd2MSUT-ALmGL7zffuKLPm3sXeIx3HI';
const CLICK_SHEET_NAME = 'クリック履歴';
const MENU_KEYWORDS = {
  'AI診断': 'AI診断',
  'セミナー申込': 'セミナー申込',
};
const MENU_URLS = {
  'AI診断': 'https://lp.aha-tokyo.com/imakoso_lp.html?',
  'セミナー申込': 'https://lp.aha-tokyo.com/imakoso.html?',
};

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

// 表示名の取得（ベストエフォート。取れなくても処理は続行）
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

// LINEへのテキスト返信（旧webhookのaxios実装をfetchで置き換え。挙動は同一）
async function replyText(replyToken, text) {
  const r = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
  });
  if (!r.ok) throw new Error('LINE reply ' + r.status + ': ' + (await r.text()));
}

// ===== A. メニュークリック記録（旧webhookのロジックをそのまま移植） =====
function getSheets() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function recordClick(userId, displayName, menuKey, timestamp) {
  const sheets = getSheets();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: CLICK_SPREADSHEET_ID,
    range: `${CLICK_SHEET_NAME}!A:G`,
  });
  const rows = res.data.values || [];

  if (rows.length === 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: CLICK_SPREADSHEET_ID,
      range: `${CLICK_SHEET_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [['LINE ID', '表示名', 'AI診断クリック数', 'セミナー申込クリック数', '最終クリックメニュー', '最終クリック日時', '初回登録日時']]
      }
    });
  }

  const menuLabel = MENU_KEYWORDS[menuKey];
  const menuColIndex = { 'AI診断': 2, 'セミナー申込': 3 };
  const col = menuColIndex[menuKey];

  const dataRows = rows.slice(1);
  let userRowIndex = -1;
  for (let i = 0; i < dataRows.length; i++) {
    if (dataRows[i][0] === userId) {
      userRowIndex = i + 2;
      break;
    }
  }

  const now = new Date(timestamp).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

  if (userRowIndex === -1) {
    const newRow = [userId, displayName, 0, 0, menuLabel, now, now];
    newRow[col] = 1;
    await sheets.spreadsheets.values.append({
      spreadsheetId: CLICK_SPREADSHEET_ID,
      range: `${CLICK_SHEET_NAME}!A:G`,
      valueInputOption: 'RAW',
      requestBody: { values: [newRow] }
    });
  } else {
    const currentRow = dataRows[userRowIndex - 2];
    const currentCount = parseInt(currentRow[col] || 0) + 1;
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: CLICK_SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data: [
          { range: `${CLICK_SHEET_NAME}!B${userRowIndex}`, values: [[displayName]] },
          { range: `${CLICK_SHEET_NAME}!${String.fromCharCode(65 + col)}${userRowIndex}`, values: [[currentCount]] },
          { range: `${CLICK_SHEET_NAME}!E${userRowIndex}`, values: [[menuLabel]] },
          { range: `${CLICK_SHEET_NAME}!F${userRowIndex}`, values: [[now]] },
        ]
      }
    });
  }
}

// ===== B. モニター応募記録 =====
async function recordMonitorApplication(event) {
  const userId = event.source && event.source.userId;
  if (!userId || !supabase) return;

  // 冪等: 既に応募済みならスキップ（連番の欠番を避けるため先にチェック。
  // 同時到達のレースはユニークインデックス側の 23505 で握る）
  const { data: exists, error: selErr } = await supabase
    .from('pecha_monitor_applications')
    .select('id')
    .eq('line_user_id', userId)
    .limit(1);
  if (selErr) { console.error('monitor select error:', selErr); return; }
  if (exists && exists.length) return;

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
    if (insErr.code === '23505') return;   // 同時到達の重複 → 初回のみ有効
    console.error('monitor insert error:', insErr);
    return;
  }
  console.log('monitor application recorded:', { userId, displayName });

  // --- AUTO-REPLY挿入位置（将来用・現在はスコープ外） ---
  // 応募受付の自動返信を足す場合はここで event.replyToken を使う。
  // 例: await replyText(event.replyToken, '応募を受け付けました🐾');
}

// ===== C. 友だち追加（旧webhookから移植・文面もそのまま） =====
async function handleFollow(event) {
  const referrerId = (event.source && event.source.referrerId) || '';
  if (!referrerId.includes('ai_shindan') || !event.replyToken) return;
  await replyText(event.replyToken,
    '診断お疲れさまでした！🎉\n\n「AIを使いたいけど、何から始めればいいかわからない」\n「試してみたけど、うまく使いこなせていない」\n\nそんな方に、ぴったりの無料セミナーがあります。\n\n20個以上のAIツールを実際に活用してきた経験から、主要ツールの特徴と使い分けを、明日から実践できる形でお伝えします。\n\nChatGPTだけが頼りになっていませんか？　AIにも、セカンドオピニオンを。👇\n\nhttps://takumiyamzaki.stores.jp/items/69fc818a519201aa8a5933fd');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).end(); return; }
  if (!CHANNEL_SECRET) { res.status(503).end('not configured'); return; }

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
      if (event.type === 'message' && event.message && event.message.type === 'text') {
        const userId = event.source && event.source.userId;
        const trimmed = String(event.message.text || '').trim();

        // A. メニュークリック（完全一致。旧webhookと同じ判定・記録・自動返信）
        if (userId && MENU_KEYWORDS[trimmed]) {
          const displayName = (await fetchDisplayName(userId)) || userId;
          await Promise.all([
            recordClick(userId, displayName, trimmed, event.timestamp),
            replyText(event.replyToken, `こちらからどうぞ👇\n${MENU_URLS[trimmed]}`)
          ]);
          continue;
        }

        // B. モニター応募（部分一致・表記ゆれ許容。返信なし）
        if (normalizeText(event.message.text).includes(MONITOR_KEYWORD)) {
          await recordMonitorApplication(event);
          continue;
        }
      }

      // C. 友だち追加（ai_shindan 経由のみ自動返信）
      if (event.type === 'follow') {
        await handleFollow(event);
      }
    } catch (e) {
      console.error('line-webhook event error (ignored):', e);
    }
  }

  // LINEプラットフォームには常に200を返す（個別イベントの失敗で再送ループにしない）
  res.status(200).json({ received: true });
}

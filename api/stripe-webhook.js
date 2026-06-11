// ============================================================
// PECHA §5-4: Stripe Webhook 受け（都度課金）
// 置き場所: pecha.html と同じ Vercel プロジェクトの api/ 配下
//   → 公開URL: https://petcha.aha-tokyo.com/api/stripe-webhook
//   → Stripe ダッシュボード「Webhooks」でこのURLを登録し、
//     checkout.session.completed を購読 → 取得した signing secret を
//     環境変数 STRIPE_WEBHOOK_SECRET に設定する。
//
// v2方針: サブスク用イベント（invoice.payment_succeeded 等）は不要。
//   主な仕事は「お試し購入時に trial_used_at をセット（1ID1回の確定）」のみ。
//   ※ガチャ自体の付与は決済成功後にフロント（pecha.html）が回数ぶん実行する設計。
// 状態: STRIPE_WEBHOOK_SECRET 未設定のうちは 503 で待機。
// ============================================================

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// 署名検証のため raw body が必要 → Vercel の自動JSONパースを無効化
export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2024-06-20'
});

// 書き込みは service role キーで（RLSをバイパス）。anon keyではなくサーバー専用キーを使う。
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

// ============================================================
// グッズ注文の通知メール（Resend）
//   - 送信は fetch で Resend REST API を直接叩く（SDK依存なし）
//   - APIキー・fromアドレス・運営宛先はすべて環境変数で管理（ハードコードしない）
//       RESEND_API_KEY   : Resend APIキー（必須。未設定なら送信スキップ）
//       MAIL_FROM        : 送信元（既定 'PETCHA by AHA TOKYO <noreply@aha-tokyo.com>'）
//       ORDER_NOTIFY_TO  : 運営宛先（既定 'info@aha-tokyo.com'）
//   - メール送信失敗は Supabase 記録に影響させない（呼び出し側で try/catch）
// ============================================================
const GOODS_NAMES = {
  tshirt:    'プレミアムTシャツ (6.2oz)',
  tshirt_ls: 'プレミアム長袖Tシャツ (6.2oz)',
  tote_s:    'トートバッグ S',
  tote_m:    'トートバッグ M',
  sacoche:   'サコッシュ',
  sweat:     'スウェット',
  sticker:   'シール (10×17cm)'
};

function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g,
    m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// Stripeのaddressオブジェクトを日本語の住所文字列に整形（郵便番号は別カラムで保持）
function formatJpAddress(a) {
  if (!a) return null;
  const parts = [a.state, a.city, a.line1, a.line2].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

// 注文内容の明細テーブル（購入者・運営の両メールで共用）
function orderDetailRowsHtml(md, amountTotal) {
  const rows = [['商品', GOODS_NAMES[md.product] || md.product || '商品']];
  if (md.color)     rows.push(['カラー', md.color]);
  if (md.size)      rows.push(['サイズ', md.size]);
  if (md.printSide) rows.push(['プリント位置', md.printSide === 'front' ? '前面' : (md.printSide === 'back' ? '背面' : md.printSide)]);
  rows.push(['文字入れ', md.withText === '1' ? ('あり：「' + (md.textContent || '') + '」') : 'なし']);
  if (amountTotal != null) rows.push(['お支払い金額（送料込み）', '¥' + Number(amountTotal).toLocaleString()]);
  return '<table style="border-collapse:collapse;font-size:14px;">'
    + rows.map(r => `<tr><td style="padding:4px 14px 4px 0;color:#666;white-space:nowrap;vertical-align:top;">${escapeHtml(r[0])}</td>`
        + `<td style="padding:4px 0;font-weight:bold;">${escapeHtml(r[1])}</td></tr>`).join('')
    + '</table>';
}

// Resend REST APIで1通送信（fromは環境変数）。失敗時はthrow（呼び出し側がcatch）。
async function sendResendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.warn('RESEND_API_KEY 未設定 → メール送信スキップ'); return; }
  const from = process.env.MAIL_FROM || 'PETCHA by AHA TOKYO <noreply@aha-tokyo.com>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: Array.isArray(to) ? to : [to], subject, html })
  });
  if (!res.ok) throw new Error('Resend ' + res.status + ': ' + (await res.text()));
}

// 購入者＋運営の2通を送信。各送信は個別try/catchで、片方が失敗しても他方は送る。
async function sendOrderEmails({ md, session, orderRow, orderId }) {
  const amount = session.amount_total;
  const detail = orderDetailRowsHtml(md, amount);

  // --- 購入者への注文確認メール ---
  const buyerEmail = orderRow.buyer_email;
  if (buyerEmail) {
    const html = `<div style="font-family:sans-serif;color:#333;line-height:1.7;max-width:520px;">
      <p>この度はPETCHA（ペッチャ）のグッズをご注文いただき、ありがとうございます🐾</p>
      <p>以下の内容でご注文を承りました。</p>
      ${detail}
      <p style="margin-top:18px;">完成イメージを<b>2営業日以内</b>に、モバティ by AHA TOKYO 公式LINEよりお送りします。</p>
      <p style="font-size:13px;color:#666;">ご不明な点等ございましたら、同LINEのチャットにてお気軽にご連絡ください。</p>
      <p style="font-size:12px;color:#999;margin-top:20px;">PETCHA by AHA TOKYO</p>
    </div>`;
    try {
      await sendResendEmail({ to: buyerEmail, subject: '【PETCHA】ご注文ありがとうございます', html });
    } catch (e) {
      console.error('buyer email failed (ignored):', e);
    }
  } else {
    console.warn('購入者メールアドレス未取得 → 購入者メールはスキップ');
  }

  // --- 運営への新規注文通知メール（出荷に必要な情報を1通に集約）---
  const to = process.env.ORDER_NOTIFY_TO || 'info@aha-tokyo.com';
  const shipHtml = '<table style="border-collapse:collapse;font-size:14px;">'
    + [['氏名', orderRow.recipient_name], ['郵便番号', orderRow.postal_code], ['住所', orderRow.address],
       ['電話', orderRow.phone], ['購入者メール', orderRow.buyer_email]]
        .map(r => `<tr><td style="padding:4px 14px 4px 0;color:#666;white-space:nowrap;vertical-align:top;">${escapeHtml(r[0])}</td>`
          + `<td style="padding:4px 0;font-weight:bold;">${escapeHtml(r[1] || '（未取得）')}</td></tr>`).join('')
    + '</table>';
  const refHtml = '<table style="border-collapse:collapse;font-size:13px;color:#666;">'
    + [['Supabase行ID', orderId], ['line_user_id', orderRow.line_user_id], ['Stripe決済ID', orderRow.stripe_payment_id],
       ['イラストURL', orderRow.illustration_id]]
        .map(r => `<tr><td style="padding:3px 14px 3px 0;white-space:nowrap;vertical-align:top;">${escapeHtml(r[0])}</td>`
          + `<td style="padding:3px 0;word-break:break-all;">${escapeHtml(r[1] || '-')}</td></tr>`).join('')
    + '</table>';
  const adminHtml = `<div style="font-family:sans-serif;color:#333;line-height:1.7;max-width:560px;">
    <p style="font-weight:bold;font-size:15px;">🎁 新規グッズ注文が入りました</p>
    <h3 style="margin:14px 0 4px;font-size:14px;">注文内容</h3>
    ${detail}
    <h3 style="margin:18px 0 4px;font-size:14px;">配送先</h3>
    ${shipHtml}
    <h3 style="margin:18px 0 4px;font-size:14px;">参照情報</h3>
    ${refHtml}
  </div>`;
  try {
    await sendResendEmail({ to, subject: '【PETCHA】新規グッズ注文', html: adminHtml });
  } catch (e) {
    console.error('admin email failed (ignored):', e);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!whSecret || !process.env.STRIPE_SECRET_KEY) {
    res.status(503).end('not configured');
    return;
  }

  // --- 署名検証 ---
  let event;
  try {
    const raw = await readRawBody(req);
    event = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], whSecret);
  } catch (e) {
    console.error('webhook signature error:', e.message);
    res.status(400).send(`Webhook Error: ${e.message}`);
    return;
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      const md = s.metadata || {};
      const lineUserId = md.lineUserId || s.client_reference_id;

      if (md.kind === 'gift') {
        // ② ガチャ券プレゼント購入 → トークンごとに credits=1 のレコードを発行（1枚=1URL）
        const tokens = String(md.tokens || md.token || '').split(',').map(s => s.trim()).filter(Boolean);
        if (tokens.length && supabase) {
          const rows = tokens.map(t => ({
            token: t,
            sender_line_user_id: lineUserId || null,
            credits: 1
          }));
          const { error } = await supabase.from('pecha_gifts').insert(rows);
          if (error) console.error('gift insert error:', error);
        }
      } else if (md.kind === 'goods') {
        // グッズ注文 → pecha_orders に保存（配送先も保存）。記録を最優先し、メールは後段で別try/catch。
        const cust = s.customer_details || {};
        // 配送先の格納先はAPIバージョンで異なる：
        //   新: s.collected_information.shipping_details.address
        //   旧: s.shipping_details.address / s.shipping.address
        //   最終手段: customer_details.address（請求先。shipping収集時は空のことが多い）
        const ci = s.collected_information || {};
        const ship = ci.shipping_details || s.shipping_details || s.shipping || {};
        const addr = ship.address || cust.address || {};
        // ▼▼▼ 一時デバッグ（住所フィールド特定用・Vercelログで確認後に除去）▼▼▼
        console.log('[goods addr debug]', JSON.stringify({
          customer_details: s.customer_details || null,
          shipping_details: s.shipping_details || null,
          shipping: s.shipping || null,
          collected_information: s.collected_information || null,
          resolved_addr: addr
        }));
        // ▲▲▲ 一時デバッグ ▲▲▲
        const orderRow = {
          line_user_id: lineUserId || null,
          illustration_id: md.illustrationUrl || null,
          product_type: md.product || null,
          color: md.color || null,
          size: md.size || null,
          print_side: md.printSide || null,
          text_content: md.textContent || null,
          amount: (s.amount_total != null ? s.amount_total : null),
          stripe_payment_id: s.payment_intent || s.id || null,
          status: 'paid',
          // ① 配送先（StripeのCheckoutで収集した値）
          recipient_name: ship.name || cust.name || null,
          postal_code: addr.postal_code || null,
          address: formatJpAddress(addr),
          phone: cust.phone || ship.phone || null,
          buyer_email: cust.email || null
        };

        // 記録を最優先：先にSupabaseへ保存し、行IDを取得（メールより前に確実に行う）
        let orderId = null;
        if (supabase) {
          const { data, error } = await supabase.from('pecha_orders').insert(orderRow).select().single();
          if (error) console.error('order insert error:', error);
          else if (data) orderId = data.id;
        }

        // ②③ 通知メール（Resend）。失敗してもwebhookは200で返す（記録は上で完了済み）。
        try {
          await sendOrderEmails({ md, session: s, orderRow, orderId });
        } catch (mailErr) {
          console.error('order email error (ignored):', mailErr);
        }
      } else {
        // ① ガチャ購入 → クレジット加算（add_credits RPC = 原子的）
        const amount = parseInt(md.credits || '1', 10);
        if (lineUserId && supabase) {
          const { error } = await supabase.rpc('add_credits', {
            p_line_user_id: lineUserId,
            p_amount: amount
          });
          if (error) console.error('add_credits error:', error);
          // お試し購入 → trial_used_at をセット（既に入っていれば上書きしない）
          if (md.isTrial === '1') {
            const { error: e2 } = await supabase
              .from('pecha_users')
              .update({ trial_used_at: new Date().toISOString() })
              .eq('line_user_id', lineUserId)
              .is('trial_used_at', null);
            if (e2) console.error('trial_used_at update error:', e2);
          }
        }
      }

      console.log('checkout.session.completed', { lineUserId, kind: md.kind, credits: md.credits });
    }

    res.status(200).json({ received: true });
  } catch (e) {
    console.error('webhook handler error:', e);
    res.status(500).end();
  }
}

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

// カート注文1明細（cartItem）のHTMLテーブル
function cartItemRowsHtml(it) {
  const rows = [['商品', it.name || GOODS_NAMES[it.sku] || it.sku || '商品']];
  if (it.color)     rows.push(['カラー', it.color]);
  if (it.size)      rows.push(['サイズ', it.size]);
  if (it.print_pos) rows.push(['プリント位置', it.print_pos === 'front' ? '前面' : (it.print_pos === 'back' ? '背面' : it.print_pos)]);
  rows.push(['文字入れ', (it.text != null && String(it.text) !== '') ? ('あり：「' + it.text + '」') : 'なし']);
  rows.push(['数量', String(it.quantity || 1)]);
  if (Array.isArray(it.illustration_urls) && it.illustration_urls.length) rows.push(['イラストURL', it.illustration_urls.join(' , ')]);
  return '<table style="border-collapse:collapse;font-size:14px;margin:4px 0 10px;">'
    + rows.map(r => `<tr><td style="padding:3px 14px 3px 0;color:#666;white-space:nowrap;vertical-align:top;">${escapeHtml(r[0])}</td>`
        + `<td style="padding:3px 0;font-weight:bold;word-break:break-all;">${escapeHtml(r[1])}</td></tr>`).join('')
    + '</table>';
}

// カート注文（複数商品）の購入者＋運営メール。row.items をループして全商品を一覧表示。
async function sendCartOrderEmails({ row, session }) {
  const items = Array.isArray(row && row.items) ? row.items : [];
  const amount = session.amount_total;
  const subtotal = (row && row.subtotal != null) ? row.subtotal : null;
  const shippingFee = (row && row.shipping_fee != null) ? row.shipping_fee : null;
  const itemsHtml = items.map((it, i) =>
    `<div style="border-top:1px solid #eee;padding-top:6px;"><b style="font-size:13px;color:#999;">商品 ${i + 1}</b>${cartItemRowsHtml(it)}</div>`).join('');
  // 商品小計／送料（0なら「送料無料」）／合計
  const moneyRows = [];
  if (subtotal != null)    moneyRows.push(['商品小計', '¥' + Number(subtotal).toLocaleString()]);
  if (shippingFee != null) moneyRows.push(['送料', shippingFee === 0 ? '送料無料' : ('¥' + Number(shippingFee).toLocaleString())]);
  if (amount != null)      moneyRows.push(['合計', '¥' + Number(amount).toLocaleString()]);
  const amountHtml = moneyRows.length
    ? '<table style="border-collapse:collapse;font-size:14px;margin-top:8px;">'
      + moneyRows.map((r, i) => `<tr><td style="padding:3px 14px 3px 0;color:#666;">${escapeHtml(r[0])}</td>`
          + `<td style="padding:3px 0;font-weight:bold;${i === moneyRows.length - 1 ? 'font-size:15px;' : ''}">${escapeHtml(r[1])}</td></tr>`).join('')
      + '</table>'
    : '';

  // --- 購入者への注文確認メール ---
  const buyerEmail = row && row.buyer_email;
  if (buyerEmail) {
    const html = `<div style="font-family:sans-serif;color:#333;line-height:1.7;max-width:560px;">
      <p>この度はPETCHA（ペッチャ）のグッズをご注文いただき、ありがとうございます🐾</p>
      <p>以下の内容でご注文を承りました。</p>
      ${itemsHtml}
      ${amountHtml}
      <p style="margin-top:18px;">完成イメージを<b>2営業日以内</b>に、モバティ by AHA TOKYO 公式LINEよりお送りします。</p>
      <p style="font-size:13px;color:#666;">ご不明な点等ございましたら、同LINEのチャットにてお気軽にご連絡ください。</p>
      <p style="font-size:12px;color:#999;margin-top:20px;">PETCHA by AHA TOKYO</p>
    </div>`;
    try { await sendResendEmail({ to: buyerEmail, subject: '【PETCHA】ご注文ありがとうございます', html }); }
    catch (e) { console.error('buyer email failed (ignored):', e); }
  } else {
    console.warn('購入者メールアドレス未取得 → 購入者メールはスキップ');
  }

  // --- 運営への新規注文通知メール（1通で出荷情報を全把握）---
  const to = process.env.ORDER_NOTIFY_TO || 'info@aha-tokyo.com';
  const shipHtml = '<table style="border-collapse:collapse;font-size:14px;">'
    + [['氏名', row && row.recipient_name], ['郵便番号', row && row.postal_code], ['住所', row && row.address],
       ['電話', row && row.phone], ['購入者メール', row && row.buyer_email]]
        .map(r => `<tr><td style="padding:4px 14px 4px 0;color:#666;white-space:nowrap;vertical-align:top;">${escapeHtml(r[0])}</td>`
          + `<td style="padding:4px 0;font-weight:bold;">${escapeHtml(r[1] || '（未取得）')}</td></tr>`).join('')
    + '</table>';
  const refHtml = '<table style="border-collapse:collapse;font-size:13px;color:#666;">'
    + [['Supabase行ID', row && row.id], ['会員番号', row && row.member_no], ['line_user_id', row && row.line_user_id],
       ['Stripe決済ID', row && row.stripe_payment_id]]
        .map(r => `<tr><td style="padding:3px 14px 3px 0;white-space:nowrap;vertical-align:top;">${escapeHtml(r[0])}</td>`
          + `<td style="padding:3px 0;word-break:break-all;">${escapeHtml(r[1] || '-')}</td></tr>`).join('')
    + '</table>';
  const adminHtml = `<div style="font-family:sans-serif;color:#333;line-height:1.7;max-width:600px;">
    <p style="font-weight:bold;font-size:15px;">🎁 新規グッズ注文が入りました（全${items.length}点）</p>
    <h3 style="margin:14px 0 4px;font-size:14px;">注文内容</h3>
    ${itemsHtml}
    ${amountHtml}
    <h3 style="margin:18px 0 4px;font-size:14px;">配送先</h3>
    ${shipHtml}
    <h3 style="margin:18px 0 4px;font-size:14px;">参照情報</h3>
    ${refHtml}
  </div>`;
  try { await sendResendEmail({ to, subject: '【PETCHA】新規グッズ注文', html: adminHtml }); }
  catch (e) { console.error('admin email failed (ignored):', e); }
}

// 注文管理スプレッドシート連携（Make webhook）。
//   - goods_cart の paid 確定＋正式メール送信が終わった「後」に追加で呼ぶだけ。
//     既存のDB記録・メール送信には一切手を入れない。
//   - row.items を 1商品=1POST でループ送信（商品数だけスプシに行が増える）。
//   - 投げっぱなし方針：各POSTは個別try/catchで握り、失敗してもthrowしない
//     （webhookは200を維持。メール連携と同じ堅牢性）。
//   - ORDER_SHEET_WEBHOOK_URL 未設定なら何もせずスキップ（エラーにしない）。
async function postCartOrderToSheet({ row, session }) {
  const url = process.env.ORDER_SHEET_WEBHOOK_URL;
  if (!url || !row) return;
  const items = Array.isArray(row.items) ? row.items : [];
  const orderTotal = (row.amount != null)
    ? row.amount
    : (session && session.amount_total != null ? session.amount_total : null);
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const body = {
      ordered_at: row.created_at ?? null,
      order_id: row.id ?? null,
      line_no: i + 1,
      member_no: row.member_no ?? null,
      product_name: it.name ?? null,
      color: it.color ?? null,
      size: it.size ?? null,
      print_pos: it.print_pos ?? null,
      text: it.text ?? 'なし',
      quantity: it.quantity ?? null,
      illustration_url: (Array.isArray(it.illustration_urls) && it.illustration_urls.length)
        ? it.illustration_urls[0] : null,
      recipient_name: row.recipient_name ?? null,
      postal_code: row.postal_code ?? null,
      address: row.address ?? null,
      phone: row.phone ?? null,
      buyer_email: row.buyer_email ?? null,
      order_total: orderTotal
    };
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (e) {
      console.error('order-sheet webhook failed (ignored):',
        { order_id: row.id, line_no: i + 1, err: e && e.message });
    }
  }
}

// 保険：決済は成立したが注文行に紐づかなかった場合の運営向けアラート（購入者には送らない）。
// 注文内容は不明なため、Stripe側で追跡できる最小情報のみ記載する。
async function sendUnlinkedOrderAlert({ session }) {
  const to = process.env.ORDER_NOTIFY_TO || 'info@aha-tokyo.com';
  const cust = session.customer_details || {};
  const rows = [
    ['金額（合計）', session.amount_total != null ? ('¥' + Number(session.amount_total).toLocaleString()) : '-'],
    ['購入者名', cust.name || '-'],
    ['購入者メール', cust.email || '-'],
    ['電話', cust.phone || '-'],
    ['Stripe決済ID', session.payment_intent || '-'],
    ['Stripe Session ID', session.id || '-'],
    ['metadata.order_id', (session.metadata && session.metadata.order_id) || '(空)']
  ];
  const html = `<div style="font-family:sans-serif;color:#333;line-height:1.7;max-width:560px;">
    <p style="font-weight:bold;font-size:15px;color:#b00;">⚠️ 記録に紐づかない決済が発生しました（要手動対応）</p>
    <p>決済は成立しましたが、pecha_orders の注文行に紐づけられませんでした。Stripeダッシュボードで内容を確認し、手動で対応してください。</p>
    <table style="border-collapse:collapse;font-size:14px;">`
    + rows.map(r => `<tr><td style="padding:4px 14px 4px 0;color:#666;white-space:nowrap;vertical-align:top;">${escapeHtml(r[0])}</td>`
        + `<td style="padding:4px 0;font-weight:bold;word-break:break-all;">${escapeHtml(r[1])}</td></tr>`).join('')
    + `</table>
  </div>`;
  try { await sendResendEmail({ to, subject: '【PETCHA】⚠️記録に紐づかない決済', html }); }
  catch (e) { console.error('unlinked-order alert email failed (ignored):', e); }
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
      } else if (md.kind === 'goods_cart') {
        // カート注文 → pending行を paid に更新＋配送先を書き込み。記録を最優先し、メールは後段で別try/catch。
        // ※ kind一致のみで分岐（order_id欠落時もガチャ加算へ誤って落ちないようにする）。
        const cust = s.customer_details || {};
        const ci = s.collected_information || {};
        const ship = ci.shipping_details || s.shipping_details || s.shipping || {};
        const addr = ship.address || cust.address || {};
        const patch = {
          status: 'paid',
          amount: (s.amount_total != null ? s.amount_total : null),
          stripe_payment_id: s.payment_intent || s.id || null,
          recipient_name: ship.name || cust.name || null,
          postal_code: addr.postal_code || null,
          address: formatJpAddress(addr),
          phone: cust.phone || ship.phone || null,
          buyer_email: cust.email || null
        };
        let row = null;
        if (supabase && md.order_id) {
          const { data, error } = await supabase.from('pecha_orders').update(patch).eq('id', md.order_id).select().single();
          if (error) console.error('cart order update error:', error);
          else row = data;
        } else {
          console.error('cart order: order_id 欠落のため更新スキップ', { order_id: md.order_id });
        }
        // 通知メール（Resend）。失敗してもwebhookは200で返す（記録は上で完了済み）。
        try {
          if (row) {
            // 正常系：行が紐づいたときのみ購入者＋運営の正式メールを送る（現状維持）
            await sendCartOrderEmails({ row, session: s });
          } else {
            // 保険：order_id空 or 該当行なし＝決済はあるが記録に紐づかない。
            // 大きく警告ログを出し、運営にだけ最小情報のアラートを送る（購入者には送らない）。
            console.error('CART ORDER UNLINKED: 決済成立だが注文行に紐づかず（要手動対応）',
              { order_id: md.order_id || '(empty)', session_id: s.id, payment_intent: s.payment_intent || null, amount_total: s.amount_total });
            await sendUnlinkedOrderAlert({ session: s });
          }
        } catch (mailErr) {
          console.error('cart order email error (ignored):', mailErr);
        }
        // 正式メール送信の後：注文管理スプシ連携（Make webhook）へ商品ごとに投げっぱなし。
        // 行が紐づいたときのみ。失敗してもthrowせずwebhookは200を維持する。
        try {
          if (row) await postCartOrderToSheet({ row, session: s });
        } catch (sheetErr) {
          console.error('order-sheet webhook error (ignored):', sheetErr);
        }
      } else if (md.kind === 'goods') {
        // グッズ注文（単品・後方互換）→ pecha_orders に保存（配送先も保存）。記録優先、メールは別try/catch。
        const cust = s.customer_details || {};
        // 配送先の格納先はAPIバージョンで異なる：
        //   新: s.collected_information.shipping_details.address
        //   旧: s.shipping_details.address / s.shipping.address
        //   最終手段: customer_details.address（請求先。shipping収集時は空のことが多い）
        const ci = s.collected_information || {};
        const ship = ci.shipping_details || s.shipping_details || s.shipping || {};
        const addr = ship.address || cust.address || {};
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

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
        // グッズ注文 → pecha_orders に保存（配送先住所はStripe側に保持）
        if (supabase) {
          const { error } = await supabase.from('pecha_orders').insert({
            line_user_id: lineUserId || null,
            illustration_id: md.illustrationUrl || null,
            product_type: md.product || null,
            color: md.color || null,
            size: md.size || null,
            print_side: md.printSide || null,
            text_content: md.textContent || null,
            amount: (s.amount_total != null ? s.amount_total : null),
            stripe_payment_id: s.payment_intent || s.id || null,
            status: 'paid'
          });
          if (error) console.error('order insert error:', error);
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

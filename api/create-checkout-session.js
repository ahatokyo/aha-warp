// ============================================================
// PECHA §5-4: Stripe Checkout セッション作成（都度課金 / payment mode）
// 置き場所: pecha.html と同じ Vercel プロジェクトの api/ 配下
//   → 公開URL: https://aha-warp.vercel.app/api/create-checkout-session
// 状態: price ID（環境変数）が未設定のうちは 503 を返して「待ち」。
//        Stripeで商品を作って Vercel の環境変数に price ID を入れれば自動的に有効化される。
// ============================================================

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2024-06-20'
});

// プラン/グッズ → Stripe price ID（すべて Vercel の環境変数で設定）
const PRICE_BY_PLAN = {
  trial: process.env.STRIPE_PRICE_TRIAL, // お試し500円
  p1:    process.env.STRIPE_PRICE_P1,    // 1回1,000円
  p2:    process.env.STRIPE_PRICE_P2,    // 2回1,800円
  p3:    process.env.STRIPE_PRICE_P3     // 3回2,400円
};
const PRICE_BY_GOODS = {
  sticker: process.env.STRIPE_PRICE_GOODS_STICKER,
  tote:    process.env.STRIPE_PRICE_GOODS_TOTE,
  tshirt:  process.env.STRIPE_PRICE_GOODS_TSHIRT,
  sweat:   process.env.STRIPE_PRICE_GOODS_SWEAT
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  // Stripe未設定のあいだは待機（フロントはプレビュー案内のまま）
  if (!process.env.STRIPE_SECRET_KEY) {
    res.status(503).json({ error: 'Stripe not configured yet' });
    return;
  }

  try {
    const { kind, plan, goods, count, isTrial, lineUserId, imageUrl } = req.body || {};
    const origin = req.headers.origin || `https://${req.headers.host}`;

    let priceId, metadata, successParams;

    if (kind === 'goods') {
      // ----- グッズ購入（結果画面 §5-6）-----
      priceId = PRICE_BY_GOODS[goods];
      metadata = {
        kind: 'goods',
        goods: String(goods || ''),
        imageUrl: String(imageUrl || ''),
        lineUserId: String(lineUserId || '')
      };
      successParams = `goods=${encodeURIComponent(goods || '')}`;
    } else {
      // ----- ガチャ購入（お試し/1/2/3回 §5-4）-----
      priceId = PRICE_BY_PLAN[plan];
      metadata = {
        kind: 'gacha',
        plan: String(plan || ''),
        count: String(count || 1),
        isTrial: isTrial ? '1' : '0',
        lineUserId: String(lineUserId || '')
      };
      // 復帰後にフロントが回数ぶんガチャを実行するためのパラメータ
      successParams = `paid=1&plan=${encodeURIComponent(plan || '')}&count=${encodeURIComponent(count || 1)}`;
    }

    if (!priceId) {
      // 該当 price ID 未設定（＝まだStripeで作っていない）→ 待機扱い
      res.status(503).json({ error: `price id not set for ${kind === 'goods' ? goods : plan}` });
      return;
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment', // ★サブスクではなく都度課金
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/pecha.html?${successParams}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${origin}/pecha.html?canceled=1`,
      metadata,
      client_reference_id: lineUserId ? String(lineUserId) : undefined
    });

    res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('create-checkout-session error:', e);
    res.status(500).json({ error: 'failed to create checkout session' });
  }
}

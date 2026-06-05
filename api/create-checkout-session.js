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

// プラン → 付与クレジット数（① クレジット制）
const CREDITS_BY_PLAN = { trial: 1, p1: 1, p2: 2, p3: 3 };
// ギフト枚数 → 流用する price ID（② 既存と同額。1枚=p1/2枚=p2/3枚=p3）
const GIFT_PRICE_BY_TICKETS = {
  1: process.env.STRIPE_PRICE_P1,
  2: process.env.STRIPE_PRICE_P2,
  3: process.env.STRIPE_PRICE_P3
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
    const { kind, plan, goods, tickets, token, tokens, isTrial, lineUserId, imageUrl } = req.body || {};
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
    } else if (kind === 'gift') {
      // ----- ガチャ券プレゼント購入（② 1枚=1トークン=1レコード。価格は枚数でp1/p2/p3流用）-----
      const tokenList = String(tokens || token || '').split(',').map(s => s.trim()).filter(Boolean);
      const n = Math.min(3, Math.max(1, tokenList.length || parseInt(tickets, 10) || 1));
      priceId = GIFT_PRICE_BY_TICKETS[n];
      metadata = {
        kind: 'gift',
        tokens: tokenList.slice(0, 3).join(','),  // フロント生成の個別トークン（最大3）。各1クレジットの券を発行
        lineUserId: String(lineUserId || '')      // 贈り主
      };
      // 復帰後、フロントは sessionStorage のトークン配列から各リンクを表示
      successParams = `gift_bought=1`;
    } else {
      // ----- ガチャ購入（クレジット追加：お試し/1/2/3回 ①）-----
      priceId = PRICE_BY_PLAN[plan];
      metadata = {
        kind: 'gacha',
        plan: String(plan || ''),
        credits: String(CREDITS_BY_PLAN[plan] || 1),  // 付与クレジット
        isTrial: isTrial ? '1' : '0',
        lineUserId: String(lineUserId || '')
      };
      // 復帰後はクレジット反映を確認するだけ（連続生成は廃止）
      successParams = `paid=1`;
    }

    if (!priceId) {
      // 該当 price ID 未設定（＝まだStripeで作っていない）→ 待機扱い
      res.status(503).json({ error: `price id not set for ${kind || plan}` });
      return;
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment', // ★サブスクではなく都度課金
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/petcha.html?${successParams}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${origin}/petcha.html?canceled=1`,
      metadata,
      client_reference_id: lineUserId ? String(lineUserId) : undefined
    });

    res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('create-checkout-session error:', e);
    res.status(500).json({ error: 'failed to create checkout session' });
  }
}

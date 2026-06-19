// ============================================================
// PECHA §5-4: Stripe Checkout セッション作成（都度課金 / payment mode）
// 置き場所: pecha.html と同じ Vercel プロジェクトの api/ 配下
//   → 公開URL: https://petcha.aha-tokyo.com/api/create-checkout-session
// 状態: price ID（環境変数）が未設定のうちは 503 を返して「待ち」。
//        Stripeで商品を作って Vercel の環境変数に price ID を入れれば自動的に有効化される。
// ============================================================

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2024-06-20'
});

// カート注文の pending 行作成用（service roleキー。RLSバイパス）
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

// プラン/グッズ → Stripe price ID（すべて Vercel の環境変数で設定）
const PRICE_BY_PLAN = {
  trial: process.env.STRIPE_PRICE_TRIAL, // お試し500円
  p1:    process.env.STRIPE_PRICE_P1,    // 1回1,000円
  p2:    process.env.STRIPE_PRICE_P2,    // 2回1,800円
  p3:    process.env.STRIPE_PRICE_P3     // 3回2,400円
};
const PRICE_BY_GOODS = {
  tshirt:    process.env.STRIPE_PRICE_GOODS_TSHIRT,
  tshirt_ls: process.env.STRIPE_PRICE_GOODS_TSHIRT_LS,
  tote_s:    process.env.STRIPE_PRICE_GOODS_TOTE_S,
  tote_m:    process.env.STRIPE_PRICE_GOODS_TOTE_M,
  sacoche:   process.env.STRIPE_PRICE_GOODS_SACOCHE,
  sweat:     process.env.STRIPE_PRICE_GOODS_SWEAT,
  sticker:   process.env.STRIPE_PRICE_GOODS_STICKER
};
const GOODS_SHIPPING_JPY = 600;                                   // 送料（固定）
const FREE_SHIP_THRESHOLD_JPY = 7000;                             // 商品小計がこの額以上で送料無料
const TEXT_OPTION_FEE_JPY = 400;                                  // 文字入れ加算（小計再計算用の金額）
const TEXT_OPTION_PRICE = process.env.STRIPE_PRICE_GOODS_TEXT;    // 文字入れオプション ¥400（Stripe price ID）
// 送料判定の「商品小計」をサーバ側で再計算するための本体価格（円）。petcha.html の PRODUCTS と一致させること。
const GOODS_PRICE_JPY = {
  tshirt: 4400, tshirt_ls: 4900, tote_s: 3500, tote_m: 3800, sacoche: 3800, sweat: 5800, sticker: 1200
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
    const { kind, plan, goods, color, size, printSide, textContent, withText, illustrationUrl,
            tickets, token, tokens, isTrial, lineUserId, items, memberNo } = req.body || {};
    const origin = req.headers.origin || `https://${req.headers.host}`;

    // ===== カート注文（複数商品＋数量）=====
    // line_items: 各商品 price × quantity ＋ 文字入れ行（textありの行のみ×quantity）。送料は shipping_options で1回。
    // ★イラストURL等はmetadataに載せず、pecha_orders(status='pending')へ items(jsonb)で保存。
    //   生成した order_id を client_reference_id と metadata.order_id に入れ、webhookで paid 更新する。
    if (kind === 'goods_cart' && Array.isArray(items) && items.length) {
      const lineItems = [];
      let subtotal = 0;   // ★商品小計をサーバ側で再計算（フロント値は信用しない＝改ざん防止）
      for (const it of items) {
        const pid = PRICE_BY_GOODS[it.sku];
        if (!pid) { res.status(503).json({ error: `price id not set for ${it.sku}` }); return; }
        const qty = Math.min(10, Math.max(1, parseInt(it.quantity, 10) || 1));
        const hasText = (it.text != null && String(it.text) !== '');
        lineItems.push({ price: pid, quantity: qty });
        // 文字入れ +¥400 は「その商品×数量」分（textありの行のみ）
        if (hasText && TEXT_OPTION_PRICE) {
          lineItems.push({ price: TEXT_OPTION_PRICE, quantity: qty });
        }
        subtotal += ((GOODS_PRICE_JPY[it.sku] || 0) + (hasText ? TEXT_OPTION_FEE_JPY : 0)) * qty;
      }

      // 送料無料ライン判定（サーバ側の再計算値で判定）
      const freeShip = subtotal >= FREE_SHIP_THRESHOLD_JPY;
      const shippingFee = freeShip ? 0 : GOODS_SHIPPING_JPY;

      // pending注文をSupabaseに作成（記録を先に確保）。
      // ★記録できないなら決済させない：supabase未設定 or INSERT失敗 or 行IDが取れない場合は
      //   5xxで中断し、order_idが空のまま決済が成立する経路を完全に塞ぐ。
      if (!supabase) {
        console.error('cart checkout aborted: supabase未設定（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）');
        res.status(503).json({ error: '注文の準備に失敗しました。時間をおいて再度お試しください。' });
        return;
      }
      let orderId = null;
      {
        const { data, error } = await supabase.from('pecha_orders').insert({
          line_user_id: lineUserId || null,
          member_no: memberNo || null,
          items: items,
          subtotal: subtotal,
          shipping_fee: shippingFee,
          status: 'pending'
        }).select('id').single();
        if (error || !data || data.id == null) {
          console.error('pending order insert failed → checkout中断:', error);
          res.status(500).json({ error: '注文の準備に失敗しました。時間をおいて再度お試しください。' });
          return;
        }
        orderId = data.id;
      }

      const sessionConfig = {
        mode: 'payment',
        line_items: lineItems,
        success_url: `${origin}/petcha.html?goods_ordered=1&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:  `${origin}/petcha.html?canceled=1`,
        metadata: { kind: 'goods_cart', order_id: orderId ? String(orderId) : '', lineUserId: String(lineUserId || '') },
        client_reference_id: orderId ? String(orderId) : (lineUserId ? String(lineUserId) : undefined),
        // 物販：配送先住所＋電話を収集
        shipping_address_collection: { allowed_countries: ['JP'] },
        phone_number_collection: { enabled: true }
      };
      // 商品小計が無料ライン未満のときのみ送料¥600を1回付ける（以上なら送料なしで作成）
      if (!freeShip) {
        sessionConfig.shipping_options = [{
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: GOODS_SHIPPING_JPY, currency: 'jpy' },
            display_name: '送料'
          }
        }];
      }

      const session = await stripe.checkout.sessions.create(sessionConfig);
      res.status(200).json({ url: session.url });
      return;
    }

    let priceId, metadata, successParams;

    if (kind === 'goods') {
      // ----- グッズ注文（フェーズ1：商品price＋送料＋配送先収集）-----
      priceId = PRICE_BY_GOODS[goods];
      metadata = {
        kind: 'goods',
        product: String(goods || ''),
        color: String(color || ''),
        size: String(size || ''),
        printSide: String(printSide || ''),
        textContent: String(textContent || '').slice(0, 100),
        withText: withText ? '1' : '0',
        illustrationUrl: String(illustrationUrl || '').slice(0, 480),
        lineUserId: String(lineUserId || '')
      };
      successParams = `goods_ordered=1`;
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

    const lineItems = [{ price: priceId, quantity: 1 }];
    // ① 文字入れオプション ¥400（該当時は2行目に追加）
    if (kind === 'goods' && withText && TEXT_OPTION_PRICE) {
      lineItems.push({ price: TEXT_OPTION_PRICE, quantity: 1 });
    }

    const sessionConfig = {
      mode: 'payment', // ★サブスクではなく都度課金
      line_items: lineItems,
      success_url: `${origin}/petcha.html?${successParams}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${origin}/petcha.html?canceled=1`,
      metadata,
      client_reference_id: lineUserId ? String(lineUserId) : undefined
    };

    // グッズは物販 → 配送先住所の収集＋送料（固定¥600）
    if (kind === 'goods') {
      sessionConfig.shipping_address_collection = { allowed_countries: ['JP'] };
      sessionConfig.phone_number_collection = { enabled: true };
      sessionConfig.shipping_options = [{
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: { amount: GOODS_SHIPPING_JPY, currency: 'jpy' },
          display_name: '送料'
        }
      }];
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);
    res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('create-checkout-session error:', e);
    res.status(500).json({ error: 'failed to create checkout session' });
  }
}

// ============================================================
// PETCHA 改修②: おすそわけインセンティブ（ギフト受け取り手のガチャ完了フック）
//   公開URL: https://petcha.aha-tokyo.com/api/gacha-completed
//   呼び出し元: petcha.html の persistResults()（イラスト保存が成功した後）
//
// 役割:
//   1. 呼び出しユーザーが「受領済み・ガチャ未完了」のギフトを持っていれば、
//      サーバー側で pecha_illustrations に生成レコードが実在することを照合してから
//      gacha_completed_at を記録する（クライアント申告だけでは発火しない＝不正対策）
//   2. GIFT_INCENTIVE_ENABLED='1' のときのみ、贈り手へノーマルガチャ1回分を付与
//      - 月1回上限（暦月・JST）と1ギフト1回は pecha_gift_incentives の
//        ユニークインデックスで担保（INSERTの23505で不発判定＝レース耐性）
//      - 自己贈答は redeem_gift が受領自体をブロック済み。ここでも二重防御
//      - 付与は pecha_users.credits への加算（add_credits RPC）。クレジットは
//        ギフト化できない（ギフトは現金決済のみ）ため譲渡不可は構造的に担保
//   3. 記録（gacha_completed_at）はフラグOFFでも行う（週次レポートの計測要件）
//
// フラグ: Vercel環境変数 GIFT_INCENTIVE_ENABLED（'1'でON。モニター期はOFF＝未設定）
// ============================================================

import { createClient } from '@supabase/supabase-js';

const INCENTIVE_ENABLED = process.env.GIFT_INCENTIVE_ENABLED === '1';
const INCENTIVE_CREDITS = 1;   // 付与量: ノーマルガチャ1回分

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/i;

// 月次上限のキー（暦月・JST）。例: '2026-07'
function jstMonthKey() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!supabase) { res.status(503).json({ error: 'not configured' }); return; }

  const { lineUserId } = req.body || {};
  if (!lineUserId || !LINE_USER_ID_RE.test(String(lineUserId))) {
    res.status(400).json({ error: 'invalid lineUserId' });
    return;
  }

  try {
    // 1. このユーザーが「受領済み・ガチャ未完了」のギフト（最古の1件）
    //    受領者は既存列 redeemed_by（redeem_gift が受領時に記録）を参照する
    const { data: gifts, error: gErr } = await supabase.from('pecha_gifts')
      .select('token,sender_line_user_id,redeemed_at')
      .eq('redeemed_by', lineUserId)
      .not('redeemed_at', 'is', null)
      .is('gacha_completed_at', null)
      .order('redeemed_at', { ascending: true })
      .limit(1);
    if (gErr) throw gErr;
    if (!gifts || !gifts.length) { res.status(200).json({ pending: false }); return; }
    const gift = gifts[0];

    // 2. サーバー側照合: 受領以降に、このユーザーのイラスト生成レコードが実在するか。
    //    クライアントの「完了した」申告をそのまま信じない（インセンティブの不正発火対策）
    const { data: ills, error: iErr } = await supabase.from('pecha_illustrations')
      .select('id')
      .eq('line_user_id', lineUserId)
      .gte('created_at', gift.redeemed_at)
      .limit(1);
    if (iErr) throw iErr;
    if (!ills || !ills.length) { res.status(200).json({ pending: true, verified: false }); return; }

    // 3. ガチャ完了を原子的にクレーム（同時リクエストの二重処理防止）
    const { data: claimed, error: cErr } = await supabase.from('pecha_gifts')
      .update({ gacha_completed_at: new Date().toISOString() })
      .eq('token', gift.token)
      .is('gacha_completed_at', null)
      .select('token');
    if (cErr) throw cErr;
    if (!claimed || !claimed.length) { res.status(200).json({ completed: true, incentive: 'already_processed' }); return; }

    // 4. インセンティブ付与判定
    if (!INCENTIVE_ENABLED) { res.status(200).json({ completed: true, incentive: 'disabled' }); return; }
    const sender = gift.sender_line_user_id;
    if (!sender || sender === lineUserId) {
      // 自己贈答は受領時点でブロック済みのはずだが二重防御（付与のみ不発）
      res.status(200).json({ completed: true, incentive: 'self_or_unknown_sender' });
      return;
    }

    // 履歴INSERTが上限判定を兼ねる: 月1回(sender,month_key) / 1ギフト1回(gift_token) の
    // ユニークインデックスに当たれば 23505 → 付与せず正常終了
    const { error: insErr } = await supabase.from('pecha_gift_incentives').insert({
      gift_token: gift.token,
      sender_line_user_id: sender,
      recipient_line_user_id: lineUserId,
      month_key: jstMonthKey()
    });
    if (insErr) {
      if (insErr.code === '23505') { res.status(200).json({ completed: true, incentive: 'monthly_cap' }); return; }
      throw insErr;
    }

    // 5. 付与（履歴確保後に加算。ここで失敗したら履歴だけ残る＝ログで検知して手動対応）
    const { error: addErr } = await supabase.rpc('add_credits', {
      p_line_user_id: sender,
      p_amount: INCENTIVE_CREDITS
    });
    if (addErr) {
      console.error('INCENTIVE GRANT FAILED（履歴あり・付与なし。要手動対応）:',
        { gift_token: gift.token, sender, err: addErr });
      res.status(200).json({ completed: true, incentive: 'grant_failed' });
      return;
    }

    console.log('incentive granted:', { gift_token: gift.token, sender, recipient: lineUserId });
    res.status(200).json({ completed: true, incentive: 'granted' });
  } catch (e) {
    console.error('gacha-completed error:', e);
    res.status(500).json({ error: 'internal error' });
  }
}

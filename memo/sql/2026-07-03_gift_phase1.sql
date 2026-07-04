-- ============================================================
-- PETCHA ギフト改修 Phase 1（モニター用無料券）DBマイグレーション
-- 実行場所: Supabase Dashboard > SQL Editor（プロジェクト majunwobgxvdckyyunxu）
-- 実行順序: このSQLを先に実行 → その後にコード（webhook/バッチ/petcha.html）をデプロイ
--
-- 決定事項（2026-07-03 CEO確認済み）:
--   - 自己贈答は現行どおり受領自体をブロック（-3）。モニター券の「贈る専用」を構造的に担保
--   - 有効期限: monitor_free = 発行から30日 / paid = 発行から180日仮置き
--     （180日は資金決済法・前払式支払手段の6ヶ月以内論点による仮置き。要専門家確認）
--   - 既存のpaid行は expires_at = NULL のまま＝無期限（遡及しない）
-- ============================================================

-- ------------------------------------------------------------
-- Step 0: 実行前確認（このSELECTだけ先に流して現行定義を目視すること）
--   redeem_gift を Step 3 で置き換えるため、現行実装が下記の想定と
--   大きく違わないか確認する。想定と違う場合は Step 3 を現行定義ベースで修正。
--   想定: 戻り値 integer（付与枚数>0 / -1使用済 / -2不正 / -3自分の券）、
--         クレジット付与は pecha_users.credits への加算（add_credits と同経路）
-- ------------------------------------------------------------
SELECT p.proname, pg_get_functiondef(p.oid)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('redeem_gift', 'mark_gift_shared', 'add_credits');

-- ------------------------------------------------------------
-- Step 1: pecha_gifts 列追加
--   gift_type          : 'paid' | 'monitor_free'（券種。受け取り手のUIには出さない）
--   expires_at         : 有効期限（NULL = 無期限。既存行はNULLのまま）
--   opened_at          : リンク開封（初回のみ記録。計測用・参考値）
--   gacha_completed_at : 受け取り手のガチャ完了（改修②の発火点。Phase 3で使用）
--   ※受領者は既存列 redeemed_by を流用する（Step 0確認で判明・2026-07-05決定。
--     新列 recipient_line_user_id は追加しない。参照する既存コードは無く、
--     過去の受領分との連続性を保つため1列に集約）
-- ------------------------------------------------------------
ALTER TABLE public.pecha_gifts
  ADD COLUMN IF NOT EXISTS gift_type text NOT NULL DEFAULT 'paid',
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS opened_at timestamptz,
  ADD COLUMN IF NOT EXISTS gacha_completed_at timestamptz;

DO $$
BEGIN
  ALTER TABLE public.pecha_gifts
    ADD CONSTRAINT pecha_gifts_gift_type_check CHECK (gift_type IN ('paid', 'monitor_free'));
EXCEPTION WHEN duplicate_object THEN NULL;  -- 再実行時はスキップ
END $$;

-- ------------------------------------------------------------
-- Step 2: モニター無料券は1人1枚（部分ユニークインデックスで担保）
--   バッチを何度実行しても2枚目は 23505 で弾かれる（スクリプト側でスキップ扱い）
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS pecha_gifts_monitor_one_per_sender
  ON public.pecha_gifts (sender_line_user_id)
  WHERE gift_type = 'monitor_free';

-- ------------------------------------------------------------
-- Step 3: redeem_gift 改修
--   追加点: 期限切れチェック（戻り値 -4）
--   維持点: 自己贈答は全面ブロック（-3）/ 使用済み（-1）/ 不正トークン（-2）/
--           受領者記録 redeemed_by = p_line_user_id（現行と同じ列に書き続ける）
--   ※ CREATE OR REPLACE は既存のGRANT（anonのEXECUTE）を維持する
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_gift(p_token text, p_line_user_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  g record;
BEGIN
  IF p_token IS NULL OR p_line_user_id IS NULL OR p_line_user_id = '' THEN
    RETURN -2;
  END IF;

  -- 行ロックで二重受領を防止（同一トークンの同時リクエストを直列化）
  SELECT * INTO g FROM pecha_gifts WHERE token = p_token FOR UPDATE;

  IF NOT FOUND THEN RETURN -2; END IF;                                        -- 不正トークン
  IF g.sender_line_user_id = p_line_user_id THEN RETURN -3; END IF;           -- 自分の券（全面ブロック）
  IF g.redeemed_at IS NOT NULL THEN RETURN -1; END IF;                        -- 使用済み
  IF g.expires_at IS NOT NULL AND g.expires_at < now() THEN RETURN -4; END IF;-- 期限切れ

  UPDATE pecha_gifts
     SET redeemed_at = now(),
         redeemed_by = p_line_user_id
   WHERE token = p_token;

  -- クレジット付与（既存の add_credits RPC と同一経路・原子的）
  PERFORM public.add_credits(p_line_user_id, g.credits);

  RETURN g.credits;
END;
$$;

-- ------------------------------------------------------------
-- Step 4: 開封記録RPC（ログイン前のモーダル表示時に呼ぶ。初回のみ記録）
--   トークンを知っていること自体が権限（リンク保持者）。UPDATEは opened_at のみ
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_gift_opened(p_token text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE pecha_gifts SET opened_at = now()
   WHERE token = p_token AND opened_at IS NULL;
$$;

GRANT EXECUTE ON FUNCTION public.mark_gift_opened(text) TO anon;

-- ------------------------------------------------------------
-- Step 5: anon の列レベルSELECT権限（該当する場合のみ）
--   フロントの getGift が expires_at を読むようになる（期限切れ表示用）。
--   pecha_gifts のSELECTを列レベルGRANTで絞っている場合は expires_at を追加。
--   テーブル単位でGRANT済みなら本Stepは不要（実行してもエラーにはならない）。
-- ------------------------------------------------------------
GRANT SELECT (expires_at) ON public.pecha_gifts TO anon;

-- ------------------------------------------------------------
-- 実行後確認
-- ------------------------------------------------------------
-- 列が増えたこと:
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'pecha_gifts' ORDER BY ordinal_position;
-- インデックス:
--   SELECT indexname FROM pg_indexes WHERE tablename = 'pecha_gifts';

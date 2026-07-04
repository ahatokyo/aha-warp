-- ============================================================
-- PETCHA ギフト改修 Phase 3（改修②: おすそわけインセンティブ）DBマイグレーション
-- 実行場所: Supabase Dashboard > SQL Editor（プロジェクト majunwobgxvdckyyunxu）
-- 実行順序: Phase 1 のSQL（2026-07-03_gift_phase1.sql）実行済みが前提。
--           このSQL実行後に api/gacha-completed.js を含むコードをデプロイ。
--           付与のON/OFFはVercel環境変数 GIFT_INCENTIVE_ENABLED で制御
--           （'1'でON。未設定/それ以外はOFF＝モニター期の既定）
--
-- 仕様（CEO決裁済み）:
--   - 受け取り手がガチャを完了した時点で、贈り手にノーマルガチャ1回分を付与
--   - 付与は1アカウント月1回まで（暦月・JST）→ 下のユニークインデックスで構造的に担保
--   - 自己贈答は付与しない（そもそも受領を redeem_gift が -3 でブロック済み。二重防御）
--   - 付与された無料券は pecha_users.credits への加算＝ギフト化の経路が無く譲渡不可
-- ============================================================

-- ------------------------------------------------------------
-- Step 1: 付与履歴テーブル
--   month_key: 'YYYY-MM'（JST基準。API側で算出して書き込む）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pecha_gift_incentives (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gift_token text NOT NULL,
  sender_line_user_id text NOT NULL,
  recipient_line_user_id text NOT NULL,
  month_key text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now()
);

-- 1ギフトにつきインセンティブは1回まで
CREATE UNIQUE INDEX IF NOT EXISTS pecha_gift_incentives_one_per_gift
  ON public.pecha_gift_incentives (gift_token);

-- 月次上限: 同一の贈り手には暦月1回まで（INSERT時の23505で判定＝レース耐性あり）
CREATE UNIQUE INDEX IF NOT EXISTS pecha_gift_incentives_month_cap
  ON public.pecha_gift_incentives (sender_line_user_id, month_key);

-- ------------------------------------------------------------
-- Step 2: RLS有効化（ポリシーなし＝anonキーからは読み書き不可。
--          service role（Vercel Functions）はRLSをバイパスして操作する）
-- ------------------------------------------------------------
ALTER TABLE public.pecha_gift_incentives ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- 実行後確認
-- ------------------------------------------------------------
-- SELECT indexname FROM pg_indexes WHERE tablename = 'pecha_gift_incentives';

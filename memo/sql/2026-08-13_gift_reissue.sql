-- ============================================================
-- PETCHA モニター無料券の「再発行」を可能にする（2026-08-13）
-- 実行場所: Supabase Dashboard > SQL Editor（プロジェクト majunwobgxvdckyyunxu）
--
-- 背景:
--   市原聖美さん（sender U7f74dc4e6e956e547113bffbe1cfb2e4）の既存モニター券は
--   受領済みだが、贈答が本人の意図通り成立しなかった。CEO判断で新規に1枚発行し、
--   贈り直してもらう。
--
-- 問題:
--   部分ユニークインデックス pecha_gifts_monitor_one_per_sender の述語が
--   `WHERE gift_type = 'monitor_free'` のみ。受領済みでも2枚目は 23505 で弾かれる。
--
-- 却下した案:
--   (a) インデックスを一時DROP → INSERT → 同じ定義で再CREATE
--       → 2行になった時点で再CREATEが必ず失敗し、本番が「1人1枚」ガード無しの
--         状態で固定化される。絶対にやらない。
--   (b) 述語を `AND redeemed_at IS NULL` に変更（1文で済む最短案）
--       → scripts/issue-monitor-gifts.mjs の冪等性が壊れる。34名CSVを将来
--         再実行したとき、受領済みの人全員に2枚目が黙って発行される。
--   (c) gift_type='paid' で発行してインデックスを回避
--       → 無料券がpaid扱いになり週次レポート（gift_weekly_report.sql の
--         gift_type別集計）と期限ポリシー（paid=180日）が両方狂う。
--
-- 採用案:
--   再発行であることを示す列 reissued_from を足し、インデックスの対象から外す。
--   - 再発行行は reissued_from に「元の券のtoken」を持つ → インデックス対象外でINSERT可
--   - 通常バッチは reissued_from を書かない → 34名の冪等性は完全に維持
--   - 旧行は一切変更しない → 受領履歴（redeemed_at / redeemed_by / shared_at）が残る
--   - gift_type は 'monitor_free' のまま → 集計の汚染なし
--   - Phase3インセンティブは券単位ユニーク＋月次上限なので二重付与は起きない
-- ============================================================

-- ------------------------------------------------------------
-- Step 0: 実行前確認（このSELECTだけ先に流して現状を目視すること）
--   期待値: 1行、redeemed_at が入っている、token が 'gmscp2sxlme' で始まる
-- ------------------------------------------------------------
SELECT token, credits, gift_type, created_at, shared_at, redeemed_at, redeemed_by, expires_at
FROM public.pecha_gifts
WHERE sender_line_user_id = 'U7f74dc4e6e956e547113bffbe1cfb2e4'
ORDER BY created_at;

-- 現行インデックス定義の確認（述語が gift_type のみであること）
SELECT indexdef FROM pg_indexes
WHERE tablename = 'pecha_gifts' AND indexname = 'pecha_gifts_monitor_one_per_sender';

-- ------------------------------------------------------------
-- Step 1: 列追加とインデックス差し替え
--   DROPとCREATEの間に「ガード無しの隙間」を作らないため単一トランザクションで実行。
--   pecha_gifts は数十行なので CONCURRENTLY 不要（ロック時間は無視できる）。
-- ------------------------------------------------------------
BEGIN;

ALTER TABLE public.pecha_gifts
  ADD COLUMN IF NOT EXISTS reissued_from text;

COMMENT ON COLUMN public.pecha_gifts.reissued_from IS
  '再発行元の券のtoken。NULL=通常発行。モニター券1人1枚のユニーク制約から除外される';

DROP INDEX IF EXISTS public.pecha_gifts_monitor_one_per_sender;

CREATE UNIQUE INDEX pecha_gifts_monitor_one_per_sender
  ON public.pecha_gifts (sender_line_user_id)
  WHERE gift_type = 'monitor_free' AND reissued_from IS NULL;

COMMIT;

-- ------------------------------------------------------------
-- Step 2: 実行後確認
--   期待値: 述語に「AND (reissued_from IS NULL)」が含まれる
-- ------------------------------------------------------------
SELECT indexdef FROM pg_indexes
WHERE tablename = 'pecha_gifts' AND indexname = 'pecha_gifts_monitor_one_per_sender';

-- 通常発行の1人1枚がまだ効いていることの確認（0行＝重複なし）
SELECT sender_line_user_id, count(*)
FROM public.pecha_gifts
WHERE gift_type = 'monitor_free' AND reissued_from IS NULL
GROUP BY sender_line_user_id HAVING count(*) > 1;

-- ------------------------------------------------------------
-- この後の券のINSERTは Claude 側でスクリプト実行する（Kazuoはここまで）
--   expires_at = 2026-09-02T03:53:49.795Z（他33名と揃える／CEO決定 2026-08-13）
-- ------------------------------------------------------------

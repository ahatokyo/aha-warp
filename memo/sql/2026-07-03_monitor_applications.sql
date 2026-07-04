-- ============================================================
-- PETCHA モニター応募 自動記録テーブル
-- 実行場所: Supabase Dashboard > SQL Editor（プロジェクト majunwobgxvdckyyunxu）
-- 実行順序: api/line-webhook.js のデプロイ前にこのSQLを実行
--
-- 書き込みは api/line-webhook.js（service role）のみ。anonからは読み書き不可。
-- 同一userIdの重複応募はユニークインデックスで最初の1件のみ有効。
-- 先着順の連番は id ではなく「applied_at 順の row_number()」を正とする
-- （エクスポートクエリ側で算出。idはレース時の欠番があり得るため）。
-- ============================================================

CREATE TABLE IF NOT EXISTS public.pecha_monitor_applications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  line_user_id text NOT NULL,
  display_name text,                          -- 取得できた場合のみ（ベストエフォート）
  raw_text text,                              -- 受信メッセージ原文（先頭500字）
  applied_at timestamptz NOT NULL DEFAULT now(),  -- LINEイベント時刻（先着順の正）
  created_at timestamptz NOT NULL DEFAULT now(),  -- DB記録時刻
  excluded boolean NOT NULL DEFAULT false,    -- CEO最終フィルタ（除外はDELETEせずフラグ）
  note text                                   -- 除外理由などのメモ
);

CREATE UNIQUE INDEX IF NOT EXISTS pecha_monitor_applications_user
  ON public.pecha_monitor_applications (line_user_id);

-- RLS有効化（ポリシーなし＝anonキーからは不可視。service roleはバイパス）
ALTER TABLE public.pecha_monitor_applications ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 運用クエリ（Supabase SQL Editorで実行）
-- ============================================================

-- ① 充足状況（定員100・上限110の判定用）
-- SELECT count(*) AS applied,
--        count(*) FILTER (WHERE NOT excluded) AS valid
-- FROM pecha_monitor_applications;

-- ② CEOレビュー用一覧（先着順連番付き。除外したい行は excluded を true に更新）
-- SELECT row_number() OVER (ORDER BY applied_at, id) AS seq,
--        line_user_id, display_name, raw_text,
--        applied_at AT TIME ZONE 'Asia/Tokyo' AS applied_at_jst,
--        excluded, note
-- FROM pecha_monitor_applications
-- ORDER BY applied_at, id;

-- （除外の例）
-- UPDATE pecha_monitor_applications SET excluded = true, note = '低タグ該当'
-- WHERE line_user_id = 'Uxxxxxxxx...';

-- ③ 無料券バッチ用CSV（scripts/issue-monitor-gifts.mjs にそのまま渡せる1列）
--    除外済みを外した上で、先着110名まで。結果を「Download CSV」で保存
-- SELECT line_user_id FROM (
--   SELECT line_user_id, row_number() OVER (ORDER BY applied_at, id) AS seq
--   FROM pecha_monitor_applications
--   WHERE NOT excluded
-- ) t
-- WHERE seq <= 110
-- ORDER BY seq;

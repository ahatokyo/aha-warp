-- ============================================================
-- PETCHA ギフト 週次レポート用クエリ（CMO向け）
-- 使い方: Supabase Dashboard > SQL Editor で実行 → 結果の「Download CSV」
-- 主要イベントはすべて pecha_gifts の各タイムスタンプ列に記録されている:
--   created_at=発行 / shared_at=送付(リンクコピー) / opened_at=開封 /
--   redeemed_at=受領 / gacha_completed_at=受け取り手のガチャ完了
-- インセンティブ付与は pecha_gift_incentives（Phase 3以降）
-- ============================================================

-- ① ギフト券 明細（全件・新しい順）
SELECT
  token,
  gift_type,                              -- paid / monitor_free
  credits,
  sender_line_user_id,
  redeemed_by AS recipient_line_user_id,   -- 受領者（既存列redeemed_byを流用）
  created_at  AT TIME ZONE 'Asia/Tokyo' AS issued_at_jst,
  shared_at   AT TIME ZONE 'Asia/Tokyo' AS shared_at_jst,
  opened_at   AT TIME ZONE 'Asia/Tokyo' AS opened_at_jst,
  redeemed_at AT TIME ZONE 'Asia/Tokyo' AS redeemed_at_jst,
  gacha_completed_at AT TIME ZONE 'Asia/Tokyo' AS gacha_completed_at_jst,
  expires_at  AT TIME ZONE 'Asia/Tokyo' AS expires_at_jst
FROM pecha_gifts
ORDER BY created_at DESC;

-- ② 週次ファネルサマリー（JST・直近12週・券種別）
SELECT
  to_char(date_trunc('week', created_at AT TIME ZONE 'Asia/Tokyo'), 'YYYY-MM-DD') AS week_start_jst,
  gift_type,
  count(*)                                   AS issued,
  count(shared_at)                           AS shared,
  count(opened_at)                           AS opened,
  count(redeemed_at)                         AS redeemed,
  count(gacha_completed_at)                  AS gacha_completed
FROM pecha_gifts
WHERE created_at >= now() - interval '12 weeks'
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

-- ③ インセンティブ付与履歴（Phase 3以降。テーブル未作成のうちは実行不可）
SELECT
  month_key,
  count(*) AS granted,
  count(DISTINCT sender_line_user_id) AS unique_senders
FROM pecha_gift_incentives
GROUP BY month_key
ORDER BY month_key DESC;

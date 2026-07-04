// ============================================================
// PETCHA 改修①: モニター用「贈る専用無料券」バッチ発行スクリプト
//
// 使い方（ローカル実行。Vercelにはデプロイされない）:
//   SUPABASE_URL=https://majunwobgxvdckyyunxu.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=sb_secret_... \
//   node scripts/issue-monitor-gifts.mjs monitors.csv [--dry-run]
//
//   PowerShellの場合:
//     $env:SUPABASE_URL = "https://majunwobgxvdckyyunxu.supabase.co"
//     $env:SUPABASE_SERVICE_ROLE_KEY = "sb_secret_..."
//     node scripts/issue-monitor-gifts.mjs monitors.csv --dry-run
//
// CSV形式: 1列目が LINE userId（U + 32桁hex）。ヘッダー行・空行・重複は自動スキップ。
//
// 動作:
//   - 各userIdに gift_type='monitor_free' のギフト券を1枚INSERT（credits=1）
//   - 有効期限は発行から MONITOR_EXPIRY_DAYS 日（下の定数。仮置き30日・要CEO最終確認）
//   - 1人1枚は部分ユニークインデックス pecha_gifts_monitor_one_per_sender が担保。
//     既に発行済みのuserIdは 23505 を検知してスキップ（再実行しても安全＝冪等）
//   - 発行後、モニターは通常ログインするだけでマイページの「贈ったガチャ券」一覧に
//     リンクが表示される（既存UIをそのまま利用。フロント改修不要）
// ============================================================

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const MONITOR_EXPIRY_DAYS = 30;   // 仮置き（要CEO最終確認）。変更はこの1箇所のみ

const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/i;

function usageExit(msg) {
  if (msg) console.error('エラー: ' + msg);
  console.error('使い方: node scripts/issue-monitor-gifts.mjs <CSVファイル> [--dry-run]');
  process.exit(1);
}

// フロントの randomToken()（petcha.html）と同系の形式。サーバー発行分は 'm' を挟んで識別可能に
function monitorToken() {
  return 'g' + Date.now().toString(36) + 'm' + randomBytes(5).toString('hex');
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const csvPath = args.find(a => !a.startsWith('--'));
if (!csvPath) usageExit('CSVファイルを指定してください');

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  usageExit('環境変数 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY を設定してください');
}

// --- CSV読み込み（1列目=LINE userId。ヘッダー/空行/形式不正/重複を除外） ---
let raw;
try { raw = readFileSync(csvPath, 'utf8'); }
catch (e) { usageExit('CSVを読めません: ' + e.message); }

const seen = new Set();
const userIds = [];
const rejected = [];
for (const line of raw.split(/\r?\n/)) {
  const first = line.split(',')[0].trim().replace(/^"|"$/g, '');
  if (!first) continue;
  if (!LINE_USER_ID_RE.test(first)) { rejected.push(first); continue; }  // ヘッダー行もここで除外
  if (seen.has(first)) continue;
  seen.add(first);
  userIds.push(first);
}

console.log(`CSV: 有効userId ${userIds.length}件 / 形式不正・ヘッダー ${rejected.length}行 をスキップ`);
if (rejected.length) console.log('  スキップ例:', rejected.slice(0, 3).join(' | '));
if (!userIds.length) usageExit('発行対象がありません');
if (dryRun) {
  console.log('[dry-run] 発行は行いません。対象一覧:');
  userIds.forEach(u => console.log('  ' + u));
  process.exit(0);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const expiresAt = new Date(Date.now() + MONITOR_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

let issued = 0, skipped = 0, failed = 0;
for (const userId of userIds) {
  const row = {
    token: monitorToken(),
    sender_line_user_id: userId,
    credits: 1,
    gift_type: 'monitor_free',
    expires_at: expiresAt
  };
  const { error } = await supabase.from('pecha_gifts').insert(row);
  if (!error) {
    issued++;
    console.log(`発行: ${userId} → token=${row.token}`);
  } else if (error.code === '23505') {
    skipped++;
    console.log(`スキップ（発行済み）: ${userId}`);
  } else {
    failed++;
    console.error(`失敗: ${userId} → ${error.code || ''} ${error.message}`);
  }
}

console.log('----------------------------------------');
console.log(`完了: 発行 ${issued} / 発行済みスキップ ${skipped} / 失敗 ${failed}`);
console.log(`有効期限: ${expiresAt}（発行から${MONITOR_EXPIRY_DAYS}日）`);
if (failed) process.exit(1);

# 锁定月报快照目录
#
# 锁定报告由 src/lib/reports.js 的 buildLockedReport() 生成，
# 含证据截止日期、波次、记录数与 SHA-256 指纹。
# 生成快照落盘示例（Node）：
#
#   import { writeFileSync } from 'node:fs';
#   import { buildLockedReport } from '../../src/lib/reports.js';
#   const snapshot = buildLockedReport(raw, design);
#   writeFileSync('data/reports/2026-10-lock-v1.json', JSON.stringify(snapshot, null, 2));
#
# 页面"月报证据版本"区直接对照锁定版与当前版的指纹和估计值。

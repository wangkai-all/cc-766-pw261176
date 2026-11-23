// 导出月报快照到 data/reports/：
//   node scripts/export-reports.mjs
//
// 锁定版（v1 证据，不可变）与当前版（含 v2 补录）各写一份 JSON，
// 另写一份全量分析结果 analysis.json 供离线核查。

import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from '../src/lib/pipeline.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'data');

const result = await runPipeline(dataDir, { nBoot: 400 });

const { lockedOctober, currentOctober } = result.reports;
writeFileSync(
  join(dataDir, 'reports', `${lockedOctober.reportVersion}.json`),
  JSON.stringify(lockedOctober, null, 2) + '\n'
);
writeFileSync(
  join(dataDir, 'reports', '2026-10-current.json'),
  JSON.stringify(currentOctober, null, 2) + '\n'
);
writeFileSync(join(dataDir, 'reports', 'analysis.json'), JSON.stringify(result, null, 2) + '\n');

// 控制台摘要
const f = (x) => (x === null || x === undefined ? '—' : (100 * x).toFixed(2) + '%');
console.log('锁定月报', lockedOctober.reportVersion);
console.log('  证据波次', lockedOctober.evidence.waves.join(','), '| 复查', lockedOctober.evidence.reviewCount, '| 指纹', lockedOctober.evidence.reviewsFingerprint);
console.log('  当月纠正缺陷率', f(lockedOctober.estimate.corrected));
console.log('当前视图（含 v2）');
console.log('  证据波次', currentOctober.evidence.waves.join(','), '| 复查', currentOctober.evidence.reviewCount, '| 指纹', currentOctober.evidence.reviewsFingerprint);
console.log('  当月纠正缺陷率', f(currentOctober.estimate.corrected));
console.log('总体纠正缺陷率', f(result.estimate.overall.corrected), 'CI', result.estimate.overall.ci.map((x) => f(x)).join(' ~ '));
console.log('输出: data/reports/{2026-10-lock-v1,2026-10-current,analysis}.json');

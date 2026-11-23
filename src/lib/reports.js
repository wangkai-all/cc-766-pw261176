// 月报快照与证据版本锁定
//
// 规则：
//  - 月报在月末锁定后不可变；锁定时记录证据清单（用到的复查记录、共识/仲裁样本、
//    测量模型来源与参数、数据文件指纹）。
//  - 后续补录（v2）到达后，"当前估计"会吸收新证据并更新，但锁定月报仍按原证据复算，
//    任何代码路径都无法用新证据改写历史版本。
//  - 快照是纯函数：同一证据输入 + 同一模型参数 → 同一结果，便于审计复现。

import { createHash } from 'node:crypto';
import { buildLedger } from './dataio.js';
import { buildMeasurementModel } from './misclassification.js';
import { estimateAll } from './estimator.js';
import { LOCKED_MONTH, LOCKED_REPORT_VERSION } from './config.js';

export function fingerprint(rows) {
  const h = createHash('sha256');
  h.update(rows.map((r) => JSON.stringify(r)).join('\n'));
  return h.digest('hex').slice(0, 16);
}

// 按证据截止日期过滤复查记录（shipment 框架本身不变，变的是复查证据）
function filterEvidence(raw, cutoffDate) {
  const reviews = raw.reviews.filter((r) => r.reviewDate <= cutoffDate);
  const reviewedIds = new Set(reviews.map((r) => r.unitId));
  const consensus = raw.consensus.filter((c) => reviewedIds.has(c.unitId));
  const gold = raw.gold.filter((g) => reviewedIds.has(g.unitId));
  return { reviews, consensus, gold };
}

// 生成某证据时点下的月报快照
export function snapshotAt(raw, design, cutoffDate, month, opts = {}) {
  const evidence = filterEvidence(raw, cutoffDate);
  const ledger = buildLedger({
    units: raw.units,
    reviews: evidence.reviews,
    consensus: evidence.consensus,
    gold: evidence.gold,
    design,
  });
  const model =
    opts.modelOverride ??
    buildMeasurementModel({
      consensus: ledger.consensus,
      gold: ledger.gold,
      override: opts.assumptionOverride ?? null,
    });
  const all = estimateAll(ledger, { model, nBoot: opts.nBoot ?? 300 });

  const monthEst = all.months.find((m) => m.month === month);
  const monthBatches = all.batches.filter((b) => b.month === month);
  const monthLines = all.lines
    .map((l) => {
      // 产线在该月的批次汇总
      const bs = monthBatches.filter((b) => b.lineId === l.lineId);
      return { lineId: l.lineId, batches: bs.map((b) => b.batchId) };
    })
    .filter((x) => x.batches.length);

  return {
    schemaVersion: 1,
    reportVersion: opts.reportVersion ?? null,
    month,
    locked: opts.locked ?? false,
    evidenceCutoff: cutoffDate,
    generatedAt: opts.generatedAt ?? cutoffDate,
    evidence: {
      reviewCount: evidence.reviews.length,
      consensusCount: evidence.consensus.length,
      goldCount: evidence.gold.length,
      reviewsFingerprint: fingerprint(evidence.reviews),
      consensusFingerprint: fingerprint(evidence.consensus),
      goldFingerprint: fingerprint(evidence.gold),
      waves: [...new Set(evidence.reviews.map((r) => r.wave))].sort(),
    },
    measurement: {
      source: model.source,
      sensitivity: model.sensitivity,
      specificity: model.specificity,
      identifiable: model.identifiable,
      seInterval: model.seInterval,
      spInterval: model.spInterval,
    },
    estimate: monthEst,
    lineBatches: monthLines,
    batches: monthBatches,
    coverage: all.coverage.filter((c) => c.month === month),
  };
}

// 锁定版 2026-10：证据截止 2026-10-31，只有 v1；v2（11-20 到达）被排除在外
export function buildLockedReport(raw, design) {
  return snapshotAt(raw, design, '2026-10-31', LOCKED_MONTH, {
    reportVersion: LOCKED_REPORT_VERSION,
    locked: true,
    generatedAt: '2026-10-31T23:59:00',
  });
}

// 当前版 2026-10：吸收全部证据（含 v2 补录），标注为未锁定的更新版
export function buildCurrentMonthView(raw, design, month, opts = {}) {
  return snapshotAt(raw, design, '2026-11-24', month, {
    reportVersion: opts.reportVersion ?? `${month}-current`,
    locked: false,
    generatedAt: '2026-11-24',
    assumptionOverride: opts.assumptionOverride ?? null,
  });
}

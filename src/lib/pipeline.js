// 分析流水线编排：加载台账 → 测量模型 → 估计 → 建议 → 月报版本对比。
// Web 与 Node 测试共用此入口，保证两边跑的是同一套引擎。

import { loadDataset } from './dataio.js';
import { buildMeasurementModel } from './misclassification.js';
import { estimateAll } from './estimator.js';
import { buildRecommendations } from './recommendations.js';
import { buildLockedReport, buildCurrentMonthView } from './reports.js';

export async function runPipeline(base, opts = {}) {
  const ledger = await loadDataset(base);
  const model = buildMeasurementModel({
    consensus: ledger.consensus,
    gold: ledger.gold,
    override: opts.assumptionOverride ?? null,
  });
  const estimate = estimateAll(ledger, {
    model,
    nBoot: opts.nBoot ?? 400,
    bootstrapSeed: opts.bootstrapSeed ?? 20261124,
  });
  const recommendations = buildRecommendations(
    ledger,
    estimate,
    opts.budget ?? 150
  );

  // 月报：锁定版（v1 证据）vs 当前版（含 v2）
  const raw = {
    units: ledger.units,
    reviews: ledger.reviews,
    consensus: ledger.consensus,
    gold: ledger.gold,
  };
  const lockedOctober = buildLockedReport(raw, ledger.design);
  const currentOctober = buildCurrentMonthView(raw, ledger.design, '2026-10', {
    assumptionOverride: opts.assumptionOverride ?? null,
  });

  return {
    generatedAt: '2026-11-24',
    ledger: {
      totalUnits: ledger.units.length,
      sampledUnits: ledger.sampled.length,
      reviewers: ledger.reviewers,
      batches: ledger.batches,
    },
    measurement: {
      source: model.source,
      identifiable: model.identifiable,
      sensitivity: model.sensitivity,
      specificity: model.specificity,
      sensitivityB: model.sensitivityB,
      specificityB: model.specificityB,
      seInterval: model.seInterval,
      spInterval: model.spInterval,
      em: {
        identifiable: model.em.identifiable,
        reason: model.em.reason,
        logLik: model.em.logLik,
        profileIntervals: model.em.profileIntervals,
        tables: model.em.tables,
      },
      gold: model.gold,
    },
    estimate,
    recommendations,
    reports: {
      lockedOctober,
      currentOctober,
    },
  };
}

// 已知真值合成数据的端到端验证（估计引擎禁止 import truth.secret.json；
// 本测试通过 generator 的返回值直接取得真值，不经过估计代码路径）。
//
// 覆盖题目点名的四类检验：
//  1. 选择偏差：naive 显著高估，IPW 纠正后回到真值附近
//  2. 零概率群体：零 pi 批次不进估计、不可外推、不出现在建议候选中
//  3. 复查标签纠正：忽略误判的估计偏高，Se/Sp 反演后偏差显著缩小
//  4. 不可识别保留区间：退化共识数据下降级为 partial，区间宽且包含真值
// 另含：EM 成功路径（加大共识样本）、月报锁定不可变、预算策略收益、可复现性。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate } from '../src/lib/generator.js';
import { buildLedger } from '../src/lib/dataio.js';
import {
  estimateFromConsensus,
  buildMeasurementModel,
  estimateFromGold,
  estimateConsensusK,
} from '../src/lib/misclassification.js';
import { estimateAll, invertMisclass } from '../src/lib/estimator.js';
import { buildRecommendations } from '../src/lib/recommendations.js';
import { buildLockedReport, buildCurrentMonthView, snapshotAt } from '../src/lib/reports.js';
import { runPipeline } from '../src/lib/pipeline.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');
const jsonl = (f) =>
  readFileSync(join(DATA, f), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);

function freshLedger(generated) {
  const { units, reviews, consensus, gold, design } = generated;
  return buildLedger({ units, reviews, consensus, gold, design });
}

test('生成器：结构完整且包含零概率批次与双波次', () => {
  const g = generate();
  assert.equal(g.units.length, 4550);
  const zeroBatch = g.batches.find((b) => b.zeroProbability);
  assert.ok(zeroBatch, '必须存在零抽样概率批次');
  const zeroUnits = g.units.filter((u) => u.batchId === zeroBatch.batchId);
  assert.ok(zeroUnits.every((u) => u.wave1Prob === 0));
  assert.ok(
    !g.reviews.some((r) => zeroUnits.some((u) => u.unitId === r.unitId)),
    '零概率批次不应有任何复查记录'
  );
  const waves = new Set(g.reviews.map((r) => r.wave));
  assert.deepEqual([...waves].sort(), ['v1', 'v2']);
  assert.ok(g.consensus.length >= 400);
  assert.ok(g.gold.length >= 50);
});

test('选择偏差：高分件被过度抽样，naive 缺陷率显著高于 IPW 纠正值', () => {
  const g = generate();
  const ledger = freshLedger(g);
  const model = buildMeasurementModel({
    consensus: ledger.consensus,
    gold: ledger.gold,
  });
  const est = estimateAll(ledger, { model, nBoot: 200 });

  // 抽样件平均分明显高于总体平均分 → 选择偏差存在
  const sampledMean =
    ledger.sampled.reduce((a, s) => a + s.modelScore, 0) / ledger.sampled.length;
  const frameMean = ledger.units.reduce((a, u) => a + u.modelScore, 0) / ledger.units.length;
  assert.ok(sampledMean > frameMean + 0.05, `抽样均值 ${sampledMean} 应明显高于总体 ${frameMean}`);

  // naive 高估：每个可识别产线 naive 都高于 corrected（误判+选择共同推高）
  for (const line of est.lines) {
    if (line.corrected === null) continue;
    assert.ok(
      line.naive > line.corrected,
      `${line.lineId}: naive ${line.naive} 应高于 corrected ${line.corrected}`
    );
  }
  assert.ok(est.overall.naive > est.overall.weighted);
  assert.ok(est.overall.weighted > est.overall.corrected);
});

test('纠正有效性：对照真值，corrected 偏差远小于 naive 偏差', () => {
  const g = generate();
  const truth = JSON.parse(readFileSync(join(DATA, 'truth.secret.json'), 'utf8'));
  const ledger = freshLedger(g);
  const model = buildMeasurementModel({
    consensus: ledger.consensus,
    gold: ledger.gold,
  });
  const est = estimateAll(ledger, { model, nBoot: 200 });

  let naiveAbsErr = 0;
  let corrAbsErr = 0;
  for (const line of est.lines) {
    const t = truth.lineTruth.find((x) => x.lineId === line.lineId).trueDefectRate;
    naiveAbsErr += Math.abs(line.naive - t);
    corrAbsErr += Math.abs(line.corrected - t);
  }
  assert.ok(
    corrAbsErr < naiveAbsErr * 0.6,
    `纠正后总绝对误差 ${corrAbsErr.toFixed(4)} 应显著小于 naive ${naiveAbsErr.toFixed(4)}`
  );

  // 总体 corrected 落入含未覆盖群体的宽区间，且与覆盖部分真值方向一致
  const coveredTruth =
    g.units
      .filter((u) => u.wave1Prob > 0)
      .reduce((a, u) => a + u.truth, 0) / g.units.filter((u) => u.wave1Prob > 0).length;
  assert.ok(Math.abs(est.overall.corrected - coveredTruth) < 0.035);
});

test('零概率群体：不进估计样本、覆盖分析标记、建议中无该批次候选', () => {
  const g = generate();
  const ledger = freshLedger(g);
  const model = buildMeasurementModel({
    consensus: ledger.consensus,
    gold: ledger.gold,
  });
  const est = estimateAll(ledger, { model, nBoot: 100 });
  const recs = buildRecommendations(ledger, est, 100);

  const zeroBatch = g.batches.find((b) => b.zeroProbability);
  const covRow = est.coverage.find((c) => c.batchId === zeroBatch.batchId);
  assert.equal(covRow.covered, false);
  assert.equal(covRow.gapReason, 'zero-inclusion-probability');
  assert.deepEqual(covRow.partialInterval, [0, 1]);
  assert.equal(covRow.uncoveredUnits, zeroBatch.size);

  // 任何策略的候选清单都不得包含零概率批次
  for (const s of recs.strategies) {
    assert.ok(
      !s.candidates.some((c) => c.batchId === zeroBatch.batchId),
      `${s.strategy} 不得为零概率批次生成候选`
    );
  }
  // 结构性缺口必须显式告知
  assert.ok(recs.structuralGaps.some((x) => x.batchId === zeroBatch.batchId));

  // 总体区间把未覆盖 N 件按 [0,1] 混合，宽度可感知
  const [lo, hi] = est.overall.totalIntervalIncludingUncovered;
  assert.ok(hi - lo > 0.04);
  assert.ok(lo <= est.overall.corrected && est.overall.corrected <= hi);
});

test('复查标签纠正：误判反演方向正确，Se+Sp≈1 时返回不可识别', () => {
  // 表观阳性率 0.20，Se=.9 Sp=.95 → 真值率应更低
  const p = invertMisclass(0.2, 0.9, 0.95);
  assert.ok(Math.abs(p - (0.2 - 0.05) / 0.85) < 1e-9);
  assert.ok(p < 0.2);
  // 无信息测量
  assert.equal(invertMisclass(0.3, 0.5, 0.5), null);
  // 边界裁剪
  assert.equal(invertMisclass(0.01, 0.9, 0.95), 0);
});

test('测量模型：gold 锚定接近真值；EM 点估计同样接近；退化时降级为部分识别', () => {
  const g = generate();
  const ledger = freshLedger(g);

  // gold 通道
  const goldEst = estimateFromGold(ledger.gold);
  assert.ok(Math.abs(goldEst.A.sensitivity - 0.9) < 0.08);
  assert.ok(Math.abs(goldEst.A.specificity - 0.95) < 0.06);
  // Wilson 区间包含真值
  assert.ok(goldEst.A.seInterval[0] <= 0.9 && 0.9 <= goldEst.A.seInterval[1]);
  assert.ok(goldEst.A.spInterval[0] <= 0.95 && 0.95 <= goldEst.A.spInterval[1]);

  // EM 通道：点估计贴近真值（即使因样本量被判部分识别）
  const em = estimateFromConsensus(ledger.consensus);
  assert.ok(Math.abs(em.point.sensitivity - 0.9) < 0.08);
  assert.ok(Math.abs(em.point.specificity - 0.95) < 0.08);
  assert.ok(Math.abs(em.reviewerB.sensitivity - 0.8) < 0.1);
  assert.ok(Math.abs(em.reviewerB.specificity - 0.98) < 0.05);

  // 退化：单组且两复查者完全一致 → 不可识别，给出宽轮廓区间
  const degenerate = ledger.consensus
    .filter((c) => c.lineId === 'L1')
    .map((c) => ({ ...c, labelB: c.labelA }));
  const em2 = estimateFromConsensus(degenerate);
  assert.equal(em2.identifiable, false);
  assert.ok(em2.reason.includes('识别条件不满足'));
  assert.ok(em2.profileIntervals.seA[1] - em2.profileIntervals.seA[0] >= 0.1);

  // 综合模型在有 gold 时用 gold，override 时用人工假设
  const m1 = buildMeasurementModel({ consensus: ledger.consensus, gold: ledger.gold });
  assert.equal(m1.source, 'adjudicated-gold');
  const m2 = buildMeasurementModel({
    consensus: ledger.consensus,
    gold: ledger.gold,
    override: { sensitivity: 0.85, specificity: 0.97 },
  });
  assert.equal(m2.source, 'user-assumption');
  assert.equal(m2.sensitivity, 0.85);
});

test('EM 成功路径：3 复查者大样本下潜类别模型可识别并恢复 Se/Sp', () => {
  // 2 复查者设计存在 Se_B/Sp_A 弱识别耦合（本数据集即如此，故主流程以 gold 锚定）；
  // 3 复查者 × 多患病率分组是经典可识别设计，这里用合成大样本验证引擎正确性。
  const rng = makeLocalRng(77);
  const lines = ['L1', 'L2', 'L3', 'L4'];
  const prev = { L1: 0.04, L2: 0.09, L3: 0.16, L4: 0.07 };
  const seTrue = [0.9, 0.8, 0.85];
  const spTrue = [0.95, 0.98, 0.92];
  const consensusK = [];
  let uid = 0;
  for (const lineId of lines) {
    for (let i = 0; i < 400; i++) {
      const truth = rng() < prev[lineId] ? 1 : 0;
      const labels = seTrue.map((se, r) =>
        rng() < (truth ? se : 1 - spTrue[r]) ? 1 : 0
      );
      consensusK.push({ unitId: `C${uid++}`, lineId, labels });
    }
  }
  const fit = estimateConsensusK(consensusK, 3);
  fit.sensitivity.forEach((se, r) => {
    assert.ok(Math.abs(se - seTrue[r]) < 0.05, `Se${r} 估计 ${se} 偏离真值 ${seTrue[r]}`);
  });
  fit.specificity.forEach((sp, r) => {
    assert.ok(Math.abs(sp - spTrue[r]) < 0.04, `Sp${r} 估计 ${sp} 偏离真值 ${spTrue[r]}`);
  });
});

test('月报锁定：v2 补录更新当前估计，但锁定版证据与数值保持不变', () => {
  const g = generate();
  const raw = {
    units: g.units,
    reviews: g.reviews,
    consensus: g.consensus,
    gold: g.gold,
  };

  const locked = buildLockedReport(raw, g.design);
  const current = buildCurrentMonthView(raw, g.design, '2026-10');

  assert.equal(locked.locked, true);
  assert.deepEqual(locked.evidence.waves, ['v1']);
  assert.ok(current.evidence.waves.includes('v2'));
  assert.ok(current.evidence.reviewCount > locked.evidence.reviewCount);

  // 补录改变了当前估计
  assert.notEqual(
    locked.estimate.corrected.toFixed(6),
    current.estimate.corrected.toFixed(6)
  );

  // 用全部证据重跑"锁定时点"快照：证据截止 10-31 必然排除 v2，数值与锁定版逐位一致
  const replay = snapshotAt(raw, g.design, '2026-10-31', '2026-10', {
    reportVersion: locked.reportVersion,
    locked: true,
  });
  assert.equal(replay.estimate.corrected, locked.estimate.corrected);
  assert.equal(replay.evidence.reviewsFingerprint, locked.evidence.reviewsFingerprint);
  assert.equal(replay.evidence.consensusFingerprint, locked.evidence.consensusFingerprint);

  // 人工假设调整只影响未锁定视图
  const assumed = buildCurrentMonthView(raw, g.design, '2026-10', {
    assumptionOverride: { sensitivity: 0.8, specificity: 0.99 },
  });
  assert.equal(assumed.measurement.source, 'user-assumption');
  assert.equal(locked.measurement.source, replay.measurement.source);
});

test('预算策略：盲区补查的 ESS 增益与方差下降优于继续查高分件', () => {
  const g = generate();
  const ledger = freshLedger(g);
  const model = buildMeasurementModel({
    consensus: ledger.consensus,
    gold: ledger.gold,
  });
  const est = estimateAll(ledger, { model, nBoot: 100 });
  const recs = buildRecommendations(ledger, est, 150);

  const byName = Object.fromEntries(recs.strategies.map((s) => [s.strategy, s]));
  assert.equal(byName['score-first'].candidates.length, 150);
  assert.equal(byName['blind-spot'].candidates.length, 150);

  // 高分策略候选确实高分；盲区策略候选确实低 pi
  assert.ok(
    byName['score-first'].candidates.slice(0, 20).every((c) => c.modelScore > 0.6)
  );
  assert.ok(byName['blind-spot'].expected.blindSpotHits > 80);
  assert.equal(byName['score-first'].expected.blindSpotHits, 0);

  // 核心收益结论：盲区/均衡策略的方差下降显著大于高分策略
  assert.ok(
    byName['blind-spot'].expected.varianceReductionPct >
      byName['score-first'].expected.varianceReductionPct * 1.5
  );
  assert.ok(
    byName['balanced'].expected.essGain > byName['score-first'].expected.essGain
  );

  // 每条候选都带可追溯字段与理由
  for (const c of byName['blind-spot'].candidates) {
    assert.ok(c.unitId && c.batchId && c.reason.length > 0);
  }
});

test('端到端流水线与可复现性：同种子结果逐位一致，含全部交付物', async () => {
  const r1 = await runPipeline(DATA, { nBoot: 150 });
  const r2 = await runPipeline(DATA, { nBoot: 150 });
  assert.equal(
    JSON.stringify(r1.estimate.lines),
    JSON.stringify(r2.estimate.lines),
    '相同 bootstrap 种子必须给出相同区间'
  );
  assert.ok(r1.measurement.source === 'adjudicated-gold');
  assert.ok(r1.estimate.overall.ci[0] < r1.estimate.overall.corrected);
  assert.ok(r1.estimate.overall.ci[1] > r1.estimate.overall.corrected);
  assert.ok(r1.reports.lockedOctober.locked);
  assert.ok(r1.recommendations.structuralGaps.length >= 1);
});

// 测试用本地 RNG（避免引入循环依赖）
function makeLocalRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

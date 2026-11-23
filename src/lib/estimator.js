// 缺陷率估计器
//
// 纠正链条（两步缺一不可，顺序不能颠倒）：
//   原始标签率 →(IPW 逆抽样概率加权，纠正选择偏差)→ 表观阳性率 q
//   q →(Se/Sp 误判反演，迭代不动点)→ 真实缺陷率 p
// 只做其中一步都是错的：先把标签当真值再加权，漏掉误判；直接反演不加权，
// 高分缺陷件仍被过度代表。
//
// 三种口径同时输出，用于量化每一步纠正的贡献：
//   naive    复查件标签均值（既不纠选择也不纠误判）——展示原始偏差
//   weighted IPW 加权表观率（只纠选择偏差）
//   corrected 加权 + 误判反演（最终估计）
//
// 零抽样概率批次：不进加权估计，按部分识别单独给区间，绝不假装可外推。

import { makeRng } from './rng.js';

// 误判反演：q = Se*p + (1-Sp)*(1-p)  →  p = (q - (1-Sp)) / (Se + Sp - 1)
export function invertMisclass(q, se, sp) {
  const denom = se + sp - 1;
  if (Math.abs(denom) < 1e-6) return null; // 测量无信息（Se+Sp≈1），不可识别
  return Math.min(1, Math.max(0, (q - (1 - sp)) / denom));
}

// 给定样本集合与测量模型，计算各层级点估计
function pointEstimate(sampled, units, batches, model, groupKey = null, groupValue = null) {
  const inScope = groupKey ? sampled.filter((s) => s[groupKey] === groupValue) : sampled;
  const frame = groupKey ? units.filter((u) => u[groupKey] === groupValue) : units;

  // 口径 1：naive
  const n = inScope.length;
  const naive = n ? inScope.reduce((a, s) => a + s.label, 0) / n : null;

  // 口径 2：IPW 加权表观率（Hájek 比率估计）
  const wSum = inScope.reduce((a, s) => a + s.weight, 0);
  const wPos = inScope.reduce((a, s) => a + s.weight * s.label, 0);
  const weighted = wSum > 0 ? wPos / wSum : null;

  // 口径 3：误判反演（不动点；单点反演在此数据下即闭合，保留迭代结构便于扩展）
  let corrected = null;
  if (weighted !== null) {
    let p = invertMisclass(weighted, model.sensitivity, model.specificity);
    if (p === null) {
      corrected = null;
    } else {
      for (let i = 0; i < 25; i++) {
        const qExp =
          model.sensitivity * p + (1 - model.specificity) * (1 - p);
        const pNext = invertMisclass(qExp, model.sensitivity, model.specificity);
        if (pNext === null || Math.abs(pNext - p) < 1e-10) {
          p = pNext ?? p;
          break;
        }
        p = pNext;
      }
      corrected = p;
    }
  }

  return {
    n,
    frameSize: frame.length,
    wSum,
    naive,
    weighted,
    corrected,
  };
}

// 覆盖性分析：零概率/未实现样本批次的部分识别区间
function coverageAnalysis(units, batches, correctedLineRates) {
  const rows = batches.map((b) => {
    const members = units.filter((u) => u.batchId === b.batchId);
    const covered = b.covered;
    // 无抽样机会 → 缺陷率只能落在 [0,1]；若采用产线已覆盖部分的估计作软参照，
    // 仅作为"参照"展示，不并入总体点估计。
    const lineRef = correctedLineRates.get(b.lineId) ?? null;
    return {
      batchId: b.batchId,
      lineId: b.lineId,
      month: b.month,
      size: b.totalUnits,
      reviewedCount: b.reviewedCount,
      covered,
      gapReason: b.gapReason,
      lineReferenceRate: lineRef,
      partialInterval: covered ? null : [0, 1],
      // 对全月/全总体区间的贡献：未覆盖 N 件 × [0,1]
      uncoveredUnits: covered ? 0 : b.totalUnits,
    };
  });
  return rows;
}

// 加权 Bootstrap：对复查件做多项重抽样，重算三层口径；
// 测量模型默认固定（其不确定性由 Se/Sp 轮廓区间单独传播，见 sensitivityBand）。
function bootstrap(sampled, units, batches, model, nBoot, rng, groupKey, groupValue) {
  const inScope = groupKey ? sampled.filter((s) => s[groupKey] === groupValue) : sampled;
  if (inScope.length < 8) return null;
  const reps = [];
  const n = inScope.length;
  for (let b = 0; b < nBoot; b++) {
    const counts = new Array(n).fill(0);
    for (let i = 0; i < n; i++) counts[Math.floor(rng() * n)]++;
    const resampled = [];
    for (let i = 0; i < n; i++) {
      if (counts[i] > 0) {
        resampled.push({ ...inScope[i], weight: inScope[i].weight * counts[i] });
      }
    }
    const est = pointEstimate(resampled, units, batches, model);
    if (est.corrected !== null) reps.push(est);
  }
  if (reps.length < 20) return null;
  const pct = (arr, key, q) => {
    const v = arr.map((r) => r[key]).filter((x) => x !== null).sort((a, b) => a - b);
    if (!v.length) return null;
    const idx = Math.min(v.length - 1, Math.max(0, Math.floor(q * (v.length - 1))));
    return v[idx];
  };
  return {
    corrected: [pct(reps, 'corrected', 0.025), pct(reps, 'corrected', 0.975)],
    weighted: [pct(reps, 'weighted', 0.025), pct(reps, 'weighted', 0.975)],
    naive: [pct(reps, 'naive', 0.025), pct(reps, 'naive', 0.975)],
    replicates: reps.length,
  };
}

// 测量不确定性传播：在 Se/Sp 的区间端点上重算 corrected，给出带状区间
function sensitivityBand(weightedRate, model) {
  if (weightedRate === null || !model.seInterval || !model.spInterval) return null;
  const corners = [
    [model.seInterval[0], model.spInterval[0]],
    [model.seInterval[0], model.spInterval[1]],
    [model.seInterval[1], model.spInterval[0]],
    [model.seInterval[1], model.spInterval[1]],
  ];
  const vals = corners
    .map(([se, sp]) => invertMisclass(weightedRate, se, sp))
    .filter((x) => x !== null);
  if (!vals.length) return null;
  return [Math.min(...vals), Math.max(...vals)];
}

export function estimateAll(ledger, opts = {}) {
  const { units, sampled, batches } = ledger;
  const model = opts.model; // 必须由 buildMeasurementModel 给出
  const nBoot = opts.nBoot ?? 400;
  const rng = makeRng(opts.bootstrapSeed ?? 20261124);

  const lineIds = [...new Set(units.map((u) => u.lineId))].sort();
  const months = [...new Set(units.map((u) => u.month))].sort();

  // 产线级
  const lineResults = lineIds.map((lineId) => {
    const point = pointEstimate(sampled, units, batches, model, 'lineId', lineId);
    const ci = bootstrap(sampled, units, batches, model, nBoot, rng, 'lineId', lineId);
    const band = sensitivityBand(point.weighted, model);
    return {
      lineId,
      ...point,
      ci: ci?.corrected ?? null,
      band,
    };
  });
  const lineMap = new Map(lineResults.map((r) => [r.lineId, r.corrected]));

  // 批次级（逐批追溯）
  const batchResults = batches.map((b) => {
    const point = pointEstimate(sampled, units, batches, model, 'batchId', b.batchId);
    const ci = bootstrap(sampled, units, batches, model, Math.min(nBoot, 200), rng, 'batchId', b.batchId);
    return {
      batchId: b.batchId,
      lineId: b.lineId,
      month: b.month,
      covered: b.covered,
      gapReason: b.gapReason,
      totalUnits: b.totalUnits,
      ...point,
      ci: ci?.corrected ?? null,
      band: sensitivityBand(point.weighted, model),
    };
  });

  // 月度级
  const monthResults = months.map((month) => {
    const point = pointEstimate(sampled, units, batches, model, 'month', month);
    const ci = bootstrap(sampled, units, batches, model, nBoot, rng, 'month', month);
    return { month, ...point, ci: ci?.corrected ?? null, band: sensitivityBand(point.weighted, model) };
  });

  // 总体（仅覆盖部分）
  const overallPoint = pointEstimate(sampled, units, batches, model);
  const overallCi = bootstrap(sampled, units, batches, model, nBoot, rng, null, null);

  // 覆盖性与部分识别
  const coverage = coverageAnalysis(units, batches, lineMap);
  const uncoveredUnits = coverage.reduce((a, c) => a + c.uncoveredUnits, 0);
  const totalUnits = units.length;
  const coveredUnits = totalUnits - uncoveredUnits;

  // 总体区间：覆盖部分用 bootstrap CI；未覆盖部分按 [0,1] 混合得到宽区间
  let totalInterval = null;
  if (overallCi) {
    const [loC, hiC] = overallCi.corrected;
    const lo = (loC * coveredUnits + 0 * uncoveredUnits) / totalUnits;
    const hi = (hiC * coveredUnits + 1 * uncoveredUnits) / totalUnits;
    totalInterval = [lo, hi];
  }

  // 产线差异（可识别产线之间）
  const identifiableLines = lineResults.filter((r) => r.corrected !== null);
  let lineContrast = null;
  if (identifiableLines.length >= 2) {
    const sorted = [...identifiableLines].sort((a, b) => a.corrected - b.corrected);
    const low = sorted[0];
    const high = sorted[sorted.length - 1];
    lineContrast = {
      lowLine: low.lineId,
      highLine: high.lineId,
      difference: high.corrected - low.corrected,
      ratio: low.corrected > 0 ? high.corrected / low.corrected : null,
      ci:
        high.ci && low.ci
          ? [high.ci[0] - low.ci[1], high.ci[1] - low.ci[0]]
          : null,
    };
  }

  return {
    model,
    overall: {
      ...overallPoint,
      ci: overallCi?.corrected ?? null,
      band: sensitivityBand(overallPoint.weighted, model),
      totalIntervalIncludingUncovered: totalInterval,
      coveredUnits,
      uncoveredUnits,
      coverageRate: coveredUnits / totalUnits,
    },
    lines: lineResults,
    batches: batchResults,
    months: monthResults,
    coverage,
    lineContrast,
    nBoot,
  };
}

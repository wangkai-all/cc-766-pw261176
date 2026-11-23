// 抽检建议：固定预算下的候选清单与预期收益对比
//
// 所有建议都绑定具体候选单元清单（unitId + 选择理由），不输出无法落地的空建议。
// 三种预算策略用同一笔预算 B 比较：
//   score-first  继续多查高分件（现状倾向）
//   blind-spot   补查低概率盲区（逆概率加权优先）
//   balanced     兼顾盲区与零覆盖批次的混合策略
//
// 预期收益用"有效样本量 ESS = (Σw)²/Σw²"与加权方差的预期下降衡量；
// 缺陷概率先验用产线 corrected 率 × 分数校准的逻辑回归式收缩，
// 保证期望方差可在不读取真值的前提下计算。

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

// 用已复查样本拟合 score → 表观阳性 的单参数逻辑模型（无外部依赖的 IRLS 简化版）
function fitScoreModel(sampled) {
  // 粗网格 + 解析截距：对斜率做一维搜索，截距用加权阳性率匹配
  let best = { a: 0, b: 0, loss: Infinity };
  const wSum = sampled.reduce((s, x) => s + x.weight, 0);
  const wMean = wSum / sampled.length;
  const yBar = sampled.reduce((s, x) => s + (x.weight * x.label) / wSum, 0);
  for (let b = 0; b <= 4.0001; b += 0.25) {
    // 截距 a 使加权平均预测 ≈ yBar（不动点迭代）
    let a = Math.log(Math.max(yBar, 1e-4) / Math.max(1 - yBar, 1e-4));
    for (let it = 0; it < 30; it++) {
      const predMean = sampled.reduce((s, x) => s + (x.weight / wSum) * sigmoid(a + b * (x.modelScore - 0.5)), 0);
      const aNext = a + (yBar - predMean) * 2;
      if (Math.abs(aNext - a) < 1e-7) {
        a = aNext;
        break;
      }
      a = aNext;
    }
    const loss = sampled.reduce((s, x) => {
      const p = sigmoid(a + b * (x.modelScore - 0.5));
      return s + (x.weight / wMean) * (x.label === 1 ? -Math.log(p + 1e-9) : -Math.log(1 - p + 1e-9));
    }, 0);
    if (loss < best.loss) best = { a, b, loss };
  }
  return {
    predict: (score) => sigmoid(best.a + best.b * (score - 0.5)),
  };
}

function ess(weights) {
  const s1 = weights.reduce((a, b) => a + b, 0);
  const s2 = weights.reduce((a, b) => a + b * b, 0);
  return s2 > 0 ? (s1 * s1) / s2 : 0;
}

// 加权二项方差（Hájek），q 为表观阳性率
function weightedVariance(records) {
  const s1 = records.reduce((a, r) => a + r.weight, 0);
  if (s1 <= 0) return null;
  const q = records.reduce((a, r) => a + r.weight * r.label, 0) / s1;
  // 有限样本修正的 Hájek 方差
  const v = records.reduce((a, r) => a + r.weight * r.weight * (r.label - q) ** 2, 0);
  return v / (s1 * s1);
}

export function buildRecommendations(ledger, estimate, budget = 150) {
  const { units, sampled, batches } = ledger;
  const scoreModel = fitScoreModel(sampled);
  const lineRate = new Map(estimate.lines.map((l) => [l.lineId, l.corrected ?? l.weighted ?? 0.08]));

  // 可补查池：当前未复查，且设计上有抽样机会（pi1>0）
  const sampledIds = new Set(sampled.map((s) => s.unitId));
  const pool = units
    .filter((u) => !sampledIds.has(u.unitId) && u.wave1Prob > 0)
    .map((u) => {
      const baseP = scoreModel.predict(u.modelScore);
      // 与产线率做收缩融合，避免分数模型外推过度
      const pDefect = 0.5 * baseP + 0.5 * (lineRate.get(u.lineId) ?? 0.08);
      const currentWeight = 1 / Math.max(u.wave1Prob, 1e-4);
      return {
        unitId: u.unitId,
        batchId: u.batchId,
        lineId: u.lineId,
        month: u.month,
        modelScore: u.modelScore,
        wave1Prob: u.wave1Prob,
        pDefect,
        currentWeight,
        // 信息价值：高权重 × 不确定性（Bernoulli 方差 p(1-p)）
        information: currentWeight * pDefect * (1 - pDefect),
      };
    });

  const currentWeights = sampled.map((s) => s.weight);
  const currentEss = ess(currentWeights);
  const currentVar = weightedVariance(sampled);

  const batchById = new Map(batches.map((b) => [b.batchId, b]));

  function pickStrategy(name, scorer, note) {
    const ranked = pool
      .map((c) => ({ ...c, priority: scorer(c) }))
      .sort((a, b) => b.priority - a.priority);
    const chosen = ranked.slice(0, budget);

    // 预期：补查后这些单元以权重 1/pi1 进入估计（模拟期望标签 = pDefect）
    const augmented = sampled.concat(
      chosen.map((c) => ({
        unitId: c.unitId,
        lineId: c.lineId,
        batchId: c.batchId,
        month: c.month,
        weight: c.currentWeight,
        label: c.pDefect >= 0.5 ? 1 : 0,
      }))
    );
    const newEss = ess(augmented.map((r) => r.weight));
    const newVar = weightedVariance(augmented);

    // 盲区覆盖：选中单元里 pi1 处于低分位的占比
    const probs = pool.map((c) => c.wave1Prob).sort((a, b) => a - b);
    const q25 = probs[Math.floor(probs.length * 0.25)];
    const blindHits = chosen.filter((c) => c.wave1Prob <= q25).length;
    const zeroGapBatches = new Set(
      chosen
        .filter((c) => batchById.get(c.batchId)?.gapReason === 'no-realized-sample')
        .map((c) => c.batchId)
    );

    return {
      strategy: name,
      note,
      budget,
      candidates: chosen.map((c, i) => ({
        rank: i + 1,
        unitId: c.unitId,
        batchId: c.batchId,
        lineId: c.lineId,
        month: c.month,
        modelScore: c.modelScore,
        wave1Prob: c.wave1Prob,
        expectedDefectProb: Number(c.pDefect.toFixed(4)),
        priority: Number(c.priority.toFixed(4)),
        reason: reasonFor(name, c),
      })),
      expected: {
        essBefore: Number(currentEss.toFixed(1)),
        essAfter: Number(newEss.toFixed(1)),
        essGain: Number((newEss - currentEss).toFixed(1)),
        varianceBefore: currentVar,
        varianceAfter: newVar,
        varianceReductionPct:
          currentVar && newVar ? Number((100 * (1 - newVar / currentVar)).toFixed(2)) : null,
        blindSpotHits: blindHits,
        closesEmptyBatches: [...zeroGapBatches],
      },
    };
  }

  function reasonFor(name, c) {
    if (name === 'score-first')
      return `模型分数 ${c.modelScore.toFixed(2)} 处高分位，沿用现行高分优先策略`;
    if (name === 'blind-spot')
      return `设计概率仅 ${(c.wave1Prob * 100).toFixed(1)}%，逆概率权重 ${c.currentWeight.toFixed(1)}，属抽样盲区`;
    return c.wave1Prob < 0.12
      ? `盲区补查（pi=${(c.wave1Prob * 100).toFixed(1)}%）`
      : `分数 ${c.modelScore.toFixed(2)} 与盲区混合配置，平衡精度与覆盖`;
  }

  const strategies = [
    pickStrategy(
      'score-first',
      (c) => c.modelScore,
      '把预算继续投给高分件：精度提升有限，因为这些单元本来入选概率就高、权重低'
    ),
    pickStrategy(
      'blind-spot',
      (c) => c.information,
      '把预算投给低概率盲区：单位预算带来的 ESS 与方差改善最大'
    ),
    pickStrategy(
      'balanced',
      (c) =>
        c.information * 0.7 +
        c.modelScore * 0.2 +
        (batchById.get(c.batchId)?.gapReason === 'no-realized-sample' ? 0.5 : 0),
      '七成盲区、两成分数、额外奖励能消除零实现样本批次的候选'
    ),
  ];

  // 零概率批次：明确告知不可建议（没有抽样机会，任何候选清单都是伪造可外推性）
  const structuralGaps = batches
    .filter((b) => b.gapReason === 'zero-inclusion-probability')
    .map((b) => ({
      batchId: b.batchId,
      lineId: b.lineId,
      month: b.month,
      size: b.totalUnits,
      message: '该批次设计抽样概率为 0，无法通过追加复查获得信息；需先建立抽样机制（如全检/新设备抽检），在此之前其缺陷率保持 [0,1] 部分识别区间',
    }));

  return {
    budget,
    currentEss: Number(currentEss.toFixed(1)),
    currentVariance: currentVar,
    strategies,
    structuralGaps,
    scoreModelAucNote: '候选期望缺陷概率由分数-标签收缩模型给出，仅用于排序，不作为个体判定',
  };
}

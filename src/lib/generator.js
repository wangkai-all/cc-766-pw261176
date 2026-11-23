// 合成数据生成器：构建完整出货清单、带选择偏差的抽样台账、双复查者标签、
// 共同审查（一致性）样本与仲裁真值样本。
//
// 关键设计（对应题目要求）：
// 1. 抽样概率 pi 随模型分数升高而升高 → 复查偏向高分件，直接算缺陷率有偏；
// 2. 模型分数对真实缺陷有重叠分布 → 低分缺陷件成为盲区；
// 3. 批次 B-L4-10 的 pi 恒为 0 → 零概率群体，无法外推；
// 4. 两个复查者有不同灵敏度/特异度 → 复查标签不是绝对真值；
// 5. 共识样本无真值，仅靠 Hui-Walter EM 识别；仲裁样本提供第二条识别通道；
// 6. v2 补录波次补查盲区 + 少量高分件，用于更新估计（锁定月报不重算）。

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRng, makeGaussian, betaSample, clamp } from './rng.js';
import { LINES, MONTHS, REVIEWER_TRUTH, LOCKED_MONTH } from './config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', '..', 'data');

// 批次规模与抽样基线（pi=0 的批次是结构性盲区）
const BATCH_PLAN = {
  '2026-10': {
    L1: { size: 380, base: 0.28 },
    L2: { size: 420, base: 0.32 },
    L3: { size: 350, base: 0.36 },
    L4: { size: 300, base: 0.0 }, // 零抽样概率批次：没有任何复查机会
    L5: { size: 360, base: 0.38 },
    L6: { size: 400, base: 0.30 },
  },
  '2026-11': {
    L1: { size: 400, base: 0.26 },
    L2: { size: 440, base: 0.31 },
    L3: { size: 370, base: 0.34 },
    L4: { size: 320, base: 0.16 }, // 低概率盲区批次
    L5: { size: 390, base: 0.37 },
    L6: { size: 420, base: 0.29 },
  },
};

function noiselessScore(rng, defective) {
  // 缺陷件分数偏高但与非缺陷件显著重叠：分数不是真值
  return defective ? betaSample(rng, 5, 2.2) : betaSample(rng, 2.2, 5);
}

function reviewerLabel(rng, truth, reviewerId) {
  const { sensitivity, specificity } = REVIEWER_TRUTH[reviewerId];
  const p = truth === 1 ? sensitivity : 1 - specificity;
  return rng() < p ? 1 : 0;
}

// 按权重无放回抽取 n 个，返回 {ids, condProbs: Map(id -> 条件入选概率)}
function weightedSample(rng, pool, n, weightOf) {
  const remaining = pool.slice();
  const chosen = [];
  const condProbs = new Map();
  let take = Math.min(n, remaining.length);
  while (take-- > 0) {
    const weights = remaining.map(weightOf);
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rng() * total;
    let idx = 0;
    for (; idx < remaining.length; idx++) {
      r -= weights[idx];
      if (r <= 0) break;
    }
    idx = Math.min(idx, remaining.length - 1);
    const [id] = remaining.splice(idx, 1);
    // 该单元在本轮被抽中的条件概率（记录进台账，供 IPW 复算）
    condProbs.set(id, weights[idx] / total);
    chosen.push(id);
  }
  return { chosen, condProbs };
}

export function generate(seedText = 'pointwise-quality-v1') {
  const rng = makeRng(seedText);
  const gauss = makeGaussian(rng);

  const units = [];
  const batches = [];
  let seq = 0;

  // ---- 1. 总体框架 + 真值 + 模型分数 + 设计概率 ----
  for (const month of MONTHS) {
    for (const line of LINES) {
      const plan = BATCH_PLAN[month][line.lineId];
      const batchId = `B-${line.lineId}-${month.slice(5)}`;
      const batch = {
        batchId,
        lineId: line.lineId,
        month,
        size: plan.size,
        baseProb: plan.base,
        zeroProbability: plan.base === 0,
      };
      batches.push(batch);

      for (let i = 0; i < plan.size; i++) {
        const unitId = `U${String(++seq).padStart(5, '0')}`;
        const truth = rng() < line.trueDefectRate ? 1 : 0;
        const rawScore = noiselessScore(rng, truth);
        const score = clamp(rawScore + gauss() * 0.04, 0.001, 0.999);

        // 设计概率：批次基线 + 强分数驱动项 → 复查明显偏向高分件；
        // 下限 0.03 保证逆概率权重不超过 ~33，控制 Hájek 估计方差
        let pi1;
        if (plan.base === 0) {
          pi1 = 0;
        } else {
          pi1 = clamp(plan.base * (0.15 + 2.2 * score * score), 0.03, 0.9);
        }

        units.push({
          unitId,
          batchId,
          lineId: line.lineId,
          month,
          modelScore: Number(score.toFixed(4)),
          truth,
          wave1Prob: Number(pi1.toFixed(5)),
          wave2CondProb: 0,
          selectedWave1: false,
          selectedWave2: false,
        });
      }
    }
  }

  // ---- 2. v1 常规复查波次（伯努利抽样，高分件过度代表）----
  for (const u of units) {
    if (u.wave1Prob > 0 && rng() < u.wave1Prob) u.selectedWave1 = true;
  }

  // ---- 3. v2 补录波次（补查盲区 + 一组高分对照），仅从 v1 未中选单元抽取 ----
  const notInV1 = units.filter((u) => !u.selectedWave1 && u.wave1Prob > 0);
  const blindPool = notInV1.filter((u) => u.modelScore < 0.35);
  const highPool = notInV1.filter((u) => u.modelScore >= 0.7);

  // 3a. 11 月在产盲区补查（含低概率批次 L4）
  const novBlind = blindPool.filter((u) => u.month === '2026-11');
  // 3b. 10 月遗留盲区补查（锁定月报之后才到，不影响锁定版本）
  const octBlind = blindPool.filter((u) => u.month === LOCKED_MONTH);
  // 3c. 高分件对照（用于预算收益对比）
  const novHigh = highPool.filter((u) => u.month === '2026-11');

  const w2a = weightedSample(rng, novBlind.map((u) => u.unitId), 220, (id) => {
    const u = units.find((x) => x.unitId === id);
    return 1 / Math.max(u.wave1Prob, 0.01); // 逆概率加权：越难抽中越优先
  });
  const w2b = weightedSample(rng, octBlind.map((u) => u.unitId), 120, (id) => {
    const u = units.find((x) => x.unitId === id);
    return 1 / Math.max(u.wave1Prob, 0.01);
  });
  const w2c = weightedSample(rng, novHigh.map((u) => u.unitId), 90, (id) => {
    const u = units.find((x) => x.unitId === id);
    return u.modelScore; // 高分优先：模拟"继续多查高分件"的策略
  });

  for (const [id, p] of [...w2a.condProbs, ...w2b.condProbs, ...w2c.condProbs]) {
    const u = units.find((x) => x.unitId === id);
    u.selectedWave2 = true;
    u.wave2CondProb = Number(p.toFixed(5));
  }

  // ---- 4. 复查标签：主复查者 + 共同审查 + 仲裁 ----
  const reviews = [];
  const consensus = [];
  const gold = [];

  const reviewed = units.filter((u) => u.selectedWave1 || u.selectedWave2);

  // 共识样本：按产线/分数分层抽约 600 件，A、B 各自独立打标（无真值揭晓）
  const consensusPicked = new Set();
  for (const line of LINES) {
    const pool = reviewed.filter((u) => u.lineId === line.lineId);
    // 分层：低/中/高分，保证跨患病率与分数带的覆盖
    const strata = [
      pool.filter((u) => u.modelScore < 0.33),
      pool.filter((u) => u.modelScore >= 0.33 && u.modelScore < 0.66),
      pool.filter((u) => u.modelScore >= 0.66),
    ];
    for (const stratum of strata) {
      const take = Math.min(34, stratum.length);
      const ids = stratum.map((u) => u.unitId);
      const { chosen } = weightedSample(rng, ids, take, () => 1);
      for (const id of chosen) consensusPicked.add(id);
    }
  }

  // 仲裁样本：120 件（60 缺陷/60 非缺陷，按真值分层——模拟工程破坏性确认）
  const goldDefPool = reviewed.filter((u) => u.truth === 1 && !consensusPicked.has(u.unitId));
  const goldOkPool = reviewed.filter((u) => u.truth === 0 && !consensusPicked.has(u.unitId));
  const g1 = weightedSample(rng, goldDefPool.map((u) => u.unitId), 60, () => 1).chosen;
  const g0 = weightedSample(rng, goldOkPool.map((u) => u.unitId), 60, () => 1).chosen;
  const goldPicked = new Set([...g1, ...g0]);

  for (const u of reviewed) {
    const wave = u.selectedWave1 ? 'v1' : 'v2';
    const reviewDate =
      wave === 'v1'
        ? u.month === '2026-10'
          ? '2026-10-28'
          : '2026-11-18'
        : '2026-11-20';
    const primary = u.month === '2026-10' ? 'A' : 'A'; // 主复查者统一为 A

    if (consensusPicked.has(u.unitId)) {
      const labelA = reviewerLabel(rng, u.truth, 'A');
      const labelB = reviewerLabel(rng, u.truth, 'B');
      reviews.push({ unitId: u.unitId, reviewerId: 'A', label: labelA, wave, reviewDate });
      reviews.push({ unitId: u.unitId, reviewerId: 'B', label: labelB, wave, reviewDate });
      consensus.push({ unitId: u.unitId, lineId: u.lineId, labelA, labelB });
    } else if (goldPicked.has(u.unitId)) {
      const labelA = reviewerLabel(rng, u.truth, 'A');
      const labelB = reviewerLabel(rng, u.truth, 'B');
      reviews.push({ unitId: u.unitId, reviewerId: 'A', label: labelA, wave, reviewDate });
      reviews.push({ unitId: u.unitId, reviewerId: 'B', label: labelB, wave, reviewDate });
      gold.push({ unitId: u.unitId, lineId: u.lineId, labelA, labelB, truth: u.truth });
    } else {
      reviews.push({
        unitId: u.unitId,
        reviewerId: primary,
        label: reviewerLabel(rng, u.truth, primary),
        wave,
        reviewDate,
      });
    }
  }

  // ---- 5. 落盘（估计端可见文件；truth 单独存放并标注"禁止估计代码读取"）----
  mkdirSync(DATA_DIR, { recursive: true });
  const writeJsonl = (name, rows) =>
    writeFileSync(join(DATA_DIR, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const shipment = units.map((u) => ({
    unitId: u.unitId,
    batchId: u.batchId,
    lineId: u.lineId,
    month: u.month,
    modelScore: u.modelScore,
    wave1Prob: u.wave1Prob,
    wave2CondProb: u.wave2CondProb,
  }));
  writeJsonl('shipment.jsonl', shipment);
  writeJsonl('reviews.jsonl', reviews);
  writeJsonl('consensus.jsonl', consensus);
  writeJsonl('gold.jsonl', gold);

  const design = {
    seed: seedText,
    generatedAt: '2026-11-24',
    months: MONTHS,
    lines: LINES.map(({ lineId, name }) => ({ lineId, name })),
    batches,
    waves: [
      { wave: 'v1', name: '常规复查', mechanism: 'Bernoulli(inclusionProb)', date: '月末' },
      {
        wave: 'v2',
        name: '补录复查',
        mechanism: '条件加权抽样（v1 未中选总体；盲区逆概率 / 高分对照）',
        date: '2026-11-20',
      },
    ],
    counts: {
      units: units.length,
      reviewed: reviewed.length,
      wave1: units.filter((u) => u.selectedWave1).length,
      wave2: units.filter((u) => u.selectedWave2).length,
      consensus: consensus.length,
      gold: gold.length,
      zeroProbBatches: batches.filter((b) => b.zeroProbability).map((b) => b.batchId),
    },
  };
  writeFileSync(join(DATA_DIR, 'design.json'), JSON.stringify(design, null, 2) + '\n');

  // 仅测试用真值
  const secret = {
    warning: 'ESTIMATOR CODE MUST NOT READ THIS FILE. Validation-only ground truth.',
    reviewerTruth: REVIEWER_TRUTH,
    lineTruth: LINES.map((l) => ({ lineId: l.lineId, trueDefectRate: l.trueDefectRate })),
    units: units.map((u) => ({ unitId: u.unitId, truth: u.truth })),
  };
  writeFileSync(join(DATA_DIR, 'truth.secret.json'), JSON.stringify(secret, null, 2) + '\n');

  return { units, reviews, consensus, gold, batches, design };
}

// 直接执行：node src/lib/generator.js
if (process.argv[1] && process.argv[1].endsWith('generator.js')) {
  const out = generate();
  console.log(JSON.stringify(out.design.counts, null, 2));
}

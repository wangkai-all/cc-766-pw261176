// 复查误判建模：复查标签不是真值。
//
// 两条识别通道：
//  (1) Hui–Walter 潜类别 EM：两名复查者在共同审查样本上的四格表，按产线分组
//      （各产线患病率不同，满足多总体识别条件）。无真值，仅靠一致性结构识别。
//  (2) 仲裁样本 gold：已知真值，直接按二项分布/Wilson 区间估计灵敏度、特异度。
//
// 识别失败时（边界完美分类伪解 / 似然平台 / 分组不足）返回 partial 标识与
// 网格轮廓区间，由界面保留区间并允许人工假设调整——绝不把单点估计伪装成可识别。

export function wilsonInterval(k, n, z = 1.96) {
  if (n === 0) return [0, 1];
  const phat = k / n;
  const denom = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denom;
  const half =
    (z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * n)) / n)) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

// 仲裁样本：按复查者分别估计 Se/Sp
export function estimateFromGold(gold) {
  const out = {};
  for (const reviewerId of ['A', 'B']) {
    const key = reviewerId === 'A' ? 'labelA' : 'labelB';
    let tp = 0;
    let fn = 0;
    let tn = 0;
    let fp = 0;
    for (const g of gold) {
      const lab = g[key];
      if (g.truth === 1) lab === 1 ? tp++ : fn++;
      else lab === 0 ? tn++ : fp++;
    }
    const se = tp + fn > 0 ? tp / (tp + fn) : null;
    const sp = tn + fp > 0 ? tn / (tn + fp) : null;
    out[reviewerId] = {
      sensitivity: se,
      specificity: sp,
      seInterval: wilsonInterval(tp, tp + fn),
      spInterval: wilsonInterval(tn, tn + fp),
      nPositive: tp + fn,
      nNegative: tn + fp,
    };
  }
  return out;
}

// 汇总各产线 2x2 观察计数
function buildContingency(consensus) {
  const groups = new Map();
  for (const c of consensus) {
    if (!groups.has(c.lineId)) groups.set(c.lineId, { n00: 0, n01: 0, n10: 0, n11: 0, n: 0 });
    const cell = groups.get(c.lineId);
    cell[`n${c.labelA}${c.labelB}`]++;
    cell.n++;
  }
  return [...groups.entries()].map(([lineId, cell]) => ({ lineId, ...cell }));
}

const EPS = 1e-12;
const FLOOR = 1e-6;
const CEIL = 1 - 1e-6;
const clamp01 = (x) => Math.min(CEIL, Math.max(FLOOR, x));

// 弱 Beta 先验（Beta(2,2) 等效 2 次成功/2 次失败的伪计数）：
// 不改变数据充分时的结论，但阻止 MLE 退到 0/1 边界的"完美分类"伪解。
const PRIOR = 2;

// 单次 EM：两复查者、多总体（产线）Hui–Walter 模型
function emOnce(tables, init, maxIter = 3000) {
  let seA = clamp01(init.seA);
  let spA = clamp01(init.spA);
  let seB = clamp01(init.seB);
  let spB = clamp01(init.spB);
  const prev = tables.map(() => 0.5);

  for (let iter = 0; iter < maxIter; iter++) {
    // E 步
    const post = tables.map((t, g) => {
      const p = prev[g];
      const lik1 = [
        (1 - seA) * (1 - seB),
        (1 - seA) * seB,
        seA * (1 - seB),
        seA * seB,
      ];
      const lik0 = [
        spA * spB,
        spA * (1 - spB),
        (1 - spA) * spB,
        (1 - spA) * (1 - spB),
      ];
      const cells = ['n00', 'n01', 'n10', 'n11'];
      const q = cells.map((cell, i) => {
        const joint1 = p * lik1[i];
        const joint0 = (1 - p) * lik0[i];
        const denom = joint1 + joint0 + EPS;
        return t[cell] * (joint1 / denom);
      });
      return { q, dExp: q.reduce((a, b) => a + b, 0), n: t.n };
    });

    // M 步
    let dA1 = 0;
    let dB1 = 0;
    let dAll = 0;
    let ndA0 = 0;
    let ndB0 = 0;
    let ndAll = 0;
    post.forEach((po, g) => {
      const t = tables[g];
      const d = po.dExp;
      const nd = t.n - d;
      dAll += d;
      ndAll += nd;
      dA1 += po.q[2] + po.q[3];
      dB1 += po.q[1] + po.q[3];
      ndA0 += t.n00 - po.q[0] + (t.n01 - po.q[1]);
      ndB0 += t.n00 - po.q[0] + (t.n10 - po.q[2]);
      prev[g] = d / t.n;
    });

    const next = {
      seA: clamp01((dA1 + PRIOR - 1) / Math.max(dAll + 2 * (PRIOR - 1), EPS)),
      seB: clamp01((dB1 + PRIOR - 1) / Math.max(dAll + 2 * (PRIOR - 1), EPS)),
      spA: clamp01((ndA0 + PRIOR - 1) / Math.max(ndAll + 2 * (PRIOR - 1), EPS)),
      spB: clamp01((ndB0 + PRIOR - 1) / Math.max(ndAll + 2 * (PRIOR - 1), EPS)),
    };
    const delta = Math.max(
      Math.abs(next.seA - seA),
      Math.abs(next.spA - spA),
      Math.abs(next.seB - seB),
      Math.abs(next.spB - spB)
    );
    seA = next.seA;
    spA = next.spA;
    seB = next.seB;
    spB = next.spB;
    if (delta < 1e-10) break;
  }

  const logLik = logLikelihood(tables, prev, { seA, spA, seB, spB });
  return {
    seA,
    spA,
    seB,
    spB,
    boundary: [seA, spA, seB, spB].some((x) => x < 0.55 || x > 0.995),
    prevalence: tables.map((t, g) => ({ lineId: t.lineId, p: prev[g] })),
    logLik,
  };
}

function logLikelihood(tables, prev, m) {
  let ll = 0;
  tables.forEach((t, g) => {
    const p = prev[g];
    const lik = (a, b) =>
      p * (a === 1 ? m.seA : 1 - m.seA) * (b === 1 ? m.seB : 1 - m.seB) +
      (1 - p) * (a === 1 ? 1 - m.spA : m.spA) * (b === 1 ? 1 - m.spB : m.spB);
    ll +=
      t.n00 * Math.log(lik(0, 0) + EPS) +
      t.n01 * Math.log(lik(0, 1) + EPS) +
      t.n10 * Math.log(lik(1, 0) + EPS) +
      t.n11 * Math.log(lik(1, 1) + EPS);
  });
  return ll;
}

// 粗网格（每个网格点作为 EM 初值），覆盖全参数空间，避免局部最优
const GRID = [0.6, 0.7, 0.8, 0.9, 0.97];

function gridStarts() {
  const starts = [];
  for (const seA of GRID)
    for (const spA of GRID)
      for (const seB of GRID)
        for (const spB of GRID)
          starts.push({ seA, spA, seB, spB });
  return starts;
}

// 轮廓似然：固定测量参数，组内患病率迭代到 MLE，返回对数似然
function profileLikelihood(tables, s) {
  const prev = tables.map(() => 0.5);
  for (let it = 0; it < 200; it++) {
    let moved = 0;
    tables.forEach((t, g) => {
      const lik = (a, b) =>
        (a === 1 ? s.seA : 1 - s.seA) * (b === 1 ? s.seB : 1 - s.seB);
      const lik0 = (a, b) =>
        (a === 1 ? 1 - s.spA : s.spA) * (b === 1 ? 1 - s.spB : s.spB);
      const cells = [
        [t.n00, 0, 0],
        [t.n01, 0, 1],
        [t.n10, 1, 0],
        [t.n11, 1, 1],
      ];
      let num = 0;
      let den = 0;
      for (const [n, a, b] of cells) {
        const j1 = lik(a, b);
        const j0 = lik0(a, b);
        num += (n * j1) / (prev[g] * j1 + (1 - prev[g]) * j0 + EPS);
        den += n / (prev[g] * j1 + (1 - prev[g]) * j0 + EPS);
      }
      const pNext = clamp01(num / Math.max(den, EPS));
      moved = Math.max(moved, Math.abs(pNext - prev[g]));
      prev[g] = pNext;
    });
    if (moved < 1e-9) break;
  }
  return { logLik: logLikelihood(tables, prev, s), prev };
}

// 两阶段网格：粗网格定位最优区域，再在其周围用细网格（步长 0.03）刻画轮廓
function profileIntervals(tables, tolerance = 3.84) {
  const coarse = gridStarts().map((s) => ({ ...s, ...profileLikelihood(tables, s) }));
  const bestCoarse = coarse.reduce((a, b) => (b.logLik > a.logLik ? b : a));

  const fineAxis = (center) => {
    const lo = Math.max(0.55, center - 0.13);
    const hi = Math.min(0.99, center + 0.13);
    const out = [];
    for (let v = lo; v <= hi + 1e-9; v += 0.03) out.push(Number(v.toFixed(3)));
    return [...new Set(out)];
  };
  const axes = {
    seA: fineAxis(bestCoarse.seA),
    spA: fineAxis(bestCoarse.spA),
    seB: fineAxis(bestCoarse.seB),
    spB: fineAxis(bestCoarse.spB),
  };
  const rows = [];
  for (const seA of axes.seA)
    for (const spA of axes.spA)
      for (const seB of axes.seB)
        for (const spB of axes.spB)
          rows.push({ seA, spA, seB, spB, ...profileLikelihood(tables, { seA, spA, seB, spB }) });

  const all = coarse.concat(rows);
  const best = all.reduce((a, b) => (b.logLik > a.logLik ? b : a));
  const near = all.filter((r) => best.logLik - r.logLik <= tolerance);
  const range = (key) => [
    Math.min(...near.map((r) => r[key])),
    Math.max(...near.map((r) => r[key])),
  ];
  return {
    best,
    intervals: { seA: range('seA'), spA: range('spA'), seB: range('seB'), spB: range('spB') },
    gridPoints: all.length,
    tolerance,
  };
}

// 主入口：网格启动 EM + 退化检测 + 轮廓区间。
// 记忆化：同一共识样本（按指纹）只做一次网格搜索，月报重放/界面重渲染时直接复用。
const _emCache = new Map();

export function estimateFromConsensus(consensus) {
  const fingerprint = consensus
    .map((c) => `${c.unitId}:${c.labelA}${c.labelB}`)
    .join('|');
  const hit = _emCache.get(fingerprint);
  if (hit) return hit;
  const result = estimateFromConsensusUncached(consensus);
  if (_emCache.size > 12) _emCache.clear();
  _emCache.set(fingerprint, result);
  return result;
}

function estimateFromConsensusUncached(consensus) {
  const tables = buildContingency(consensus);
  const nGroups = new Set(consensus.map((c) => c.lineId)).size;
  const multiGroup = nGroups >= 3;

  const fits = gridStarts().map((s) => emOnce(tables, s));
  const interior = fits.filter((f) => !f.boundary);
  fits.sort((a, b) => b.logLik - a.logLik);
  const bestOverall = fits[0];

  // 内部最优（若存在）优先；边界解只作为"伪解"证据
  const bestInterior = interior.sort((a, b) => b.logLik - a.logLik)[0] ?? null;
  const best = bestInterior && bestOverall.boundary && bestInterior.logLik >= bestOverall.logLik - 2
    ? bestInterior
    : bestOverall;

  // 识别判定：多组 + 内部解 + 似然明显优于边界伪解 + 内部解彼此聚拢
  let identifiable = multiGroup && !!bestInterior && !best.boundary;
  let reason = null;
  if (!multiGroup) reason = `仅 ${nGroups} 个患病率分组，Hui–Walter 多总体识别条件不满足`;
  else if (!bestInterior) reason = '所有 EM 解都贴参数边界（完美分类伪解），测量参数不可识别';
  else if (bestOverall.boundary && bestOverall.logLik - bestInterior.logLik > 2)
    reason = '边界完美分类解的似然占优，数据中的分歧不足以识别误判率';
  else if (bestInterior) {
    const spread = Math.max(
      ...['seA', 'spA', 'seB', 'spB'].map(
        (k) => Math.max(...interior.map((f) => f[k])) - Math.min(...interior.map((f) => f[k]))
      )
    );
    if (spread >= 0.15) reason = '多个内部解似然接近（似然平台），参数仅部分识别';
    identifiable = identifiable && spread < 0.15;
  }

  const profile = profileIntervals(tables);
  const widthOf = (iv) => iv[1] - iv[0];
  const wideProfile =
    widthOf(profile.intervals.seA) > 0.12 || widthOf(profile.intervals.spA) > 0.12;
  if (identifiable && wideProfile) {
    identifiable = false;
    reason = '轮廓似然区间过宽，参数仅部分识别';
  }

  return {
    identifiable,
    reason,
    point: { sensitivity: best.seA, specificity: best.spA },
    reviewerB: { sensitivity: best.seB, specificity: best.spB },
    prevalenceByLine: best.prevalence,
    logLik: best.logLik,
    boundaryPseudoSolution: bestOverall.boundary
      ? {
          seA: bestOverall.seA,
          spA: bestOverall.spA,
          seB: bestOverall.seB,
          spB: bestOverall.spB,
          logLik: bestOverall.logLik,
        }
      : null,
    profileIntervals: profile.intervals,
    profileTolerance: profile.tolerance,
    gridPoints: profile.gridPoints,
    tables,
  };
}

// K 复查者通用潜类别 EM（K>=3 时经典 Hui–Walter 设计可识别；
// 主数据集只有 A/B 两人，此函数用于可识别成功路径的合成验证）。
// 输入共识行：{ lineId, labels: [0/1, ...] }，按产线分组。
export function estimateConsensusK(consensusK, kRaters) {
  const groupIds = [...new Set(consensusK.map((c) => c.lineId))];
  const groups = groupIds.map((g) => consensusK.filter((c) => c.lineId === g));
  let se = Array.from({ length: kRaters }, () => 0.85);
  let sp = Array.from({ length: kRaters }, () => 0.92);
  const prev = groups.map(() => 0.5);

  const patternLik = (labels, defective) =>
    labels.reduce((acc, y, r) => {
      const p = defective ? se[r] : 1 - sp[r];
      return acc * (y === 1 ? p : 1 - p);
    }, 1);

  for (let iter = 0; iter < 2000; iter++) {
    const dExp = groups.map((rows, g) => {
      let d = 0;
      const perRaterPosD = new Array(kRaters).fill(0);
      const perRaterNegND = new Array(kRaters).fill(0);
      for (const c of rows) {
        const j1 = prev[g] * patternLik(c.labels, 1);
        const j0 = (1 - prev[g]) * patternLik(c.labels, 0);
        const q = j1 / (j1 + j0 + EPS);
        d += q;
        for (let r = 0; r < kRaters; r++) {
          if (c.labels[r] === 1) perRaterPosD[r] += q;
          if (c.labels[r] === 0) perRaterNegND[r] += 1 - q;
        }
      }
      return { d, n: rows.length, perRaterPosD, perRaterNegND };
    });

    const dAll = dExp.reduce((a, x) => a + x.d, 0);
    const ndAll = dExp.reduce((a, x) => a + (x.n - x.d), 0);
    const nextSe = se.map((_, r) =>
      clamp01(
        (dExp.reduce((a, x) => a + x.perRaterPosD[r], 0) + PRIOR - 1) /
          Math.max(dAll + 2 * (PRIOR - 1), EPS)
      )
    );
    const nextSp = sp.map((_, r) =>
      clamp01(
        (dExp.reduce((a, x) => a + x.perRaterNegND[r], 0) + PRIOR - 1) /
          Math.max(ndAll + 2 * (PRIOR - 1), EPS)
      )
    );
    dExp.forEach((x, g) => {
      prev[g] = x.d / x.n;
    });

    const delta = Math.max(
      ...nextSe.map((v, r) => Math.abs(v - se[r])),
      ...nextSp.map((v, r) => Math.abs(v - sp[r]))
    );
    se = nextSe;
    sp = nextSp;
    if (delta < 1e-10) break;
  }

  return {
    sensitivity: se,
    specificity: sp,
    prevalenceByLine: groupIds.map((g, i) => ({ lineId: g, p: prev[i] })),
  };
}

// 综合测量模型：gold 优先（有真值锚点），共识 EM 作交叉验证；
// 支持界面传入人工假设（override）。
export function buildMeasurementModel({ consensus, gold, override = null }) {
  const em = estimateFromConsensus(consensus);
  const goldEst = gold.length ? estimateFromGold(gold) : null;

  let source;
  let seA;
  let spA;
  let seB;
  let spB;
  let seAInterval;
  let spAInterval;

  if (override) {
    source = 'user-assumption';
    seA = override.sensitivity;
    spA = override.specificity;
    seB = override.sensitivityB ?? em.reviewerB.sensitivity;
    spB = override.specificityB ?? em.reviewerB.specificity;
    seAInterval = [seA, seA];
    spAInterval = [spA, spA];
  } else if (goldEst && goldEst.A.sensitivity !== null) {
    source = 'adjudicated-gold';
    seA = goldEst.A.sensitivity;
    spA = goldEst.A.specificity;
    seB = goldEst.B.sensitivity;
    spB = goldEst.B.specificity;
    seAInterval = goldEst.A.seInterval;
    spAInterval = goldEst.A.spInterval;
  } else if (em.identifiable) {
    source = 'hui-walter-em';
    seA = em.point.sensitivity;
    spA = em.point.specificity;
    seB = em.reviewerB.sensitivity;
    spB = em.reviewerB.specificity;
    seAInterval = null;
    spAInterval = null;
  } else {
    source = 'partial-identification';
    seA = em.point.sensitivity;
    spA = em.point.specificity;
    seB = em.reviewerB.sensitivity;
    spB = em.reviewerB.specificity;
    seAInterval = em.profileIntervals.seA;
    spAInterval = em.profileIntervals.spA;
  }

  return {
    source,
    sensitivity: seA,
    specificity: spA,
    sensitivityB: seB,
    specificityB: spB,
    seInterval: seAInterval,
    spInterval: spAInterval,
    em,
    gold: goldEst,
    identifiable: source !== 'partial-identification',
  };
}

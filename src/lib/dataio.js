// 数据加载与采样台账（浏览器用 fetch，Node 用 fs；同一套解析逻辑）

import { LOCKED_MONTH } from './config.js';

async function loadText(pathLike) {
  // 浏览器环境（含 file:// 页面）走 fetch；Node 走 fs，避免相对 URL 报错
  if (typeof window !== 'undefined' && typeof fetch === 'function') {
    const res = await fetch(pathLike);
    if (!res.ok) throw new Error(`加载失败 ${pathLike}: HTTP ${res.status}`);
    return res.text();
  }
  const { readFileSync } = await import('node:fs');
  return readFileSync(pathLike, 'utf8');
}

function parseJsonl(text) {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => JSON.parse(s));
}

export async function loadDataset(base) {
  const norm = base.endsWith('/') ? base.slice(0, -1) : base;
  const [shipmentText, reviewsText, consensusText, goldText, designText] = await Promise.all(
    ['shipment.jsonl', 'reviews.jsonl', 'consensus.jsonl', 'gold.jsonl', 'design.json'].map((f) =>
      loadText(`${norm}/${f}`)
    )
  );

  const units = parseJsonl(shipmentText);
  const reviews = parseJsonl(reviewsText);
  const consensus = parseJsonl(consensusText);
  const gold = parseJsonl(goldText);
  const design = JSON.parse(designText);
  return buildLedger({ units, reviews, consensus, gold, design });
}

// 构造估计用采样台账：
// 每个复查件的累计入选概率
//   P(被复查) = 1 - (1-pi1)(1-pi2)，其中 pi2 是 v1 未中选条件下的补录条件概率
// 权重 w = 1 / P(被复查)（Horvitz–Thompson）。
// 无复查件、pi 恒为 0 的批次不会进入估计样本，由覆盖性分析单独处理。
export function buildLedger({ units, reviews, consensus, gold, design }) {
  const unitById = new Map(units.map((u) => [u.unitId, u]));
  const byLine = new Map();
  const byBatch = new Map();
  for (const u of units) {
    if (!byLine.has(u.lineId)) byLine.set(u.lineId, []);
    if (!byBatch.has(u.batchId)) byBatch.set(u.batchId, []);
    byLine.get(u.lineId).push(u);
    byBatch.get(u.batchId).push(u);
  }

  // 主复查者（A）标签：每个复查件取一条
  const primaryLabels = new Map();
  const reviewerSet = new Set();
  for (const r of reviews) {
    reviewerSet.add(r.reviewerId);
    if (r.reviewerId === 'A' && !primaryLabels.has(r.unitId)) {
      primaryLabels.set(r.unitId, { label: r.label, wave: r.wave, reviewDate: r.reviewDate });
    }
  }

  const sampled = [];
  for (const [unitId, lab] of primaryLabels) {
    const u = unitById.get(unitId);
    if (!u) continue;
    const p1 = u.wave1Prob || 0;
    const p2 = u.wave2CondProb || 0;
    const inclusion = 1 - (1 - p1) * (1 - p2);
    if (inclusion <= 0) continue; // 结构性无机会，不进估计样本
    sampled.push({
      unitId,
      batchId: u.batchId,
      lineId: u.lineId,
      month: u.month,
      modelScore: u.modelScore,
      label: lab.label,
      wave: lab.wave,
      inclusionProb: inclusion,
      weight: 1 / inclusion,
    });
  }

  const batches = design.batches.map((b) => {
    const members = byBatch.get(b.batchId) || [];
    const reviewedHere = sampled.filter((s) => s.batchId === b.batchId);
    const designMaxPi = Math.max(0, ...members.map((m) => m.wave1Prob || 0));
    return {
      ...b,
      totalUnits: members.length,
      reviewedCount: reviewedHere.length,
      weightSum: reviewedHere.reduce((a, s) => a + s.weight, 0),
      covered: designMaxPi > 0 && reviewedHere.length > 0,
      // 覆盖缺口：设计上有概率但没抽到 / 设计上零概率
      gapReason:
        designMaxPi === 0
          ? 'zero-inclusion-probability'
          : reviewedHere.length === 0
            ? 'no-realized-sample'
            : null,
    };
  });

  return {
    units,
    reviews,
    consensus,
    gold,
    design,
    unitById,
    byLine,
    byBatch,
    sampled,
    batches,
    reviewers: [...reviewerSet].sort(),
    lockedMonth: LOCKED_MONTH,
  };
}

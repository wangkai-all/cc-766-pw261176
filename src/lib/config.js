// 全局常量与数据契约说明
//
// 数据来源全部为虚构合成数据（generator.js 生成），字段契约：
//
// shipment.jsonl —— 完整出货清单（总体框架），每行一件：
//   unitId, batchId, lineId, month, modelScore(0~1),
//   inclusionProb(设计抽样概率 pi, 0~1)
// reviews.jsonl —— 复查台账（只有被抽到的件才有记录）：
//   unitId, reviewerId(A/B), label(0/1), wave("v1"|"v2"), reviewDate
// consensus.jsonl —— 两名复查者共同审过的样本（无真值，用于一致性建模）：
//   unitId, lineId, labelA, labelB
// gold.jsonl —— 少量经仲裁/工程确认的已知真值件（另一条识别通道）：
//   unitId, lineId, labelA, labelB, truth(0/1)
// truth.secret.json —— 仅测试用的生成器真值（估计代码禁止读取此文件）
//
// 估计端能看到的只有 shipment + reviews + consensus + gold。

export const MONTHS = ['2026-10', '2026-11'];

export const LINES = [
  { lineId: 'L1', name: '产线1', trueDefectRate: 0.05 },
  { lineId: 'L2', name: '产线2', trueDefectRate: 0.08 },
  { lineId: 'L3', name: '产线3', trueDefectRate: 0.12 },
  { lineId: 'L4', name: '产线4', trueDefectRate: 0.035 },
  { lineId: 'L5', name: '产线5', trueDefectRate: 0.16 },
  { lineId: 'L6', name: '产线6', trueDefectRate: 0.07 },
];

// 复查者测量质量（真值；估计端只能从共识/仲裁样本推断）
export const REVIEWER_TRUTH = {
  A: { sensitivity: 0.90, specificity: 0.95 },
  B: { sensitivity: 0.80, specificity: 0.98 },
};

export const LOCKED_MONTH = '2026-10';
export const LOCKED_REPORT_VERSION = '2026-10-lock-v1';

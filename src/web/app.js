// 质量分析页主逻辑：加载流水线结果并渲染六个功能区。
// 误判假设调整时在浏览器内重跑估计引擎（同一套 src/lib 代码），无需服务端。

import { loadDataset } from '../lib/dataio.js';
import { buildMeasurementModel } from '../lib/misclassification.js';
import { estimateAll } from '../lib/estimator.js';
import { buildRecommendations } from '../lib/recommendations.js';
import { buildLockedReport, buildCurrentMonthView } from '../lib/reports.js';
import {
  renderComparisonBars,
  renderBudgetBars,
  renderCoverageBars,
  renderTable,
  fmtPct,
  isDark,
} from './charts.js';

const state = {
  ledger: null,
  baseResult: null,
  view: null, // 当前（可能被假设调整覆盖的）结果
  budget: 150,
  measurementMode: 'gold', // gold | em-only
};

const $ = (sel) => document.querySelector(sel);

function badge(text, tone = 'neutral') {
  const span = document.createElement('span');
  span.className = `badge badge-${tone}`;
  span.textContent = text;
  return span;
}

function ciText(ci) {
  return ci ? `${fmtPct(ci[0], 1)} – ${fmtPct(ci[1], 1)}` : '—';
}

async function init() {
  const base = new URL('../../data/', import.meta.url).href;
  state.ledger = await loadDataset(base);
  state.baseResult = await compute(null);
  state.view = state.baseResult;
  bindControls();
  renderAll();
}

async function compute(override) {
  const ledger = state.ledger;
  let model;
  if (override) {
    model = buildMeasurementModel({
      consensus: ledger.consensus,
      gold: ledger.gold,
      override,
    });
  } else if (state.measurementMode === 'em-only') {
    // 仅用共识 EM：演示无真值锚点时的部分识别
    const emModel = buildMeasurementModel({ consensus: ledger.consensus, gold: [] });
    model = emModel;
  } else {
    model = buildMeasurementModel({
      consensus: ledger.consensus,
      gold: ledger.gold,
    });
  }
  const estimate = estimateAll(ledger, { model, nBoot: 400 });
  const recommendations = buildRecommendations(ledger, estimate, state.budget);
  const raw = {
    units: ledger.units,
    reviews: ledger.reviews,
    consensus: ledger.consensus,
    gold: ledger.gold,
  };
  return {
    model,
    estimate,
    recommendations,
    reports: {
      lockedOctober: buildLockedReport(raw, ledger.design),
      currentOctober: buildCurrentMonthView(raw, ledger.design, '2026-10', {
        assumptionOverride: override,
      }),
    },
  };
}

function bindControls() {
  $('#theme-toggle').addEventListener('click', () => {
    const root = document.documentElement;
    root.dataset.theme = isDark() ? 'light' : 'dark';
    renderAll();
  });

  const seInput = $('#input-se');
  const spInput = $('#input-sp');
  const applyBtn = $('#apply-assumption');
  const resetBtn = $('#reset-assumption');

  applyBtn.addEventListener('click', async () => {
    const se = Number(seInput.value) / 100;
    const sp = Number(spInput.value) / 100;
    if (!(se > 0.5 && se < 1 && sp > 0.5 && sp < 1)) {
      $('#assumption-hint').textContent = '灵敏度与特异度需在 50%–100% 之间';
      return;
    }
    applyBtn.disabled = true;
    applyBtn.textContent = '重算中…';
    state.view = await compute({ sensitivity: se, specificity: sp });
    applyBtn.disabled = false;
    applyBtn.textContent = '应用假设并重算';
    $('#assumption-hint').textContent =
      '当前为人工假设视图；锁定月报不受影响，仍保留其原始证据与模型参数。';
    renderAll();
  });

  resetBtn.addEventListener('click', async () => {
    resetBtn.disabled = true;
    state.measurementMode = 'gold';
    $('#measurement-mode').value = 'gold';
    state.view = state.baseResult;
    const m = state.baseResult.model;
    seInput.value = (m.sensitivity * 100).toFixed(1);
    spInput.value = (m.specificity * 100).toFixed(1);
    $('#assumption-hint').textContent = '';
    resetBtn.disabled = false;
    renderAll();
  });

  $('#measurement-mode').addEventListener('change', async (e) => {
    state.measurementMode = e.target.value;
    const selectEl = e.target;
    selectEl.disabled = true;
    state.view = await compute(null);
    selectEl.disabled = false;
    $('#assumption-hint').textContent =
      state.measurementMode === 'em-only'
        ? '仅使用共同审查样本（无仲裁真值）：EM 不可识别时自动降级为部分识别，估计保留轮廓区间。'
        : '';
    renderAll();
  });

  $('#budget-input').addEventListener('change', async (e) => {
    state.budget = Math.max(20, Math.min(400, Number(e.target.value) || 150));
    e.target.value = state.budget;
    const recs = buildRecommendations(state.ledger, state.view.estimate, state.budget);
    state.view = { ...state.view, recommendations: recs };
    renderRecommendations();
  });

  $('#month-filter').addEventListener('change', (e) => {
    const month = e.target.value;
    const filtered =
      month === 'all'
        ? state.view.estimate.coverage
        : state.view.estimate.coverage.filter((c) => c.month === month);
    renderCoverageBars($('#coverage-chart'), filtered);
    document.querySelectorAll('[data-month-panel]').forEach((p) => {
      p.hidden = month !== 'all' && p.dataset.monthPanel !== month;
    });
  });
}

function renderAll() {
  renderKpis();
  renderMeasurement();
  renderLines();
  renderBatches();
  renderCoverage();
  renderRecommendations();
  renderReports();
}

function renderKpis() {
  const { estimate, model } = state.view;
  const o = estimate.overall;
  $('#kpi-corrected').textContent = fmtPct(o.corrected, 2);
  $('#kpi-ci').textContent = ciText(o.ci);
  $('#kpi-naive').textContent = fmtPct(o.naive, 2);
  $('#kpi-bias-gap').textContent = fmtPct(o.naive - o.corrected, 2);
  $('#kpi-coverage').textContent = fmtPct(o.coverageRate, 1);
  $('#kpi-uncovered').textContent = `${o.uncoveredUnits} 件`;
  $('#kpi-total-interval').textContent = o.totalIntervalIncludingUncovered
    ? `${fmtPct(o.totalIntervalIncludingUncovered[0], 1)} – ${fmtPct(o.totalIntervalIncludingUncovered[1], 1)}`
    : '—';
  $('#kpi-model-source').replaceChildren(
    badge(
      {
        'adjudicated-gold': '仲裁真值锚定',
        'hui-walter-em': '共识 EM 识别',
        'partial-identification': '部分识别（保留区间）',
        'user-assumption': '人工假设',
      }[model.source] ?? model.source,
      model.identifiable ? 'good' : 'warning'
    )
  );

  const c = estimate.lineContrast;
  if (c) {
    $('#kpi-contrast').textContent = `${c.highLine} − ${c.lowLine}：${fmtPct(c.difference, 1)}${
      c.ratio ? `（${c.ratio.toFixed(1)} 倍）` : ''
    }`;
  }
}

function renderMeasurement() {
  const { model } = state.view;
  const em = model.em;
  const rows = [];
  rows.push(['模型来源', { 'adjudicated-gold': '仲裁样本（已知真值）', 'hui-walter-em': 'Hui-Walter 潜类别 EM', 'partial-identification': '部分识别', 'user-assumption': '人工假设' }[model.source]]);
  rows.push(['复查者 A 灵敏度 Se', `${fmtPct(model.sensitivity, 2)}${model.seInterval ? `（区间 ${fmtPct(model.seInterval[0], 1)}–${fmtPct(model.seInterval[1], 1)}）` : ''}`]);
  rows.push(['复查者 A 特异度 Sp', `${fmtPct(model.specificity, 2)}${model.spInterval ? `（区间 ${fmtPct(model.spInterval[0], 1)}–${fmtPct(model.spInterval[1], 1)}）` : ''}`]);
  rows.push(['复查者 B 灵敏度 Se', fmtPct(model.sensitivityB, 2)]);
  rows.push(['复查者 B 特异度 Sp', fmtPct(model.specificityB, 2)]);
  rows.push(['EM 可识别', em.identifiable ? '是' : `否：${em.reason}`]);
  rows.push(['EM 轮廓区间 Se_A', em.profileIntervals ? `${fmtPct(em.profileIntervals.seA[0], 1)} – ${fmtPct(em.profileIntervals.seA[1], 1)}` : '—']);
  rows.push(['EM 轮廓区间 Sp_A', em.profileIntervals ? `${fmtPct(em.profileIntervals.spA[0], 1)} – ${fmtPct(em.profileIntervals.spA[1], 1)}` : '—']);
  if (em.boundaryPseudoSolution) {
    rows.push(['边界伪解（已拒绝）', `Se_A=${fmtPct(em.boundaryPseudoSolution.seA, 2)}, Sp_B=${fmtPct(em.boundaryPseudoSolution.spB, 2)}（似然 ${em.boundaryPseudoSolution.logLik.toFixed(1)}）`]);
  }
  if (model.gold) {
    rows.push(['仲裁样本量', `A: ${model.gold.A.nPositive + model.gold.A.nNegative} 件（缺陷 ${model.gold.A.nPositive}）`]);
  }

  const dl = $('#measurement-list');
  dl.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }

  // 四格表
  const tableHost = $('#contingency-table');
  renderTable(
    tableHost,
    [
      { key: 'lineId', label: '产线' },
      { key: 'n00', label: 'A=0 B=0' },
      { key: 'n01', label: 'A=0 B=1' },
      { key: 'n10', label: 'A=1 B=0' },
      { key: 'n11', label: 'A=1 B=1' },
      { key: 'n', label: '合计' },
    ],
    em.tables
  );

  // 同步假设输入默认值
  if (model.source !== 'user-assumption') {
    $('#input-se').value = (model.sensitivity * 100).toFixed(1);
    $('#input-sp').value = (model.specificity * 100).toFixed(1);
  }
}

function renderLines() {
  const lines = state.view.estimate.lines;
  renderComparisonBars($('#line-chart'), lines);
  renderTable(
    $('#line-table'),
    [
      { key: 'lineId', label: '产线' },
      { key: 'n', label: '复查件数' },
      { key: 'naive', label: 'naive 标签率', render: (r) => fmtPct(r.naive, 2) },
      { key: 'weighted', label: 'IPW 加权率', render: (r) => fmtPct(r.weighted, 2) },
      { key: 'corrected', label: '纠正后缺陷率', render: (r) => fmtPct(r.corrected, 2) },
      { key: 'ci', label: '95% Bootstrap CI', render: (r) => ciText(r.ci) },
      {
        key: 'band',
        label: '测量不确定性带',
        render: (r) => (r.band ? `${fmtPct(r.band[0], 1)} – ${fmtPct(r.band[1], 1)}` : '—'),
      },
    ],
    lines
  );
}

function renderBatches() {
  const rows = state.view.estimate.batches;
  renderTable(
    $('#batch-table'),
    [
      { key: 'batchId', label: '批次' },
      { key: 'lineId', label: '产线' },
      { key: 'month', label: '月份' },
      {
        key: 'covered',
        label: '覆盖状态',
        render: (r) =>
          r.covered
            ? badge('已覆盖', 'good')
            : badge(r.gapReason === 'zero-inclusion-probability' ? '零概率·不可外推' : '无实现样本', 'critical'),
      },
      { key: 'totalUnits', label: '批次规模' },
      { key: 'n', label: '复查数' },
      { key: 'corrected', label: '纠正率', render: (r) => (r.covered ? fmtPct(r.corrected, 2) : '—') },
      { key: 'ci', label: '95% CI', render: (r) => (r.covered ? ciText(r.ci) : '区间 0% – 100%') },
    ],
    rows
  );
}

function renderCoverage() {
  renderCoverageBars($('#coverage-chart'), state.view.estimate.coverage);
  const gaps = state.view.recommendations.structuralGaps;
  const host = $('#structural-gaps');
  host.replaceChildren();
  if (!gaps.length) {
    host.textContent = '无结构性缺口。';
    return;
  }
  for (const g of gaps) {
    const div = document.createElement('div');
    div.className = 'gap-card';
    const h = document.createElement('strong');
    h.textContent = `${g.batchId}（${g.lineId} · ${g.month} · ${g.size} 件）`;
    const p = document.createElement('p');
    p.textContent = g.message;
    div.append(h, p);
    host.appendChild(div);
  }
}

function renderRecommendations() {
  const recs = state.view.recommendations;
  renderBudgetBars($('#budget-chart'), recs.strategies);

  const summaryHost = $('#budget-summary');
  renderTable(
    summaryHost,
    [
      { key: 'strategy', label: '策略' },
      {
        key: 'label',
        label: '说明',
        render: (r) =>
          ({ 'score-first': '继续多查高分件', 'blind-spot': '补查低概率盲区', balanced: '均衡混合' })[r.strategy],
      },
      { key: 'ess', label: 'ESS 增益', render: (r) => `+${r.expected.essGain.toFixed(0)}（${r.expected.essBefore.toFixed(0)}→${r.expected.essAfter.toFixed(0)}）` },
      { key: 'vr', label: '预期方差下降', render: (r) => `${r.expected.varianceReductionPct?.toFixed(1)}%` },
      { key: 'blind', label: '盲区命中', render: (r) => `${r.expected.blindSpotHits} 件` },
    ],
    recs.strategies.map((s) => ({ strategy: s.strategy, ...s }))
  );

  // 候选清单：默认展示盲区策略，可切换
  const select = $('#candidate-strategy');
  if (!select.dataset.bound) {
    select.addEventListener('change', renderCandidateList);
    select.dataset.bound = '1';
  }
  renderCandidateList();
}

function renderCandidateList() {
  const name = $('#candidate-strategy').value;
  const strategy = state.view.recommendations.strategies.find((s) => s.strategy === name);
  const host = $('#candidate-table');
  renderTable(
    host,
    [
      { key: 'rank', label: '优先级' },
      { key: 'unitId', label: '单元' },
      { key: 'batchId', label: '批次' },
      { key: 'lineId', label: '产线' },
      { key: 'modelScore', label: '模型分数', render: (r) => r.modelScore.toFixed(3) },
      { key: 'wave1Prob', label: '设计概率 π', render: (r) => fmtPct(r.wave1Prob, 1) },
      { key: 'expectedDefectProb', label: '期望缺陷概率', render: (r) => fmtPct(r.expectedDefectProb, 1) },
      { key: 'reason', label: '入选理由' },
    ],
    strategy.candidates
  );
  $('#candidate-count').textContent =
    `${strategy.note} 候选 ${strategy.candidates.length} 件，预算 ${state.view.recommendations.budget} 件。`;

  // 导出按钮
  const exportBtn = $('#export-candidates');
  exportBtn.onclick = () => {
    const blob = new Blob([JSON.stringify(strategy, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `sampling-candidates-${name}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
}

function renderReports() {
  const { lockedOctober: locked, currentOctober: current } = state.view.reports;
  const host = $('#report-compare');
  renderTable(
    host,
    [
      { key: 'version', label: '版本' },
      { key: 'cutoff', label: '证据截止' },
      { key: 'waves', label: '证据波次' },
      { key: 'reviews', label: '复查记录' },
      { key: 'source', label: '测量模型' },
      { key: 'se', label: 'Se / Sp' },
      { key: 'rate', label: '当月纠正缺陷率' },
      { key: 'fp', label: '证据指纹' },
    ],
    [
      {
        version: '锁定月报（不可变）',
        cutoff: locked.evidenceCutoff,
        waves: locked.evidence.waves.join(', '),
        reviews: locked.evidence.reviewCount,
        source: locked.measurement.source,
        se: `${fmtPct(locked.measurement.sensitivity, 2)} / ${fmtPct(locked.measurement.specificity, 2)}`,
        rate: fmtPct(locked.estimate.corrected, 2),
        fp: locked.evidence.reviewsFingerprint,
      },
      {
        version: '当前视图（含 v2 补录）',
        cutoff: current.evidenceCutoff,
        waves: current.evidence.waves.join(', '),
        reviews: current.evidence.reviewCount,
        source: current.measurement.source,
        se: `${fmtPct(current.measurement.sensitivity, 2)} / ${fmtPct(current.measurement.specificity, 2)}`,
        rate: fmtPct(current.estimate.corrected, 2),
        fp: current.evidence.reviewsFingerprint,
      },
    ]
  );
  $('#report-note').textContent =
    `锁定版 ${locked.reportVersion} 的证据指纹为 ${locked.evidence.reviewsFingerprint}，` +
    '任何补录或假设调整都不会改写该版本；当前视图使用全部可用证据独立计算。';
}

init().catch((err) => {
  const host = document.createElement('pre');
  host.style.color = '#d03b3b';
  host.textContent = `初始化失败：${err.stack || err}`;
  document.body.appendChild(host);
});

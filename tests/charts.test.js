// 图表渲染冒烟测试：用最小 DOM 桩驱动 charts.js 的三个渲染函数，
// 捕获真实浏览器中才会暴露的 DOM API 误用（无第三方依赖）。

import test from 'node:test';
import assert from 'node:assert/strict';

// ---- 最小 DOM 桩 ----
class StubNode {
  constructor(tag = 'node') {
    this.tagName = tag;
    this.children = [];
    this.attrs = {};
    this.style = {};
    this.textContent = '';
    this._listeners = new Map();
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k];
  }
  appendChild(c) {
    this.children.push(c);
    c.parentNode = this;
    return c;
  }
  append(...cs) {
    cs.forEach((c) => this.appendChild(c));
  }
  replaceChildren(...cs) {
    this.children = [];
    cs.forEach((c) => this.appendChild(c));
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  getBoundingClientRect() {
    return { width: 120, height: 40 };
  }
  querySelector() {
    return null;
  }
}

function installDomStub() {
  const documentStub = {
    documentElement: { dataset: { theme: 'light' } },
    createElement: (tag) => new StubNode(tag),
    createElementNS: (_ns, tag) => new StubNode(tag),
    createTextNode: (t) => new StubNode('#text') && { textContent: t },
    body: new StubNode('body'),
  };
  globalThis.document = documentStub;
  globalThis.window = { innerWidth: 1280, innerHeight: 800 };
  return documentStub;
}

test('图表渲染：三个图表与表格在 DOM 桩下无异常并产出 SVG/表格', async () => {
  installDomStub();
  const charts = await import('../src/web/charts.js');
  const { renderComparisonBars, renderBudgetBars, renderCoverageBars, renderTable } = charts;

  const lines = [
    { lineId: 'L1', n: 120, naive: 0.15, weighted: 0.09, corrected: 0.06, ci: [0.03, 0.1], band: [0.04, 0.09] },
    { lineId: 'L2', n: 90, naive: 0.22, weighted: 0.14, corrected: 0.11, ci: [0.07, 0.16], band: null },
  ];
  const c1 = new StubNode();
  renderComparisonBars(c1, lines);
  assert.equal(c1.children.length, 2); // svg + legend
  const svg1 = c1.children[0];
  assert.equal(svg1.tagName, 'svg');
  assert.ok(svg1.children.length > 10, '应包含网格、柱、区间标记等元素');

  const strategies = [
    { strategy: 'score-first', expected: { varianceReductionPct: 11, essGain: 74, essBefore: 720, essAfter: 794, blindSpotHits: 0 } },
    { strategy: 'blind-spot', expected: { varianceReductionPct: 36, essGain: 102, essBefore: 720, essAfter: 822, blindSpotHits: 136 } },
    { strategy: 'balanced', expected: { varianceReductionPct: 35, essGain: 112, essBefore: 720, essAfter: 832, blindSpotHits: 134 } },
  ];
  const c2 = new StubNode();
  renderBudgetBars(c2, strategies);
  assert.equal(c2.children[0].tagName, 'svg');

  const coverage = [
    { batchId: 'B-L1-10', size: 380, reviewedCount: 90, covered: true, gapReason: null, partialInterval: null },
    { batchId: 'B-L4-10', size: 300, reviewedCount: 0, covered: false, gapReason: 'zero-inclusion-probability', partialInterval: [0, 1] },
  ];
  const c3 = new StubNode();
  renderCoverageBars(c3, coverage);
  assert.equal(c3.children[0].tagName, 'svg');

  const c4 = new StubNode();
  renderTable(
    c4,
    [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B', render: (r) => `${r.b}!` },
    ],
    [
      { a: 1, b: 'x' },
      { a: 2, b: 'y' },
    ]
  );
  const table = c4.children[0];
  assert.equal(table.tagName, 'table');
  const tbody = table.children.find((c) => c.tagName === 'tbody');
  assert.equal(tbody.children.length, 2);

  // 暗色主题切换不报错
  document.documentElement.dataset.theme = 'dark';
  const c5 = new StubNode();
  renderBudgetBars(c5, strategies);
  assert.equal(c5.children[0].tagName, 'svg');

  // 事件监听器已挂载（tooltip 交互）
  const hasInteractive = svg1.children.some((n) => n._listeners && n._listeners.size > 0);
  assert.ok(hasInteractive, '柱体应挂载 hover/focus 监听');
});

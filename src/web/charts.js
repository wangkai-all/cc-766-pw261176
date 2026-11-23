// 轻量内联 SVG 图表（无依赖）。遵循数据可视化规范：
// 固定分类色序、细柱（≤24px，4px 圆角数据端）、2px 表面间隙、
//  recessive 网格线、文本只用文字色、每图配 tooltip 与表格视图。

export const PALETTE = {
  series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#6250d6'],
  dark: {
    series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9'],
  },
  status: { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' },
  ink: {
    light: { primary: '#0b0b0b', secondary: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7', surface: '#fcfcfb' },
    dark: { primary: '#f0efec', secondary: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', axis: '#383835', surface: '#1a1a19' },
  },
};

export function isDark() {
  return document.documentElement.dataset.theme === 'dark';
}

function colors() {
  const dark = isDark();
  return {
    series: dark ? PALETTE.dark.series : PALETTE.series,
    ink: dark ? PALETTE.ink.dark : PALETTE.ink.light,
  };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function el(tag, attrs = {}, text = null) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== null) node.textContent = text;
  return node;
}

function fmtPct(x, digits = 1) {
  if (x === null || x === undefined) return '—';
  return `${(100 * x).toFixed(digits)}%`;
}

// 通用 tooltip（单例）
let tooltipEl = null;
function ensureTooltip() {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'viz-tooltip';
    tooltipEl.setAttribute('role', 'status');
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}

function showTooltip(htmlRows, evt) {
  const tip = ensureTooltip();
  tip.replaceChildren();
  for (const row of htmlRows) {
    const div = document.createElement('div');
    div.className = 'viz-tooltip-row';
    if (row.swatch) {
      const sw = document.createElement('span');
      sw.className = 'viz-tooltip-swatch';
      sw.style.background = row.swatch;
      div.appendChild(sw);
    }
    const name = document.createElement('span');
    name.className = 'viz-tooltip-name';
    name.textContent = row.name;
    const val = document.createElement('strong');
    val.textContent = row.value;
    div.append(name, val);
    tip.appendChild(div);
  }
  tip.style.display = 'block';
  const pad = 12;
  const rect = tip.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + rect.width > window.innerWidth - 8) x = evt.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = evt.clientY - rect.height - pad;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
function hideTooltip() {
  if (tooltipEl) tooltipEl.style.display = 'none';
}

// 带不确定性区间的分组条形图：每条产线三根口径柱 + corrected 的 CI 标记
export function renderComparisonBars(container, lines, truthLookup = null) {
  const { series, ink } = colors();
  container.replaceChildren();
  const W = Math.max(640, lines.length * 118);
  const H = 340;
  const m = { top: 24, right: 16, bottom: 64, left: 52 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '各产线三种估计口径对比' });

  const maxV = Math.max(
    0.32,
    ...lines.flatMap((l) => [l.naive ?? 0, l.weighted ?? 0, l.corrected ?? 0])
  );
  const yMax = Math.ceil(maxV * 100) / 100;
  const y = (v) => m.top + ih * (1 - v / yMax);

  // 网格 + y 轴刻度
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (yMax * i) / ticks;
    const yy = y(v);
    svg.appendChild(el('line', { x1: m.left, x2: W - m.right, y1: yy, y2: yy, stroke: ink.grid, 'stroke-width': 1 }));
    const t = el('text', { x: m.left - 8, y: yy + 4, 'text-anchor': 'end', fill: ink.muted, 'font-size': 11 }, fmtPct(v, 0));
    svg.appendChild(t);
  }
  svg.appendChild(el('line', { x1: m.left, x2: m.left, y1: m.top, y2: m.top + ih, stroke: ink.axis, 'stroke-width': 1 }));

  const groupW = iw / lines.length;
  const barW = Math.min(18, (groupW - 18) / 3);
  const barColors = [ink.muted, series[0], series[2]];
  const barNames = ['naive 原始标签率', 'IPW 加权率', '纠正后缺陷率'];

  lines.forEach((line, gi) => {
    const gx = m.left + groupW * gi;
    const vals = [line.naive, line.weighted, line.corrected];
    vals.forEach((v, bi) => {
      if (v === null || v === undefined) return;
      const bx = gx + groupW / 2 - (barW * 3 + 8) / 2 + bi * (barW + 4);
      const by = y(v);
      const h = m.top + ih - by;
      const rect = el('rect', {
        x: bx,
        y: by,
        width: barW,
        height: Math.max(0, h),
        rx: bi === 2 ? 4 : 0,
        fill: barColors[bi],
        class: 'viz-bar',
        tabindex: 0,
      });
      rect.addEventListener('mousemove', (e) =>
        showTooltip(
          [
            { name: line.lineId, value: '' },
            { name: barNames[bi], value: fmtPct(v, 2), swatch: barColors[bi] },
            ...(line.ci && bi === 2 ? [{ name: '95% CI', value: `${fmtPct(line.ci[0], 1)} – ${fmtPct(line.ci[1], 1)}` }] : []),
            ...(truthLookup
              ? [{ name: '合成真值（仅验证）', value: fmtPct(truthLookup(line.lineId), 2) }]
              : []),
          ],
          e
        )
      );
      rect.addEventListener('mouseleave', hideTooltip);
      rect.addEventListener('focus', (e) => showTooltip([{ name: line.lineId, value: barNames[bi] }, { name: '比率', value: fmtPct(v, 2), swatch: barColors[bi] }], { clientX: bx, clientY: by }));
      rect.addEventListener('blur', hideTooltip);
      svg.appendChild(rect);
    });

    // corrected 的 CI 标记
    if (line.ci) {
      const cx = gx + groupW / 2 + barW + 2;
      svg.appendChild(el('line', { x1: cx, x2: cx, y1: y(line.ci[0]), y2: y(line.ci[1]), stroke: ink.primary, 'stroke-width': 1.5 }));
      svg.appendChild(el('line', { x1: cx - 4, x2: cx + 4, y1: y(line.ci[0]), y2: y(line.ci[0]), stroke: ink.primary, 'stroke-width': 1.5 }));
      svg.appendChild(el('line', { x1: cx - 4, x2: cx + 4, y1: y(line.ci[1]), y2: y(line.ci[1]), stroke: ink.primary, 'stroke-width': 1.5 }));
    }
    const label = el('text', { x: gx + groupW / 2, y: H - m.bottom + 18, 'text-anchor': 'middle', fill: ink.secondary, 'font-size': 12, 'font-weight': 600 }, line.lineId);
    svg.appendChild(label);
    const sub = el('text', { x: gx + groupW / 2, y: H - m.bottom + 34, 'text-anchor': 'middle', fill: ink.muted, 'font-size': 10 }, `n=${line.n}`);
    svg.appendChild(sub);
  });

  // 图例
  const legend = document.createElement('div');
  legend.className = 'viz-legend';
  barNames.forEach((name, i) => {
    const item = document.createElement('span');
    const sw = document.createElement('span');
    sw.className = 'viz-legend-swatch';
    sw.style.background = barColors[i];
    const tx = document.createElement('span');
    tx.textContent = name;
    item.append(sw, tx);
    legend.appendChild(item);
  });
  container.append(svg, legend);
}

// 预算收益对比条形图：三策略的方差下降/ESS 增益
export function renderBudgetBars(container, strategies) {
  const { series, ink } = colors();
  container.replaceChildren();
  const W = 560;
  const H = 280;
  const m = { top: 20, right: 16, bottom: 56, left: 56 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '预算策略预期方差下降对比' });

  const maxV = Math.max(...strategies.map((s) => s.expected.varianceReductionPct ?? 0));
  const yMax = Math.ceil(maxV / 10) * 10;
  const slot = iw / strategies.length;
  const barW = Math.min(24, slot * 0.42);
  const stratColor = [series[3], series[2], series[0]];
  const labels = { 'score-first': '高分优先', 'blind-spot': '盲区补查', balanced: '均衡混合' };

  for (let i = 0; i <= 4; i++) {
    const v = (yMax * i) / 4;
    const yy = m.top + ih * (1 - v / yMax);
    svg.appendChild(el('line', { x1: m.left, x2: W - m.right, y1: yy, y2: yy, stroke: ink.grid }));
    svg.appendChild(el('text', { x: m.left - 8, y: yy + 4, 'text-anchor': 'end', fill: ink.muted, 'font-size': 11 }, `${v.toFixed(0)}%`));
  }

  strategies.forEach((s, i) => {
    const v = s.expected.varianceReductionPct ?? 0;
    const bx = m.left + slot * i + slot / 2 - barW / 2;
    const by = m.top + ih * (1 - v / yMax);
    const rect = el('rect', {
      x: bx,
      y: by,
      width: barW,
      height: m.top + ih - by,
      rx: 4,
      fill: stratColor[i],
      class: 'viz-bar',
      tabindex: 0,
    });
    const rows = [
      { name: labels[s.strategy], value: '' },
      { name: '方差下降', value: `${v.toFixed(1)}%`, swatch: stratColor[i] },
      { name: 'ESS 增益', value: `+${s.expected.essGain.toFixed(0)}` },
      { name: '盲区命中', value: `${s.expected.blindSpotHits} 件` },
    ];
    rect.addEventListener('mousemove', (e) => showTooltip(rows, e));
    rect.addEventListener('mouseleave', hideTooltip);
    rect.addEventListener('focus', (e) => showTooltip(rows, { clientX: bx, clientY: by }));
    rect.addEventListener('blur', hideTooltip);
    svg.appendChild(rect);

    const valueLabel = el('text', { x: bx + barW / 2, y: by - 6, 'text-anchor': 'middle', fill: ink.primary, 'font-size': 12, 'font-weight': 600 }, `${v.toFixed(1)}%`);
    svg.appendChild(valueLabel);
    const nameLabel = el('text', { x: bx + barW / 2, y: H - m.bottom + 20, 'text-anchor': 'middle', fill: ink.secondary, 'font-size': 12 }, labels[s.strategy]);
    svg.appendChild(nameLabel);
  });
  container.appendChild(svg);
}

// 批次覆盖水平条：显示每批规模、复查数与缺口
export function renderCoverageBars(container, coverageRows) {
  const { series, ink } = colors();
  container.replaceChildren();
  const rowH = 34;
  const W = 680;
  const H = Math.max(180, coverageRows.length * rowH + 40);
  const m = { top: 12, right: 70, bottom: 28, left: 110 };
  const iw = W - m.left - m.right;
  const maxSize = Math.max(...coverageRows.map((r) => r.size));
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '批次复查覆盖情况' });

  coverageRows.forEach((r, i) => {
    const y0 = m.top + i * rowH;
    const fullW = (r.size / maxSize) * iw;
    const revW = r.reviewedCount ? (r.reviewedCount / maxSize) * iw : 0;
    // 底条（总规模，表面灰）
    svg.appendChild(el('rect', { x: m.left, y: y0 + 6, width: fullW, height: 16, rx: 4, fill: ink.grid }));
    // 复查覆盖
    const fill = r.covered ? series[2] : PALETTE.status.critical;
    svg.appendChild(el('rect', { x: m.left, y: y0 + 6, width: Math.max(revW, r.covered ? 4 : 0), height: 16, rx: 4, fill }));
    const name = el('text', { x: m.left - 8, y: y0 + 18, 'text-anchor': 'end', fill: ink.secondary, 'font-size': 11 }, r.batchId);
    svg.appendChild(name);
    const info = el(
      'text',
      { x: m.left + fullW + 8, y: y0 + 18, fill: r.covered ? ink.muted : PALETTE.status.critical, 'font-size': 11 },
      r.covered ? `${r.reviewedCount}/${r.size}` : `0/${r.size} 无抽样机会`
    );
    svg.appendChild(info);
    const hit = el('rect', { x: m.left - 100, y: y0, width: iw + 170, height: rowH - 4, fill: 'transparent', tabindex: 0, class: 'viz-hit' });
    hit.addEventListener('mousemove', (e) =>
      showTooltip(
        [
          { name: r.batchId, value: '' },
          { name: '状态', value: r.covered ? '已覆盖' : r.gapReason === 'zero-inclusion-probability' ? '零抽样概率' : '无实现样本', swatch: fill },
          { name: '复查/规模', value: `${r.reviewedCount} / ${r.size}` },
          ...(r.partialInterval ? [{ name: '缺陷率区间', value: `${fmtPct(r.partialInterval[0], 0)} – ${fmtPct(r.partialInterval[1], 0)}` }] : []),
        ],
        e
      )
    );
    hit.addEventListener('mouseleave', hideTooltip);
    hit.addEventListener('focus', (e) => showTooltip([{ name: r.batchId, value: r.covered ? '已覆盖' : '未覆盖' }], { clientX: m.left, clientY: y0 }));
    hit.addEventListener('blur', hideTooltip);
    svg.appendChild(hit);
  });
  container.appendChild(svg);
}

// 简单表格视图（无障碍替代）
export function renderTable(container, columns, rows) {
  const table = document.createElement('table');
  table.className = 'viz-table';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const c of columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = c.label;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const c of columns) {
      const td = document.createElement('td');
      const v = c.render ? c.render(row) : row[c.key];
      if (v && typeof v === 'object' && 'tagName' in v) td.appendChild(v);
      else td.textContent = v ?? '—';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.replaceChildren(table);
}

export { fmtPct };

/*
 * Chart.js 4 theme + helpers for automotive dashboards.
 * Load Chart.js pinned (e.g. https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js),
 * then call applyChartTheme(Chart) once before creating charts.
 *
 * Colors come from the CSS tokens at runtime, so light/dark mode and a brand
 * swap need no JavaScript changes. Re-run applyChartTheme after a theme toggle
 * and call chart.update().
 */

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function applyChartTheme(Chart) {
  const text = cssVar('--text-muted', '#5f6973');
  const grid = cssVar('--chart-grid', '#e8ebee');
  Chart.defaults.font.family = cssVar('--font-ui', 'Segoe UI, system-ui, sans-serif');
  Chart.defaults.font.size = 12;
  Chart.defaults.color = text;
  Chart.defaults.borderColor = grid;
  Chart.defaults.animation = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 160 };
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.plugins.legend.display = false; // label lines directly; turn on only for > 4 series
  Chart.defaults.plugins.tooltip.backgroundColor = cssVar('--ink-900', '#15181b');
  Chart.defaults.plugins.tooltip.titleColor = cssVar('--paper', '#ffffff');
  Chart.defaults.plugins.tooltip.bodyColor = cssVar('--paper', '#ffffff');
  Chart.defaults.plugins.tooltip.padding = 8;
  Chart.defaults.plugins.tooltip.cornerRadius = 4;
  Chart.defaults.plugins.tooltip.displayColors = false;
  Chart.defaults.elements.bar.borderRadius = 2;
  Chart.defaults.elements.line.borderWidth = 2;
  Chart.defaults.elements.point.radius = 0;
  Chart.defaults.elements.point.hoverRadius = 4;
  Chart.defaults.scale.grid.drawTicks = false;
  Chart.defaults.scales.linear.grid = { color: grid };
  Chart.defaults.scales.category.grid = { display: false };
  if (!Chart.registry.plugins.get('refLines')) Chart.register(refLinesPlugin);
}

/** Series colors in token order; the first is the accent. */
function seriesColors() {
  return ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5'].map((v) => cssVar(v, '#24609c'));
}

/**
 * Horizontal reference lines (targets, control limits):
 *   options.plugins.refLines = { lines: [{ y: 95, label: 'Target 95 %', color: '--ok', dash: [4, 4] }] }
 */
const refLinesPlugin = {
  id: 'refLines',
  afterDatasetsDraw(chart, _args, opts) {
    const lines = (opts && opts.lines) || [];
    const yScale = chart.scales.y;
    if (!yScale || !lines.length) return;
    const { ctx, chartArea } = chart;
    ctx.save();
    for (const l of lines) {
      const y = yScale.getPixelForValue(l.y);
      if (y < chartArea.top || y > chartArea.bottom) continue;
      const color = l.color && l.color.startsWith('--') ? cssVar(l.color, '#5f6973') : l.color || cssVar('--ink-500', '#5f6973');
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash(l.dash || [4, 4]);
      ctx.beginPath();
      ctx.moveTo(chartArea.left, y);
      ctx.lineTo(chartArea.right, y);
      ctx.stroke();
      if (l.label) {
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.font = `600 11px ${cssVar('--font-ui', 'sans-serif')}`;
        ctx.textAlign = 'right';
        ctx.fillText(l.label, chartArea.right - 4, y - 4);
      }
    }
    ctx.restore();
  },
};

/** Pareto: sort descending, bars + cumulative % on a second axis. Returns a Chart.js config. */
function paretoConfig(items, { maxBars = 10, valueLabel = 'Defects' } = {}) {
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, maxBars);
  const rest = sorted.slice(maxBars).reduce((n, i) => n + i.value, 0);
  if (rest > 0) top.push({ label: 'Other', value: rest });
  const total = top.reduce((n, i) => n + i.value, 0) || 1;
  let running = 0;
  const cumulative = top.map((i) => Math.round(((running += i.value) / total) * 1000) / 10);
  const [accent, muted] = [cssVar('--series-1', '#24609c'), cssVar('--series-muted', '#a7afb7')];
  return {
    data: {
      labels: top.map((i) => i.label),
      datasets: [
        // Highlight the vital few (up to ~80 % cumulative); mute the rest.
        { type: 'bar', order: 2, label: valueLabel, data: top.map((i) => i.value), backgroundColor: cumulative.map((c, idx) => (idx === 0 || cumulative[idx - 1] < 80 ? accent : muted)), yAxisID: 'y' },
        { type: 'line', order: 1, label: 'Cumulative %', data: cumulative, borderColor: cssVar('--ink-600', '#4a535c'), yAxisID: 'y2', tension: 0 },
      ],
    },
    options: {
      scales: {
        y: { beginAtZero: true, title: { display: true, text: valueLabel } },
        y2: { position: 'right', min: 0, max: 100, grid: { display: false }, ticks: { callback: (v) => `${v} %` } },
      },
      plugins: { refLines: { lines: [] } },
    },
  };
}

/** Individuals (I-MR) control limits: mean ± 2.66 × average moving range. */
function controlLimits(values) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  let mr = 0;
  for (let i = 1; i < v.length; i++) mr += Math.abs(v[i] - v[i - 1]);
  const mrBar = mr / (v.length - 1);
  return { mean, ucl: mean + 2.66 * mrBar, lcl: Math.max(0, mean - 2.66 * mrBar) };
}

/** Run/control chart config with mean and limits drawn as reference lines; out-of-limit points marked red. */
function controlChartConfig(labels, values, { unit = '', target } = {}) {
  const lim = controlLimits(values);
  const stop = cssVar('--stop', '#c0262d');
  const lines = [];
  if (lim) {
    lines.push({ y: lim.ucl, label: `UCL ${lim.ucl.toFixed(2)}${unit}`, color: '--stop' });
    lines.push({ y: lim.mean, label: `Mean ${lim.mean.toFixed(2)}${unit}`, color: '--ink-500', dash: [2, 3] });
    lines.push({ y: lim.lcl, label: `LCL ${lim.lcl.toFixed(2)}${unit}`, color: '--stop' });
  }
  if (target !== undefined) lines.push({ y: target, label: `Target ${target}${unit}`, color: '--ok' });
  return {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          data: values,
          borderColor: cssVar('--series-1', '#24609c'),
          pointRadius: values.map((x) => (lim && (x > lim.ucl || x < lim.lcl) ? 4 : 2)),
          pointBackgroundColor: values.map((x) => (lim && (x > lim.ucl || x < lim.lcl) ? stop : cssVar('--series-1', '#24609c'))),
        },
      ],
    },
    options: { plugins: { refLines: { lines } }, scales: { y: { title: { display: Boolean(unit), text: unit.trim() } } } },
  };
}

/** Competency radar: required level dashed outline, current level filled. Scale fixed 0-5. */
function competencyRadarConfig(axes, current, required) {
  const accent = cssVar('--series-1', '#24609c');
  return {
    type: 'radar',
    data: {
      labels: axes,
      datasets: [
        { label: 'Required', data: required, borderColor: cssVar('--ink-500', '#5f6973'), borderDash: [4, 4], backgroundColor: 'transparent', pointRadius: 0 },
        { label: 'Current', data: current, borderColor: accent, backgroundColor: `${accent}26`, pointRadius: 2 },
      ],
    },
    options: {
      plugins: { legend: { display: true, position: 'bottom' } },
      scales: { r: { min: 0, max: 5, ticks: { stepSize: 1, backdropColor: 'transparent' }, grid: { color: cssVar('--chart-grid', '#e8ebee') }, angleLines: { color: cssVar('--chart-grid', '#e8ebee') } } },
    },
  };
}

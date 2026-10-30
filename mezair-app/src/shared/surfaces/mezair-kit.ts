// mezair-kit: a small, dependency-free helper served into sketch frames.
// window.MezairKit = { chart, table, code, diff }, themed from --mezair-* tokens.

export const MEZAIR_KIT_VERSION = '1.0.0';

export const MEZAIR_KIT_SOURCE = String.raw`(function () {
  if (window.MezairKit) return;
  var VERSION = '${MEZAIR_KIT_VERSION}';
  var css = [
    '.ak-chart{display:block;width:100%;font-family:var(--mezair-font-sans);color:var(--mezair-ink-secondary)}',
    '.ak-chart text{font-size:11px;fill:var(--mezair-ink-muted)}',
    '.ak-chart .ak-grid{stroke:var(--mezair-border);stroke-width:1;shape-rendering:crispEdges}',
    '.ak-legend{display:flex;flex-wrap:wrap;gap:4px 16px;margin:8px 0 0;padding:0;list-style:none;font-size:12px;color:var(--mezair-ink-secondary)}',
    '.ak-legend li{display:inline-flex;align-items:center;gap:6px}',
    '.ak-legend i{display:inline-block;width:10px;height:10px;border-radius:2px}',
    '.ak-caption{margin:0 0 8px;font-size:13px;font-weight:600;color:var(--mezair-ink)}',
    '.ak-table-wrap{overflow-x:auto}',
    '.ak-table{width:100%;border-collapse:collapse;font-size:13px}',
    '.ak-table caption{text-align:left;padding:0 0 8px;font-weight:600;color:var(--mezair-ink)}',
    '.ak-table th{text-align:left;font-weight:600;color:var(--mezair-ink);background:var(--mezair-surface);border-bottom:1px solid var(--mezair-border);padding:8px 12px;white-space:nowrap}',
    '.ak-table td{padding:7px 12px;color:var(--mezair-ink-secondary);border-bottom:1px solid var(--mezair-border);vertical-align:top}',
    '.ak-table tbody tr:nth-child(even) td{background:color-mix(in srgb,var(--mezair-surface) 60%,transparent)}',
    '.ak-table .ak-num{text-align:right;font-variant-numeric:tabular-nums}',
    '.ak-code,.ak-diff{margin:0;padding:12px 16px;overflow-x:auto;border:1px solid var(--mezair-border);border-radius:var(--mezair-radius-lg);background:var(--mezair-code-bg);color:var(--mezair-code-ink);font:12.5px/1.6 var(--mezair-font-mono);tab-size:2}',
    '.ak-diff{padding:8px 0}',
    '.ak-diff span{display:block;padding:0 16px;white-space:pre}',
    '.ak-diff .ak-add{background:color-mix(in srgb,var(--mezair-success) 16%,transparent)}',
    '.ak-diff .ak-del{background:color-mix(in srgb,var(--mezair-error) 16%,transparent)}',
    '.ak-diff .ak-hunk{color:var(--mezair-info)}',
    '.ak-diff .ak-meta{color:var(--mezair-ink-muted)}'
  ].join('');
  var style = document.createElement('style');
  style.id = 'mezair-kit-style';
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  function resolve(el) {
    var node = typeof el === 'string' ? document.querySelector(el) : el;
    if (!node) throw new Error('MezairKit: element not found');
    return node;
  }
  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function seriesColor(index) { return 'var(--mezair-series-' + ((index % 6) + 1) + ')'; }
  function formatNumber(value) {
    var abs = Math.abs(value);
    if (abs >= 1e9) return (value / 1e9).toFixed(abs >= 1e10 ? 0 : 1) + 'B';
    if (abs >= 1e6) return (value / 1e6).toFixed(abs >= 1e7 ? 0 : 1) + 'M';
    if (abs >= 1e3) return (value / 1e3).toFixed(abs >= 1e4 ? 0 : 1) + 'k';
    return String(Math.round(value * 100) / 100);
  }
  function niceStep(range, count) {
    var rough = range / Math.max(1, count);
    var power = Math.pow(10, Math.floor(Math.log10(rough || 1)));
    var fraction = rough / power;
    var nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
    return nice * power;
  }

  function chart(el, spec) {
    var node = resolve(el);
    spec = spec || {};
    var type = spec.type === 'line' || spec.type === 'area' ? spec.type : 'bar';
    var labels = (spec.labels || []).map(String);
    var series = (spec.series || []).map(function (s, i) {
      return { name: s.name || 'Series ' + (i + 1), values: (s.values || []).map(Number), color: s.color || seriesColor(i) };
    });
    var height = Math.max(120, Math.min(800, Number(spec.height) || 240));
    var format = typeof spec.format === 'function' ? spec.format : formatNumber;
    function render() {
      var width = Math.max(240, Math.floor(node.clientWidth || 600));
      var pad = { top: 12, right: 12, bottom: 28, left: 44 };
      var plotW = width - pad.left - pad.right;
      var plotH = height - pad.top - pad.bottom;
      var all = [];
      series.forEach(function (s) { s.values.forEach(function (v) { if (isFinite(v)) all.push(v); }); });
      var min = Math.min(0, Math.min.apply(null, all.length ? all : [0]));
      var max = Math.max(0, Math.max.apply(null, all.length ? all : [1]));
      if (max === min) max = min + 1;
      var step = niceStep(max - min, 4);
      var lo = Math.floor(min / step) * step;
      var hi = Math.ceil(max / step) * step;
      function y(v) { return pad.top + plotH - ((v - lo) / (hi - lo)) * plotH; }
      var count = Math.max(1, labels.length || (series[0] ? series[0].values.length : 1));
      var band = plotW / count;
      function x(i) { return pad.left + band * i + band / 2; }
      var title = spec.title || 'Chart';
      var parts = ['<svg class="ak-chart" role="img" aria-label="' + esc(title) + '" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '" xmlns="http://www.w3.org/2000/svg">', '<title>' + esc(title) + '</title>'];
      for (var t = lo; t <= hi + step / 2; t += step) {
        var ty = Math.round(y(t)) + 0.5;
        parts.push('<line class="ak-grid" x1="' + pad.left + '" x2="' + (width - pad.right) + '" y1="' + ty + '" y2="' + ty + '"' + (t === 0 ? '' : ' stroke-opacity="0.5"') + '/>');
        parts.push('<text x="' + (pad.left - 6) + '" y="' + (ty + 4) + '" text-anchor="end">' + esc(format(t)) + '</text>');
      }
      var every = Math.max(1, Math.ceil((count * 56) / plotW));
      for (var li = 0; li < count; li++) {
        if (li % every !== 0) continue;
        parts.push('<text x="' + x(li) + '" y="' + (height - 8) + '" text-anchor="middle">' + esc(labels[li] !== undefined ? labels[li] : li + 1) + '</text>');
      }
      if (type === 'bar') {
        var groupW = band * 0.72;
        var barW = groupW / Math.max(1, series.length);
        series.forEach(function (s, si) {
          s.values.forEach(function (v, i) {
            if (!isFinite(v)) return;
            var top = y(Math.max(0, v));
            var h = Math.max(1, Math.abs(y(v) - y(0)));
            var bx = pad.left + band * i + (band - groupW) / 2 + barW * si;
            parts.push('<rect x="' + bx.toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + Math.max(1, barW - 2).toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2" style="fill:' + s.color + '"><title>' + esc(s.name + ' · ' + (labels[i] || i + 1) + ': ' + format(v)) + '</title></rect>');
          });
        });
      } else {
        series.forEach(function (s) {
          var points = [];
          s.values.forEach(function (v, i) { if (isFinite(v)) points.push([x(i), y(v)]); });
          if (!points.length) return;
          var line = points.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join('');
          if (type === 'area') {
            var base = y(Math.max(lo, 0)).toFixed(1);
            parts.push('<path d="' + line + 'L' + points[points.length - 1][0].toFixed(1) + ' ' + base + 'L' + points[0][0].toFixed(1) + ' ' + base + 'Z" style="fill:' + s.color + ';fill-opacity:0.18;stroke:none"/>');
          }
          parts.push('<path d="' + line + '" style="fill:none;stroke:' + s.color + ';stroke-width:2;stroke-linejoin:round;stroke-linecap:round"/>');
          points.forEach(function (p, i) {
            parts.push('<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3" style="fill:' + s.color + '"><title>' + esc(s.name + ' · ' + (labels[i] || i + 1) + ': ' + format(s.values[i])) + '</title></circle>');
          });
        });
      }
      parts.push('</svg>');
      var html = (spec.title ? '<p class="ak-caption">' + esc(spec.title) + '</p>' : '') + parts.join('');
      if (series.length > 1 || spec.legend) {
        html += '<ul class="ak-legend">' + series.map(function (s) { return '<li><i style="background:' + s.color + '"></i>' + esc(s.name) + '</li>'; }).join('') + '</ul>';
      }
      node.innerHTML = html;
    }
    render();
    if (typeof ResizeObserver === 'function') {
      var lastWidth = node.clientWidth;
      new ResizeObserver(function () {
        if (node.clientWidth === lastWidth) return;
        lastWidth = node.clientWidth;
        render();
      }).observe(node);
    }
    return node;
  }

  function table(el, rows, opts) {
    var node = resolve(el);
    rows = rows || [];
    opts = opts || {};
    var columns = (opts.columns || (rows[0] && !Array.isArray(rows[0]) ? Object.keys(rows[0]) : [])).map(function (c, i) {
      return typeof c === 'string' ? { key: c, label: c } : { key: c.key !== undefined ? c.key : i, label: c.label || String(c.key), align: c.align };
    });
    var body = rows;
    if (!columns.length && Array.isArray(rows[0])) {
      columns = rows[0].map(function (label, i) { return { key: i, label: String(label) }; });
      body = rows.slice(1);
    }
    var tableEl = document.createElement('table');
    tableEl.className = 'ak-table';
    if (opts.caption) {
      var caption = document.createElement('caption');
      caption.textContent = opts.caption;
      tableEl.appendChild(caption);
    }
    function numeric(column) {
      if (column.align) return column.align === 'right';
      return body.length > 0 && body.every(function (row) { var v = row[column.key]; return v === null || v === undefined || v === '' || typeof v === 'number'; });
    }
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    columns.forEach(function (column) {
      var th = document.createElement('th');
      th.scope = 'col';
      th.textContent = column.label;
      if (numeric(column)) th.className = 'ak-num';
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    tableEl.appendChild(thead);
    var tbody = document.createElement('tbody');
    body.forEach(function (row) {
      var tr = document.createElement('tr');
      columns.forEach(function (column) {
        var td = document.createElement('td');
        var value = row[column.key];
        td.textContent = value === null || value === undefined ? '' : typeof value === 'number' ? value.toLocaleString() : String(value);
        if (numeric(column)) td.className = 'ak-num';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    tableEl.appendChild(tbody);
    var wrap = document.createElement('div');
    wrap.className = 'ak-table-wrap';
    wrap.appendChild(tableEl);
    node.replaceChildren(wrap);
    return node;
  }

  function code(el, src) {
    var node = resolve(el);
    var pre = document.createElement('pre');
    pre.className = 'ak-code';
    var codeEl = document.createElement('code');
    codeEl.textContent = String(src || '');
    pre.appendChild(codeEl);
    node.replaceChildren(pre);
    return node;
  }

  function diff(el, patch) {
    var node = resolve(el);
    var pre = document.createElement('pre');
    pre.className = 'ak-diff';
    String(patch || '').replace(/\r\n/g, '\n').split('\n').forEach(function (line, index, lines) {
      if (index === lines.length - 1 && line === '') return;
      var span = document.createElement('span');
      if (/^(\+\+\+|---|diff |index )/.test(line)) span.className = 'ak-meta';
      else if (line.charAt(0) === '+') span.className = 'ak-add';
      else if (line.charAt(0) === '-') span.className = 'ak-del';
      else if (line.indexOf('@@') === 0) span.className = 'ak-hunk';
      span.textContent = line || ' ';
      pre.appendChild(span);
    });
    node.replaceChildren(pre);
    return node;
  }

  window.MezairKit = Object.freeze({ version: VERSION, chart: chart, table: table, code: code, diff: diff });
})();`;

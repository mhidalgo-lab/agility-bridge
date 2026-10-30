// SPDX-License-Identifier: Apache-2.0
// The page script of the MCP Apps views (P8-03, THREAT_MODEL T27), as one string: it ships inside each view's HTML and
// its SHA-256 goes into the page's Content-Security-Policy, so nothing else can run. It has no dependency and does
// only this: the `ui/initialize` handshake with the host, then draw the `structuredContent` of the tool result it is
// handed. Every piece of text, Agility's included, reaches the page through `textContent`; attributes only ever hold
// fixed words or numbers that went through `Number()`. It never reads the network, storage or the URL, and never builds
// markup from a string (no `innerHTML`, `eval` or `Function`): the test in `test/apps/views.test.ts` pins all of that.

/** The script shared by both views. `VIEW` (set by the page) picks the drawing. */
export const VIEW_SCRIPT = `'use strict';
(function () {
  var SVGNS = 'http://www.w3.org/2000/svg';
  var VIEW = document.documentElement.getAttribute('data-view');
  var root = document.getElementById('root');
  var CATEGORY_LABELS = { not_started: 'Not started', in_progress: 'In progress', completed: 'Completed', unknown: 'Unknown' };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.setAttribute('class', cls);
    if (text !== undefined) n.textContent = String(text);
    return n;
  }
  function sv(tag, attrs, text) {
    var n = document.createElementNS(SVGNS, tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, String(attrs[k]));
    if (text !== undefined) n.textContent = String(text);
    return n;
  }
  function num(v) {
    var n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return isFinite(n) ? n : undefined;
  }
  function round(n) { return Math.round(n * 100) / 100; }
  function clear() { while (root.firstChild) root.removeChild(root.firstChild); }
  function message(text) { clear(); root.appendChild(el('p', 'note', text)); }
  function day(v) {
    var t = typeof v === 'string' ? Date.parse(v) : NaN;
    return isNaN(t) ? undefined : t;
  }
  function dayLabel(t) { return new Date(t).toISOString().slice(5, 10); }
  function sprintName(data) {
    var s = data && typeof data.sprint === 'object' && data.sprint !== null ? data.sprint : null;
    return s !== null && typeof s.name === 'string' ? s.name : '';
  }
  function heading(data, fixed) {
    var h = el('h1', '', fixed);
    var name = sprintName(data);
    if (name !== '') { h.appendChild(document.createTextNode(': ')); h.appendChild(el('span', 'name', name)); }
    return h;
  }
  function table(head, rows) {
    var d = el('details', 'data');
    d.appendChild(el('summary', '', 'Data'));
    var t = el('table');
    var tr = el('tr');
    head.forEach(function (c) { tr.appendChild(el('th', '', c)); });
    t.appendChild(tr);
    rows.forEach(function (r) {
      var row = el('tr');
      r.forEach(function (c) { row.appendChild(el('td', '', c)); });
      t.appendChild(row);
    });
    d.appendChild(t);
    return d;
  }

  function burndown(data) {
    var raw = data && Array.isArray(data.burndown) ? data.burndown : [];
    var pts = [];
    raw.forEach(function (p) {
      if (p === null || typeof p !== 'object') return;
      var t = day(p.at);
      var r = num(p.remaining);
      if (t === undefined || r === undefined) return;
      pts.push({ t: t, remaining: r, ideal: num(p.ideal) });
    });
    if (pts.length < 2) return message('This result has no burndown to draw. The text above has the figures.');
    pts.sort(function (a, b) { return a.t - b.t; });
    var W = 520, H = 260, L = 44, R = 12, T = 12, B = 28;
    var t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    var max = 0;
    pts.forEach(function (p) { max = Math.max(max, p.remaining, p.ideal === undefined ? 0 : p.ideal); });
    if (max <= 0) max = 1;
    function x(t) { return round(L + (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * (W - L - R))); }
    function y(v) { return round(T + (1 - v / max) * (H - T - B)); }
    function line(key, cls) {
      var d = '';
      pts.forEach(function (p) {
        if (p[key] === undefined) return;
        d += (d === '' ? 'M' : 'L') + x(p.t) + ' ' + y(p[key]);
      });
      return d === '' ? null : sv('path', { d: d, fill: 'none', 'class': cls });
    }
    var svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'class': 'chart' });
    var last = pts[pts.length - 1];
    svg.appendChild(sv('title', {}, 'Burndown: ' + pts.length + ' points, ' + round(last.remaining) + ' remaining at the last point'));
    svg.appendChild(sv('line', { x1: L, y1: T, x2: L, y2: H - B, 'class': 'axis' }));
    svg.appendChild(sv('line', { x1: L, y1: H - B, x2: W - R, y2: H - B, 'class': 'axis' }));
    svg.appendChild(sv('text', { x: L - 6, y: y(max) + 4, 'text-anchor': 'end', 'class': 'tick' }, round(max)));
    svg.appendChild(sv('text', { x: L - 6, y: y(0) + 4, 'text-anchor': 'end', 'class': 'tick' }, 0));
    svg.appendChild(sv('text', { x: L, y: H - 8, 'text-anchor': 'start', 'class': 'tick' }, dayLabel(t0)));
    svg.appendChild(sv('text', { x: W - R, y: H - 8, 'text-anchor': 'end', 'class': 'tick' }, dayLabel(t1)));
    var ideal = line('ideal', 'ideal');
    if (ideal) svg.appendChild(ideal);
    var actual = line('remaining', 'actual');
    if (actual) svg.appendChild(actual);
    clear();
    root.appendChild(heading(data, 'Burndown'));
    root.appendChild(svg);
    var legend = el('p', 'legend');
    legend.appendChild(el('span', 'key actual', 'Remaining'));
    legend.appendChild(el('span', 'key ideal', 'Ideal'));
    root.appendChild(legend);
    root.appendChild(table(['Date (UTC)', 'Remaining', 'Ideal'], pts.map(function (p) {
      return [new Date(p.t).toISOString().slice(0, 10), round(p.remaining), p.ideal === undefined ? '' : round(p.ideal)];
    })));
  }

  function distribution(data) {
    var raw = data && Array.isArray(data.byStatusCategory) ? data.byStatusCategory : [];
    var rows = [];
    raw.forEach(function (c) {
      if (c === null || typeof c !== 'object') return;
      var n = num(c.itemCount);
      if (n === undefined || n < 0) return;
      var label = typeof c.category === 'string' ? (Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, c.category) ? CATEGORY_LABELS[c.category] : c.category) : 'Unknown';
      rows.push({ label: label, count: n });
    });
    if (rows.length === 0) return message('This result has no status counts to draw. The text above has the figures.');
    var total = 0, max = 0;
    rows.forEach(function (r) { total += r.count; max = Math.max(max, r.count); });
    if (max <= 0) max = 1;
    var W = 520, ROW = 30, LABEL = 120, H = rows.length * ROW + 8;
    var svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'class': 'chart' });
    svg.appendChild(sv('title', {}, 'Items by status category: ' + total + ' in all'));
    rows.forEach(function (r, i) {
      var top = 4 + i * ROW;
      var w = round((r.count / max) * (W - LABEL - 48));
      svg.appendChild(sv('text', { x: 0, y: top + 17, 'class': 'tick' }, r.label));
      svg.appendChild(sv('rect', { x: LABEL, y: top + 3, width: w, height: ROW - 10, 'class': 'bar' }));
      svg.appendChild(sv('text', { x: LABEL + w + 6, y: top + 17, 'class': 'tick' }, r.count));
    });
    clear();
    root.appendChild(heading(data, 'Status distribution'));
    root.appendChild(svg);
    root.appendChild(table(['Status category', 'Items'], rows.map(function (r) { return [r.label, r.count]; })));
  }

  function draw(result) {
    var data = result && typeof result === 'object' ? result.structuredContent : undefined;
    if (data === null || typeof data !== 'object') return message('This result carries no data to draw.');
    if (VIEW === 'sprint-burndown') burndown(data); else distribution(data);
    resize();
  }

  function send(m) { window.parent.postMessage(m, '*'); }
  function resize() {
    send({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { width: Math.ceil(document.documentElement.scrollWidth), height: Math.ceil(document.documentElement.scrollHeight) } });
  }
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var m = e.data;
    if (m === null || typeof m !== 'object' || m.jsonrpc !== '2.0') return;
    if (m.method === 'ui/notifications/tool-result') draw(m.params);
    else if (m.method === 'ui/resource-teardown' && m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
    else if (m.id === 1 && m.method === undefined && m.result !== undefined) send({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  });
  send({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { appCapabilities: {}, appInfo: { name: 'agility-bridge', version: '1' }, protocolVersion: '2026-01-26' } });
  message('Waiting for the result…');
})();
`;

/** The stylesheet shared by both views: system colours and a dark scheme, no external font or image. */
export const VIEW_STYLE = `:root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --bg: transparent; --line: #d1d9e0; --a: #0969da; --b: #8250df; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --muted: #9198a1; --line: #3d444d; --a: #4493f8; --b: #ab7df8; } }
html, body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; }
#root { padding: 12px 16px; }
h1 { font-size: 15px; margin: 0 0 8px; font-weight: 600; }
.name { font-weight: 400; }
.note { color: var(--muted); margin: 0; }
.chart { width: 100%; max-width: 560px; height: auto; display: block; }
.axis { stroke: var(--line); stroke-width: 1; }
.tick { fill: var(--muted); font-size: 11px; }
.actual { stroke: var(--a); stroke-width: 2.5; }
.ideal { stroke: var(--muted); stroke-width: 1.5; stroke-dasharray: 5 4; }
.bar { fill: var(--a); }
.legend { margin: 6px 0; color: var(--muted); font-size: 12px; }
.key { margin-right: 14px; }
.key::before { content: ''; display: inline-block; width: 18px; height: 0; border-top: 2px solid var(--a); vertical-align: middle; margin-right: 6px; }
.key.ideal::before { border-top: 2px dashed var(--muted); }
.data { margin-top: 8px; font-size: 12px; color: var(--muted); }
table { border-collapse: collapse; margin-top: 6px; }
th, td { border-bottom: 1px solid var(--line); padding: 2px 12px 2px 0; text-align: left; font-variant-numeric: tabular-nums; }
@media (forced-colors: active) { .actual, .ideal, .axis { stroke: CanvasText; } .bar { fill: Highlight; } }
`;

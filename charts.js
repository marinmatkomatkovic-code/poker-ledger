/* ==========================================================================
   charts.js — hand-drawn SVG, no library

   Charts are measured and drawn at device pixels rather than scaled from a
   fixed viewBox, so axis labels stay legible on a phone. Every chart is
   redrawn on resize.

   Colour: profit and loss use a validated diverging pair (teal / orange-red
   with a gray midpoint) instead of green/red, which red-green colourblind
   readers cannot separate. Sign is also carried by direction and by a
   +/- prefix on every label, so colour is never the only channel.
   ========================================================================== */

window.PL = window.PL || {};

PL.Charts = (function () {
  "use strict";

  var mounted = [];
  var uid = 0;
  var resizeTimer = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function scale(d0, d1, r0, r1) {
    var span = (d1 - d0) || 1;
    return function (v) { return r0 + ((v - d0) / span) * (r1 - r0); };
  }

  /** Round axis bounds outward to a readable step. */
  function niceDomain(min, max, count) {
    if (min === max) { min -= 1; max += 1; }
    var raw = (max - min) / (count || 4);
    var mag = Math.pow(10, Math.floor(Math.log10(Math.abs(raw) || 1)));
    var norm = raw / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    return { lo: Math.floor(min / step) * step, hi: Math.ceil(max / step) * step, step: step };
  }

  function ticks(lo, hi, step) {
    var out = [];
    for (var v = lo; v <= hi + step / 1000; v += step) out.push(Math.abs(v) < step / 1000 ? 0 : v);
    return out;
  }

  /** A bar with its far end rounded and its baseline end square. */
  function barPath(x, yTop, w, h, r, up) {
    if (h <= 0.5) return "M" + x + "," + yTop + "h" + w;
    r = Math.min(r, w / 2, h);
    if (up) {
      return "M" + x + "," + (yTop + h) +
        "V" + (yTop + r) + "a" + r + "," + r + " 0 0 1 " + r + ",-" + r +
        "h" + (w - 2 * r) + "a" + r + "," + r + " 0 0 1 " + r + "," + r +
        "V" + (yTop + h) + "Z";
    }
    return "M" + x + "," + yTop +
      "V" + (yTop + h - r) + "a" + r + "," + r + " 0 0 0 " + r + "," + r +
      "h" + (w - 2 * r) + "a" + r + "," + r + " 0 0 0 " + r + ",-" + r +
      "V" + yTop + "Z";
  }

  function fewLabels(n, max) {
    if (n <= max) return null;
    var step = Math.ceil(n / max);
    return step;
  }

  /* ---------------------------------------------------------------- line */

  /** Running profit over nights: line, with the area split by sign. */
  function cumulative(w, spec) {
    var data = spec.data;
    var fmt = spec.fmt || String;
    var H = spec.height || 210;
    var m = { t: 12, r: 16, b: 26, l: 56 };
    if (!data.length) return empty(w, H, "No closed nights yet");

    var iw = Math.max(60, w - m.l - m.r);
    var ih = H - m.t - m.b;

    var vals = data.map(function (d) { return d.cum; }).concat([0]);
    var dom = niceDomain(Math.min.apply(null, vals), Math.max.apply(null, vals), 4);
    var x = scale(0, Math.max(1, data.length - 1), m.l, m.l + iw);
    var y = scale(dom.lo, dom.hi, m.t + ih, m.t);
    var y0 = y(0);
    var id = "c" + (++uid);

    var line = data.map(function (d, i) { return (i ? "L" : "M") + x(i).toFixed(1) + "," + y(d.cum).toFixed(1); }).join("");
    var area = line + "L" + x(data.length - 1).toFixed(1) + "," + y0.toFixed(1) + "L" + x(0).toFixed(1) + "," + y0.toFixed(1) + "Z";

    var s = '<svg class="chart-svg" width="' + w + '" height="' + H + '" viewBox="0 0 ' + w + ' ' + H + '" role="img" aria-label="' + esc(spec.aria || "Running profit") + '">';

    s += '<defs>' +
      '<clipPath id="' + id + 'up"><rect x="0" y="' + m.t + '" width="' + w + '" height="' + Math.max(0, y0 - m.t) + '"/></clipPath>' +
      '<clipPath id="' + id + 'dn"><rect x="0" y="' + y0 + '" width="' + w + '" height="' + Math.max(0, (m.t + ih) - y0) + '"/></clipPath>' +
      '</defs>';

    // gridlines + y labels
    ticks(dom.lo, dom.hi, dom.step).forEach(function (v) {
      var yy = y(v);
      s += '<line x1="' + m.l + '" y1="' + yy.toFixed(1) + '" x2="' + (m.l + iw) + '" y2="' + yy.toFixed(1) +
        '" style="stroke:var(--grid)" stroke-width="1"/>';
      s += '<text x="' + (m.l - 8) + '" y="' + (yy + 3.5).toFixed(1) + '" text-anchor="end" font-size="10.5" ' +
        'style="fill:var(--muted)">' + esc(fmt(v, true)) + '</text>';
    });

    // zero line, emphasised
    s += '<line x1="' + m.l + '" y1="' + y0.toFixed(1) + '" x2="' + (m.l + iw) + '" y2="' + y0.toFixed(1) +
      '" style="stroke:var(--axis)" stroke-width="1.5"/>';

    s += '<path d="' + area + '" clip-path="url(#' + id + 'up)" style="fill:var(--pos)" fill-opacity="0.15"/>';
    s += '<path d="' + area + '" clip-path="url(#' + id + 'dn)" style="fill:var(--neg)" fill-opacity="0.15"/>';
    s += '<path d="' + line + '" fill="none" style="stroke:var(--ink-2)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';

    // x labels — a few, never all
    var step = fewLabels(data.length, 6) || 1;
    data.forEach(function (d, i) {
      if (i % step !== 0 && i !== data.length - 1) return;
      s += '<text x="' + x(i).toFixed(1) + '" y="' + (m.t + ih + 16) + '" text-anchor="middle" font-size="10" ' +
        'style="fill:var(--muted)">' + esc(shortDate(d.date)) + '</text>';
    });

    // endpoint, emphasised and directly labelled
    var last = data[data.length - 1];
    var lx = x(data.length - 1), ly = y(last.cum);
    var sign = last.cum > 0 ? "pos" : last.cum < 0 ? "neg" : "axis";
    s += '<circle cx="' + lx.toFixed(1) + '" cy="' + ly.toFixed(1) + '" r="4.5" style="fill:var(--' + sign + ');stroke:var(--surface)" stroke-width="2"/>';

    // hover bands
    data.forEach(function (d, i) {
      var bw = iw / Math.max(1, data.length);
      s += '<rect x="' + (x(i) - bw / 2).toFixed(1) + '" y="' + m.t + '" width="' + bw.toFixed(1) + '" height="' + ih +
        '" fill="transparent" data-tip="' + esc(tip(fullDate(d.date), [
          ["Night", (d.net > 0 ? "+" : "") + fmt(d.net)],
          ["Running", (d.cum > 0 ? "+" : "") + fmt(d.cum)]
        ])) + '"/>';
    });

    return s + "</svg>";
  }

  /* ---------------------------------------------------------------- bars */

  /** Per-night result: bars above and below a zero baseline. */
  function netBars(w, spec) {
    var data = spec.data;
    var fmt = spec.fmt || String;
    var H = spec.height || 170;
    var m = { t: 12, r: 16, b: 26, l: 56 };
    if (!data.length) return empty(w, H, "No closed nights yet");

    var iw = Math.max(60, w - m.l - m.r);
    var ih = H - m.t - m.b;
    var vals = data.map(function (d) { return d.net; }).concat([0]);
    var dom = niceDomain(Math.min.apply(null, vals), Math.max.apply(null, vals), 4);
    var y = scale(dom.lo, dom.hi, m.t + ih, m.t);
    var y0 = y(0);
    var band = iw / data.length;
    var bw = Math.max(3, Math.min(44, band * 0.6));

    var s = '<svg class="chart-svg" width="' + w + '" height="' + H + '" viewBox="0 0 ' + w + ' ' + H + '" role="img" aria-label="' + esc(spec.aria || "Result per night") + '">';

    ticks(dom.lo, dom.hi, dom.step).forEach(function (v) {
      var yy = y(v);
      s += '<line x1="' + m.l + '" y1="' + yy.toFixed(1) + '" x2="' + (m.l + iw) + '" y2="' + yy.toFixed(1) +
        '" style="stroke:var(--grid)" stroke-width="1"/>';
      s += '<text x="' + (m.l - 8) + '" y="' + (yy + 3.5).toFixed(1) + '" text-anchor="end" font-size="10.5" style="fill:var(--muted)">' +
        esc(fmt(v, true)) + '</text>';
    });

    data.forEach(function (d, i) {
      var cx = m.l + band * i + band / 2;
      var yv = y(d.net);
      var up = d.net >= 0;
      var h = Math.abs(yv - y0);
      s += '<path d="' + barPath(cx - bw / 2, up ? yv : y0, bw, h, 4, up) + '" style="fill:var(--' + (up ? "pos" : "neg") + ')"' +
        ' data-tip="' + esc(tip(fullDate(d.date), [
          ["Result", (d.net > 0 ? "+" : "") + fmt(d.net)],
          ["Buy-ins", String(d.buyIns)]
        ])) + '"/>';
    });

    s += '<line x1="' + m.l + '" y1="' + y0.toFixed(1) + '" x2="' + (m.l + iw) + '" y2="' + y0.toFixed(1) +
      '" style="stroke:var(--axis)" stroke-width="1.5"/>';

    var step = fewLabels(data.length, 6) || 1;
    data.forEach(function (d, i) {
      if (i % step !== 0 && i !== data.length - 1) return;
      s += '<text x="' + (m.l + band * i + band / 2).toFixed(1) + '" y="' + (m.t + ih + 16) + '" text-anchor="middle" font-size="10" style="fill:var(--muted)">' +
        esc(shortDate(d.date)) + '</text>';
    });

    return s + "</svg>";
  }

  /** Single-series magnitude: money on the table, night by night. */
  function potBars(w, spec) {
    var data = spec.data;
    var fmt = spec.fmt || String;
    var H = spec.height || 170;
    var m = { t: 12, r: 16, b: 26, l: 56 };
    if (!data.length) return empty(w, H, "No closed nights yet");

    var iw = Math.max(60, w - m.l - m.r);
    var ih = H - m.t - m.b;
    var dom = niceDomain(0, Math.max.apply(null, data.map(function (d) { return d.value; })), 4);
    dom.lo = 0;
    var y = scale(dom.lo, dom.hi, m.t + ih, m.t);
    var band = iw / data.length;
    var bw = Math.max(3, Math.min(44, band * 0.6));

    var s = '<svg class="chart-svg" width="' + w + '" height="' + H + '" viewBox="0 0 ' + w + ' ' + H + '" role="img" aria-label="' + esc(spec.aria || "Money on the table per night") + '">';

    ticks(dom.lo, dom.hi, dom.step).forEach(function (v) {
      var yy = y(v);
      s += '<line x1="' + m.l + '" y1="' + yy.toFixed(1) + '" x2="' + (m.l + iw) + '" y2="' + yy.toFixed(1) +
        '" style="stroke:var(--grid)" stroke-width="1"/>';
      s += '<text x="' + (m.l - 8) + '" y="' + (yy + 3.5).toFixed(1) + '" text-anchor="end" font-size="10.5" style="fill:var(--muted)">' +
        esc(fmt(v, true)) + '</text>';
    });

    data.forEach(function (d, i) {
      var cx = m.l + band * i + band / 2;
      var yv = y(d.value);
      s += '<path d="' + barPath(cx - bw / 2, yv, bw, (m.t + ih) - yv, 4, true) + '" style="fill:var(--accent)"' +
        ' data-tip="' + esc(tip(fullDate(d.date), [
          ["On the table", fmt(d.value)],
          ["Players", String(d.players)],
          ["Buy-ins", String(d.buyIns)]
        ])) + '"/>';
    });

    s += '<line x1="' + m.l + '" y1="' + (m.t + ih) + '" x2="' + (m.l + iw) + '" y2="' + (m.t + ih) +
      '" style="stroke:var(--axis)" stroke-width="1"/>';

    var step = fewLabels(data.length, 6) || 1;
    data.forEach(function (d, i) {
      if (i % step !== 0 && i !== data.length - 1) return;
      s += '<text x="' + (m.l + band * i + band / 2).toFixed(1) + '" y="' + (m.t + ih + 16) + '" text-anchor="middle" font-size="10" style="fill:var(--muted)">' +
        esc(shortDate(d.date)) + '</text>';
    });

    return s + "</svg>";
  }

  /** Thumbnail running profit for a roster card. No axes, no labels. */
  function spark(w, spec) {
    var data = spec.data;
    var H = spec.height || 40;
    if (data.length < 2) return '<svg class="chart-svg" width="' + w + '" height="' + H + '"></svg>';
    var vals = data.map(function (d) { return d.cum; }).concat([0]);
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var x = scale(0, data.length - 1, 1, w - 1);
    var y = scale(lo, hi, H - 3, 3);
    var y0 = y(0);
    var id = "s" + (++uid);
    var line = data.map(function (d, i) { return (i ? "L" : "M") + x(i).toFixed(1) + "," + y(d.cum).toFixed(1); }).join("");
    var area = line + "L" + x(data.length - 1).toFixed(1) + "," + y0.toFixed(1) + "L" + x(0).toFixed(1) + "," + y0.toFixed(1) + "Z";
    var last = data[data.length - 1];
    var sign = last.cum > 0 ? "pos" : last.cum < 0 ? "neg" : "axis";

    return '<svg class="chart-svg" width="' + w + '" height="' + H + '" viewBox="0 0 ' + w + ' ' + H + '" aria-hidden="true">' +
      '<defs>' +
      '<clipPath id="' + id + 'u"><rect x="0" y="0" width="' + w + '" height="' + Math.max(0, y0) + '"/></clipPath>' +
      '<clipPath id="' + id + 'd"><rect x="0" y="' + y0 + '" width="' + w + '" height="' + Math.max(0, H - y0) + '"/></clipPath>' +
      '</defs>' +
      '<path d="' + area + '" clip-path="url(#' + id + 'u)" style="fill:var(--pos)" fill-opacity="0.16"/>' +
      '<path d="' + area + '" clip-path="url(#' + id + 'd)" style="fill:var(--neg)" fill-opacity="0.16"/>' +
      '<line x1="0" y1="' + y0.toFixed(1) + '" x2="' + w + '" y2="' + y0.toFixed(1) + '" style="stroke:var(--axis)" stroke-width="1" stroke-dasharray="2 3"/>' +
      '<path d="' + line + '" fill="none" style="stroke:var(--ink-2)" stroke-width="1.6" stroke-linejoin="round"/>' +
      '<circle cx="' + x(data.length - 1).toFixed(1) + '" cy="' + y(last.cum).toFixed(1) + '" r="2.8" style="fill:var(--' + sign + ')"/>' +
      '</svg>';
  }

  /* ---------------------------------------------------------------- util */

  function empty(w, H, msg) {
    return '<svg class="chart-svg" width="' + w + '" height="' + H + '" viewBox="0 0 ' + w + ' ' + H + '">' +
      '<text x="' + (w / 2) + '" y="' + (H / 2) + '" text-anchor="middle" font-size="12.5" style="fill:var(--muted)">' + esc(msg) + '</text></svg>';
  }

  function tip(title, rows) {
    var h = '<div class="t-title">' + esc(title) + "</div>";
    rows.forEach(function (r) {
      h += '<div class="t-row"><span>' + esc(r[0]) + '</span><span>' + esc(r[1]) + "</span></div>";
    });
    return h;
  }

  function shortDate(iso) {
    var p = String(iso || "").split("-");
    return p.length === 3 ? p[2] + "/" + p[1] : String(iso || "");
  }

  function fullDate(iso) {
    var p = String(iso || "").split("-");
    if (p.length !== 3) return String(iso || "");
    try {
      return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    } catch (e) { return iso; }
  }

  var BUILDERS = { cumulative: cumulative, netbars: netBars, potbars: potBars, spark: spark };

  /** Draw `spec` into `el`, sized to the element's current width. */
  function mount(el, spec) {
    if (!el) return;
    var w = Math.max(160, Math.round(el.clientWidth || el.getBoundingClientRect().width || 320));
    var build = BUILDERS[spec.type];
    if (!build) return;
    el.innerHTML = build(w, spec);
    mounted.push({ el: el, spec: spec });
  }

  function clear() { mounted = []; }

  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      mounted.slice().forEach(function (m) {
        if (!document.body.contains(m.el)) return;
        var w = Math.max(160, Math.round(m.el.clientWidth || 320));
        var build = BUILDERS[m.spec.type];
        if (build) m.el.innerHTML = build(w, m.spec);
      });
    }, 160);
  });

  return { mount: mount, clear: clear, tip: tip, fullDate: fullDate, shortDate: shortDate };
})();

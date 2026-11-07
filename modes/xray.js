/**
 * PageEraser Chrome Extension — Layout X-Ray Mode
 *
 * One click shows how a page is built: every visible element's box, coloured
 * by its display type, with margin and padding shaded and flex/grid gaps drawn
 * as dashed lines. Hover an element for a label with its size, display value
 * and gap/columns.
 *
 *   flex → orange    grid → purple    block → blue    inline-block → green
 *   margin → translucent orange       padding → translucent green
 *
 * Everything is drawn on a single fixed <canvas> that ignores the pointer, so
 * the page stays fully usable underneath. The page's own elements are only
 * ever *read* (getBoundingClientRect / getComputedStyle): no class, style or
 * attribute is changed on them, and leaving the mode removes every node,
 * listener and observer this file created.
 *
 * The first half of the file is pure functions (no DOM) so tests/run.js can
 * exercise them in Node; the second half is the mode itself.
 */

const PE_XRAY_MAX_DEPTH = 10;
const PE_XRAY_DEFAULT_DEPTH = 4;
const PE_XRAY_MAX_NODES = 5000;   // elements collected
const PE_XRAY_MAX_DRAWN = 3000;   // elements drawn per frame

const PE_XRAY_COLORS = {
  flex: '#ff8a00',
  grid: '#a040ff',
  block: '#2f7bff',
  'inline-block': '#1fb05a',
  other: '#8a8a8a'
};
const PE_XRAY_MARGIN_FILL = 'rgba(255, 150, 0, 0.30)';
const PE_XRAY_PADDING_FILL = 'rgba(60, 200, 100, 0.32)';

// Elements that never render a box of their own.
const PE_XRAY_SKIP = new Set([
  'script', 'style', 'link', 'meta', 'noscript', 'template', 'head', 'title', 'base'
]);

/* ─── Pure helpers ─────────────────────────────────────────── */

/* Computed `display` → which colour family an element belongs to. */
function PE_xrayKind(display) {
  switch (String(display || '').trim().toLowerCase()) {
    case 'flex':
    case 'inline-flex':
      return 'flex';
    case 'grid':
    case 'inline-grid':
      return 'grid';
    case 'block':
    case 'flow-root':
    case 'list-item':
      return 'block';
    case 'inline-block':
      return 'inline-block';
    default:
      return 'other';
  }
}

/* '12px' → 12. Anything else ('normal', '10%', 'auto', '') → 0. */
function PE_xrayPx(value) {
  const m = /^(-?\d*\.?\d+)px$/.exec(String(value == null ? '' : value).trim());
  return m ? parseFloat(m[1]) : 0;
}

/* Resolved grid-template-columns/rows → track sizes in px. An unresolved or
 * partly resolved value (subgrid, fr, percentages) yields [] — better to draw
 * no gap lines than wrong ones. */
function PE_xrayParseTracks(value) {
  const s = String(value == null ? '' : value).replace(/\[[^\]]*\]/g, ' ').trim();
  if (!s || s === 'none' || /subgrid|masonry/.test(s)) return [];
  const out = [];
  for (const token of s.split(/\s+/)) {
    const m = /^(-?\d*\.?\d+)px$/.exec(token);
    if (!m) return [];
    out.push(parseFloat(m[1]));
  }
  return out;
}

/* Where to draw dashed lines for a gap that starts at `start` and is `size`
 * wide: both edges when it is wide enough to read, otherwise its middle. */
function PE_xrayGapPositions(start, size) {
  return size >= 6 ? [start, start + size] : [start + size / 2];
}

/* Dashed gap lines for a grid container.
 * box is its CONTENT box: { left, top, width, height }. */
function PE_xrayGridGapLines(box, cols, rows, colGap, rowGap) {
  const lines = [];
  if (colGap > 0 && cols.length > 1) {
    let x = box.left;
    for (let i = 0; i < cols.length - 1; i++) {
      x += cols[i];
      PE_xrayGapPositions(x, colGap).forEach((px) => {
        lines.push({ x1: px, y1: box.top, x2: px, y2: box.top + box.height });
      });
      x += colGap;
    }
  }
  if (rowGap > 0 && rows.length > 1) {
    let y = box.top;
    for (let i = 0; i < rows.length - 1; i++) {
      y += rows[i];
      PE_xrayGapPositions(y, rowGap).forEach((py) => {
        lines.push({ x1: box.left, y1: py, x2: box.left + box.width, y2: py });
      });
      y += rowGap;
    }
  }
  return lines;
}

/* Dashed gap lines for a flex container, found from its children's boxes
 * ({ left, top, right, bottom }, in DOM order) — flex gives no track list.
 * A pair of neighbours only counts when the space between them matches the
 * declared gap, so unrelated spacing (margins, justify-content) is not drawn. */
function PE_xrayFlexGapLines(box, direction, children, colGap, rowGap) {
  const TOL = 1;
  const lines = [];
  const isRow = direction === 'row' || direction === 'row-reverse';
  const reversed = direction === 'row-reverse' || direction === 'column-reverse';
  const mainGap = isRow ? colGap : rowGap;
  const crossGap = isRow ? rowGap : colGap;

  for (let i = 0; i < children.length - 1; i++) {
    const a = children[i];
    const b = children[i + 1];
    const first = reversed ? b : a;
    const second = reversed ? a : b;

    if (isRow) {
      const space = second.left - first.right;
      const overlaps = a.top < b.bottom && b.top < a.bottom;
      if (mainGap > 0 && overlaps && Math.abs(space - mainGap) <= TOL) {
        const top = Math.min(a.top, b.top);
        const bottom = Math.max(a.bottom, b.bottom);
        PE_xrayGapPositions(first.right, mainGap).forEach((px) => {
          lines.push({ x1: px, y1: top, x2: px, y2: bottom });
        });
      } else if (crossGap > 0 && Math.abs((b.top - a.bottom) - crossGap) <= TOL) {
        // wrapped onto the next line
        PE_xrayGapPositions(a.bottom, crossGap).forEach((py) => {
          lines.push({ x1: box.left, y1: py, x2: box.left + box.width, y2: py });
        });
      }
    } else {
      const space = second.top - first.bottom;
      const overlaps = a.left < b.right && b.left < a.right;
      if (mainGap > 0 && overlaps && Math.abs(space - mainGap) <= TOL) {
        const left = Math.min(a.left, b.left);
        const right = Math.max(a.right, b.right);
        PE_xrayGapPositions(first.bottom, mainGap).forEach((py) => {
          lines.push({ x1: left, y1: py, x2: right, y2: py });
        });
      } else if (crossGap > 0 && Math.abs((b.left - a.right) - crossGap) <= TOL) {
        PE_xrayGapPositions(a.right, crossGap).forEach((px) => {
          lines.push({ x1: px, y1: box.top, x2: px, y2: box.top + box.height });
        });
      }
    }
  }
  return lines;
}

/* 'div#hero.card.wide · 320 × 180 · flex · gap 16px' */
function PE_xrayLabelText(d) {
  const round = (n) => Math.round(n * 10) / 10;
  let name = String(d.tag || '').toLowerCase();
  if (d.id) name += '#' + d.id;
  if (d.classes && d.classes.length) name += '.' + d.classes.slice(0, 3).join('.');
  if (name.length > 48) name = name.slice(0, 47) + '…';

  const parts = [name, `${round(d.width)} × ${round(d.height)}`, d.display];
  if (d.cols > 0) parts.push(`${d.cols} col${d.cols === 1 ? '' : 's'}`);
  if (d.rows > 1) parts.push(`${d.rows} rows`);
  const col = d.colGap || 0;
  const row = d.rowGap || 0;
  if (col > 0 || row > 0) {
    parts.push(col === row ? `gap ${round(col)}px` : `gap ${round(row)}px ${round(col)}px`);
  }
  return parts.join(' · ');
}

/* Is a box (client rect) inside the zone that is re-read on every frame: the
 * viewport plus two viewports above/left and three below/right? Scrolling by
 * less than one viewport cannot bring anything from outside this zone into view. */
function PE_xrayInNearZone(r, vw, vh) {
  return r.right >= -2 * vw && r.left <= 3 * vw && r.bottom >= -2 * vh && r.top <= 3 * vh;
}

/* ─── The mode ─────────────────────────────────────────────── */

function PE_createXrayMode(host) {
  // Our own nodes and the other modes' UI are never drawn or labelled.
  const OWN_SELECTOR =
    '#pe-xray-canvas, #pe-xray-label, #pe-xray-toolbar, #pe-clippy-buddy, ' +
    '#pe-toast-container, #pe-paint-toolbox, #pe-paint-canvas, #pe-eraser-cursor, .pe-highlighter';
  const isOwn = (el) =>
    el.id === 'pe-xray-canvas' || el.id === 'pe-xray-label' || el.id === 'pe-xray-toolbar' ||
    el.id === 'pe-clippy-buddy' || el.id === 'pe-toast-container' || el.id === 'pe-paint-toolbox' ||
    el.id === 'pe-paint-canvas' || el.id === 'pe-eraser-cursor' ||
    (el.classList && el.classList.contains('pe-highlighter'));

  let canvas = null;
  let ctx = null;
  let labelEl = null;
  let toolbar = null;
  let statusEl = null;
  let depthInput = null;
  let depthValueEl = null;
  let captureBtn = null;

  let depth = PE_XRAY_DEFAULT_DEPTH;
  let nodes = [];                  // [{ el, depth }] in document order
  let depthCounts = [];            // depthCounts[d] = how many nodes sit at depth d
  let nearList = null;             // nodes inside the near zone, re-read each frame
  let nearStamp = 0;
  let nearScrollX = 0;
  let nearScrollY = 0;
  let truncated = false;
  let metrics = new WeakMap();     // el → computed-style facts, cached
  let hovered = null;
  let vw = 0;
  let vh = 0;
  let dpr = 1;

  let rafId = 0;
  let dirty = false;               // the DOM changed: nodes need collecting again
  let lastCollect = 0;
  let recollectTimer = 0;
  let capturing = false;
  let mutationObserver = null;
  let resizeObserver = null;
  let cleanups = [];

  const T = () => (host.isTr
    ? {
        title: 'Layout X-Ray', depth: 'Derinlik', capture: 'Yakala', close: 'Kapat',
        flex: 'Flex', grid: 'Grid', block: 'Block', inlineBlock: 'Inline-block',
        margin: 'Margin', padding: 'Padding',
        shown: (n, total) => `${n} / ${total} eleman`,
        limited: ' (sınırlandı)',
        capturing: 'Yakalanıyor…', saved: 'PNG indirildi',
        needGesture: 'Yakalama için PageEraser\'ı araç çubuğu düğmesi, kısayol veya sağ tık menüsünden başlatın.',
        failed: 'Yakalanamadı'
      }
    : {
        title: 'Layout X-Ray', depth: 'Depth', capture: 'Capture', close: 'Close',
        flex: 'Flex', grid: 'Grid', block: 'Block', inlineBlock: 'Inline-block',
        margin: 'Margin', padding: 'Padding',
        shown: (n, total) => `${n} / ${total} elements`,
        limited: ' (limited)',
        capturing: 'Capturing…', saved: 'PNG downloaded',
        needGesture: 'To capture, start PageEraser from the toolbar button, a shortcut or the right-click menu.',
        failed: 'Capture failed'
      });

  /* ─── Collecting and measuring ─────────────────────────── */

  function collect() {
    nodes = [];
    depthCounts = [];
    nearList = null;
    truncated = false;
    const root = document.body;
    if (!root) return;

    // Iterative depth-first walk so the list is in document order (parents
    // before children, which is the order they must be painted in).
    const stack = [];
    for (let i = root.children.length - 1; i >= 0; i--) stack.push(root.children[i], 1);

    while (stack.length) {
      const d = stack.pop();
      const el = stack.pop();
      if (PE_XRAY_SKIP.has(el.localName) || isOwn(el)) continue;
      if (nodes.length >= PE_XRAY_MAX_NODES) { truncated = true; break; }
      nodes.push({ el, depth: d });
      depthCounts[d] = (depthCounts[d] || 0) + 1;
      // An <svg>'s internals are drawing primitives, not layout boxes.
      if (d < PE_XRAY_MAX_DEPTH && el.localName !== 'svg') {
        const kids = el.children;
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i], d + 1);
      }
    }
  }

  function computeMetrics(el) {
    const cs = window.getComputedStyle(el);
    const px = (v) => Math.max(0, PE_xrayPx(v));
    const kind = PE_xrayKind(cs.display);
    const m = {
      display: cs.display,
      kind,
      visible: cs.visibility !== 'hidden',
      mt: px(cs.marginTop), mr: px(cs.marginRight), mb: px(cs.marginBottom), ml: px(cs.marginLeft),
      pt: px(cs.paddingTop), pr: px(cs.paddingRight), pb: px(cs.paddingBottom), pl: px(cs.paddingLeft),
      bt: px(cs.borderTopWidth), br: px(cs.borderRightWidth), bb: px(cs.borderBottomWidth), bl: px(cs.borderLeftWidth),
      colGap: PE_xrayPx(cs.columnGap),
      rowGap: PE_xrayPx(cs.rowGap),
      cols: [],
      rows: [],
      dir: 'row'
    };
    if (kind === 'grid') {
      m.cols = PE_xrayParseTracks(cs.gridTemplateColumns);
      m.rows = PE_xrayParseTracks(cs.gridTemplateRows);
    } else if (kind === 'flex') {
      m.dir = cs.flexDirection || 'row';
    }
    return m;
  }

  function metricsOf(el) {
    let m = metrics.get(el);
    if (!m) {
      m = computeMetrics(el);
      metrics.set(el, m);
    }
    return m;
  }

  /* ─── Drawing ──────────────────────────────────────────── */

  function drawElement(r, m, el, emphasis) {
    // Margin: the ring between the margin box and the border box.
    if (m.mt || m.mr || m.mb || m.ml) {
      ctx.fillStyle = PE_XRAY_MARGIN_FILL;
      ctx.beginPath();
      ctx.rect(r.left - m.ml, r.top - m.mt, r.width + m.ml + m.mr, r.height + m.mt + m.mb);
      ctx.rect(r.left, r.top, r.width, r.height);
      ctx.fill('evenodd');
    }

    // Padding: the ring between the padding box and the content box.
    const padX = r.left + m.bl;
    const padY = r.top + m.bt;
    const padW = r.width - m.bl - m.br;
    const padH = r.height - m.bt - m.bb;
    const content = {
      left: padX + m.pl,
      top: padY + m.pt,
      width: padW - m.pl - m.pr,
      height: padH - m.pt - m.pb
    };
    if ((m.pt || m.pr || m.pb || m.pl) && padW > 0 && padH > 0 && content.width >= 0 && content.height >= 0) {
      ctx.fillStyle = PE_XRAY_PADDING_FILL;
      ctx.beginPath();
      ctx.rect(padX, padY, padW, padH);
      ctx.rect(content.left, content.top, content.width, content.height);
      ctx.fill('evenodd');
    }

    const color = PE_XRAY_COLORS[m.kind];
    ctx.strokeStyle = color;
    ctx.lineWidth = emphasis ? 2 : 1;
    ctx.setLineDash([]);
    ctx.strokeRect(r.left + 0.5, r.top + 0.5, Math.max(0, r.width - 1), Math.max(0, r.height - 1));

    // Gaps
    if ((m.kind === 'grid' || m.kind === 'flex') && (m.colGap > 0 || m.rowGap > 0) && content.width > 0 && content.height > 0) {
      let lines = [];
      if (m.kind === 'grid') {
        lines = PE_xrayGridGapLines(content, m.cols, m.rows, m.colGap, m.rowGap);
      } else {
        const kids = [];
        for (const child of el.children) {
          const cr = child.getBoundingClientRect();
          if (cr.width > 0 && cr.height > 0) {
            kids.push({ left: cr.left, top: cr.top, right: cr.right, bottom: cr.bottom });
          }
        }
        lines = PE_xrayFlexGapLines(content, m.dir, kids, m.colGap, m.rowGap);
      }
      if (lines.length) {
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        lines.forEach((l) => {
          ctx.moveTo(l.x1 + 0.5, l.y1 + 0.5);
          ctx.lineTo(l.x2 + 0.5, l.y2 + 0.5);
        });
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  /* Reading a rect for every collected node on every frame costs several ms on
   * big pages even though only ~100 are on screen. Instead keep the nodes near
   * the viewport and rebuild that list when the page has scrolled a viewport,
   * once a second, or when something may have moved the layout. */
  function nearNodes() {
    const now = performance.now();
    if (nearList && now - nearStamp < 1000 &&
        Math.abs(window.scrollX - nearScrollX) < vw && Math.abs(window.scrollY - nearScrollY) < vh) {
      return nearList;
    }
    nearList = [];
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i].el;
      if (!el.isConnected) { dirty = true; continue; }
      if (PE_xrayInNearZone(el.getBoundingClientRect(), vw, vh)) nearList.push(nodes[i]);
    }
    nearStamp = now;
    nearScrollX = window.scrollX;
    nearScrollY = window.scrollY;
    return nearList;
  }

  function draw() {
    rafId = 0;
    if (!canvas) return;

    // The page changed: collect again, but not more than every 250 ms — a page
    // that mutates constantly (ads, carousels) must not make us redo this work
    // on every frame.
    if (dirty) {
      const now = performance.now();
      if (now - lastCollect >= 250) {
        collect();
        metrics = new WeakMap();
        lastCollect = now;
        dirty = false;
      } else if (!recollectTimer) {
        recollectTimer = setTimeout(() => { recollectTimer = 0; schedule(); }, 260 - (now - lastCollect));
      }
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);

    let drawn = 0;
    let eligible = 0;
    for (let d = 1; d <= depth && d < depthCounts.length; d++) eligible += depthCounts[d] || 0;
    const list = nearNodes();
    for (let i = 0; i < list.length; i++) {
      const node = list[i];
      if (node.depth > depth) continue;
      if (drawn >= PE_XRAY_MAX_DRAWN) break;
      const el = node.el;
      if (!el.isConnected) { dirty = true; continue; }
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const m = metricsOf(el);
      if (!m.visible) continue;
      // Skip what cannot be seen: outside the viewport, margin included.
      if (r.right + m.mr < 0 || r.bottom + m.mb < 0 || r.left - m.ml > vw || r.top - m.mt > vh) continue;
      drawElement(r, m, el, false);
      drawn++;
    }

    if (hovered && hovered.isConnected) {
      const hr = hovered.getBoundingClientRect();
      if (hr.width >= 1 && hr.height >= 1) drawElement(hr, metricsOf(hovered), hovered, true);
    }

    if (statusEl && !capturing) {
      // "limited" only when a cap cut the picture short — elements that are
      // merely off-screen are not a limitation.
      statusEl.textContent = T().shown(drawn, eligible) + (truncated || drawn >= PE_XRAY_MAX_DRAWN ? T().limited : '');
    }
  }

  function schedule() {
    if (!rafId && canvas) rafId = requestAnimationFrame(draw);
  }

  function resizeCanvas() {
    if (!canvas) return;
    vw = document.documentElement.clientWidth;
    vh = document.documentElement.clientHeight;
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(vw * dpr));
    canvas.height = Math.max(1, Math.round(vh * dpr));
    canvas.style.width = vw + 'px';
    canvas.style.height = vh + 'px';
    metrics = new WeakMap();
    nearList = null;

    // The toolbar is anchored by `left`, so a smaller window can leave it
    // hanging off the edge: pull it back in.
    if (toolbar) {
      const tr = toolbar.getBoundingClientRect();
      if (tr.right > vw) {
        toolbar.style.setProperty('left', Math.max(0, vw - tr.width - 16) + 'px', 'important');
      }
      if (tr.bottom > vh) {
        toolbar.style.setProperty('top', Math.max(0, vh - tr.height - 16) + 'px', 'important');
      }
    }
    schedule();
  }

  /* ─── Hover label ──────────────────────────────────────── */

  function hideLabel() {
    if (labelEl) labelEl.style.display = 'none';
  }

  function showLabel(el, x, y) {
    if (!labelEl) return;
    const r = el.getBoundingClientRect();
    const m = metricsOf(el);
    labelEl.textContent = PE_xrayLabelText({
      tag: el.localName,
      id: el.id,
      classes: el.classList ? Array.from(el.classList) : [],
      width: r.width,
      height: r.height,
      display: m.display,
      cols: m.cols.length,
      rows: m.rows.length,
      colGap: m.colGap,
      rowGap: m.rowGap
    });
    labelEl.style.display = 'block';
    // Beside the pointer, flipped or clamped so it never leaves the viewport.
    const w = labelEl.offsetWidth;
    const h = labelEl.offsetHeight;
    let left = x + 14;
    let top = y + 18;
    if (left + w > vw - 4) left = Math.max(4, x - w - 10);
    if (top + h > vh - 4) top = Math.max(4, y - h - 10);
    labelEl.style.left = left + 'px';
    labelEl.style.top = top + 'px';
  }

  /* ─── Toolbar (depth + capture) ────────────────────────── */

  function buildToolbar() {
    const t = T();
    toolbar = document.createElement('div');
    toolbar.id = 'pe-xray-toolbar';
    toolbar.className = 'pe-paint-toolbox pe-xray-toolbar';
    toolbar.innerHTML = `
      <div class="pe-paint-toolbox-titlebar">
        <span class="pe-paint-toolbox-title">${t.title}</span>
        <button class="pe-paint-toolbox-close" type="button" aria-label="${t.close}"></button>
      </div>
      <div class="pe-paint-toolbox-body">
        <div class="pe-paint-group">
          <div class="pe-paint-label">${t.depth}</div>
          <div class="pe-paint-row" style="align-items: center;">
            <input type="range" class="pe-paint-slider pe-xray-depth" min="1" max="${PE_XRAY_MAX_DEPTH}" value="${depth}" />
            <span class="pe-xray-depth-value">${depth}</span>
          </div>
        </div>
        <div class="pe-xray-legend">
          <span class="pe-xray-chip pe-xray-chip-flex">${t.flex}</span>
          <span class="pe-xray-chip pe-xray-chip-grid">${t.grid}</span>
          <span class="pe-xray-chip pe-xray-chip-block">${t.block}</span>
          <span class="pe-xray-chip pe-xray-chip-inline-block">${t.inlineBlock}</span>
          <span class="pe-xray-chip pe-xray-chip-margin">${t.margin}</span>
          <span class="pe-xray-chip pe-xray-chip-padding">${t.padding}</span>
        </div>
        <div class="pe-xray-status"></div>
        <div class="pe-paint-actions-row" style="display: flex !important; gap: 4px !important;">
          <button class="win-btn pe-xray-capture" type="button" style="flex: 1 !important; font-size: 11px; font-weight: bold;">${t.capture}</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(toolbar);
    // The stylesheet pins the toolbar to the right edge. Dragging only sets
    // top/left, and with both left and right set an RTL page honours "right"
    // and ignores "left", so the toolbar could not be moved sideways. Anchor
    // it by "left" from the start, as the other floating toolboxes are.
    toolbar.style.setProperty('left', Math.max(0, document.documentElement.clientWidth - toolbar.offsetWidth - 16) + 'px', 'important');
    toolbar.style.setProperty('right', 'auto', 'important');

    statusEl = toolbar.querySelector('.pe-xray-status');
    depthInput = toolbar.querySelector('.pe-xray-depth');
    depthValueEl = toolbar.querySelector('.pe-xray-depth-value');
    captureBtn = toolbar.querySelector('.pe-xray-capture');

    depthInput.addEventListener('input', () => {
      depth = clampDepth(parseInt(depthInput.value, 10));
      depthValueEl.textContent = String(depth);
      host._saveSetting('pe_xray_depth', depth);
      schedule();
    });
    // A page can click our button with element.click(); only a real click captures.
    captureBtn.addEventListener('click', (e) => { if (e.isTrusted !== false) capture(); });
    toolbar.querySelector('.pe-paint-toolbox-close').addEventListener('click', () => {
      host.modes.deactivate();
    });
    host._makeElementDraggable(toolbar, toolbar.querySelector('.pe-paint-toolbox-titlebar'));
  }

  function clampDepth(n) {
    return Number.isFinite(n) ? Math.min(PE_XRAY_MAX_DEPTH, Math.max(1, n)) : PE_XRAY_DEFAULT_DEPTH;
  }

  /* ─── Capture ──────────────────────────────────────────── */

  const nextFrames = (n) => new Promise((resolve) => {
    const step = (left) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(n);
  });

  function dataUrlToBlob(dataUrl) {
    const comma = dataUrl.indexOf(',');
    const mime = (/^data:([^;,]+)/.exec(dataUrl.slice(0, comma)) || [])[1] || 'image/png';
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function download(dataUrl) {
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const site = (location.hostname || 'page').replace(/[^a-z0-9.-]/gi, '_');
    const url = URL.createObjectURL(dataUrlToBlob(dataUrl));
    const a = document.createElement('a');
    a.href = url;
    a.download = `pageeraser-xray-${site}-${stamp}.png`;
    a.style.display = 'none';
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function capture() {
    if (capturing || !canvas) return;
    capturing = true;
    const t = T();
    statusEl.textContent = t.capturing;

    // Our own controls stay out of the picture: the screenshot is the page
    // with the overlay on it.
    toolbar.style.visibility = 'hidden';
    hideLabel();
    schedule();
    await nextFrames(2);

    let result;
    try {
      result = await host._captureTab();
    } catch (err) {
      result = { error: String(err && err.message || err) };
    }

    if (toolbar) toolbar.style.visibility = '';
    capturing = false;
    if (!canvas) return; // the mode ended while we were waiting

    if (result && result.dataUrl) {
      try {
        download(result.dataUrl);
        statusEl.textContent = t.saved;
      } catch (err) {
        statusEl.textContent = t.failed;
      }
    } else {
      const text = String((result && result.error) || '');
      // captureVisibleTab only works once the user has invoked the extension
      // on this tab; the in-page fallback shortcut does not count as that.
      statusEl.textContent = /activeTab|all_urls|permission/i.test(text) ? t.needGesture : t.failed;
    }
  }

  /* ─── Mode interface ───────────────────────────────────── */

  function listen(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    cleanups.push(() => target.removeEventListener(type, fn, options));
  }

  return {
    enter() {
      // Nothing to draw on yet (the very start of a page load): do not stay "active".
      if (!document.body) {
        host.modes.release('xray');
        return;
      }

      canvas = document.createElement('canvas');
      canvas.id = 'pe-xray-canvas';
      canvas.className = 'pe-xray-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      ctx = canvas.getContext('2d');
      labelEl = document.createElement('div');
      labelEl.id = 'pe-xray-label';
      labelEl.className = 'pe-xray-label';
      labelEl.style.display = 'none';
      // On <html>, not <body>: the observer below watches body, and our own
      // nodes must never feed back into it.
      document.documentElement.appendChild(canvas);
      document.documentElement.appendChild(labelEl);
      buildToolbar();

      resizeCanvas();
      collect();
      lastCollect = performance.now();
      schedule();

      // Remembered depth arrives asynchronously; apply it if we are still here.
      host._getSetting('pe_xray_depth', PE_XRAY_DEFAULT_DEPTH).then((saved) => {
        if (!canvas) return;
        const d = clampDepth(Number(saved));
        if (d !== depth) {
          depth = d;
          depthInput.value = String(d);
          depthValueEl.textContent = String(d);
          schedule();
        }
      });

      // Redraw on scroll (capture phase: nested scroll containers do not
      // bubble) and resize, at most once per frame.
      // A nested scroller moving its content shifts boxes without moving the
      // window: drop the near list so it is rebuilt on the next frame.
      const onScroll = (e) => { if (e.target !== document) nearList = null; schedule(); };
      listen(window, 'scroll', onScroll, { capture: true, passive: true });
      listen(window, 'resize', resizeCanvas);
      listen(document, 'load', () => { nearList = null; schedule(); }, true); // images finishing → layout shifts

      if (typeof MutationObserver === 'function') {
        mutationObserver = new MutationObserver(() => { dirty = true; schedule(); });
        mutationObserver.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'style', 'hidden', 'open']
        });
      }
      if (typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(() => { nearList = null; schedule(); });
        resizeObserver.observe(document.body);
      }
    },

    exit() {
      cleanups.forEach((fn) => fn());
      cleanups = [];
      if (mutationObserver) { mutationObserver.disconnect(); mutationObserver = null; }
      if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      if (recollectTimer) { clearTimeout(recollectTimer); recollectTimer = 0; }
      if (toolbar && toolbar._cleanupDrag) toolbar._cleanupDrag();
      [canvas, labelEl, toolbar].forEach((node) => { if (node) node.remove(); });
      canvas = ctx = labelEl = toolbar = statusEl = depthInput = depthValueEl = captureBtn = null;
      nodes = [];
      depthCounts = [];
      nearList = null;
      metrics = new WeakMap();
      hovered = null;
      dirty = false;
      truncated = false;
      capturing = false;
    },

    onPointerMove(info) {
      if (!canvas) return;
      const target = info.target;
      if (!target || target.nodeType !== 1 || (target.closest && target.closest(OWN_SELECTOR))) {
        hovered = null;
        hideLabel();
        schedule();
        return;
      }
      hovered = target;
      showLabel(target, info.clientX || 0, info.clientY || 0);
      schedule();
    }
  };
}

// Lets tests/run.js load the pure helpers in Node; a no-op inside the extension.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PE_xrayKind,
    PE_xrayPx,
    PE_xrayParseTracks,
    PE_xrayGapPositions,
    PE_xrayGridGapLines,
    PE_xrayFlexGapLines,
    PE_xrayLabelText,
    PE_xrayInNearZone,
    PE_XRAY_COLORS,
    PE_XRAY_DEFAULT_DEPTH,
    PE_XRAY_MAX_DEPTH,
    PE_createXrayMode
  };
}

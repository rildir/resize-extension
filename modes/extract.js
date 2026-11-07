/**
 * PageEraser Chrome Extension — Extract to Code Mode
 *
 * Pick an element the way the eraser does (hover, ↑/↓ for parent/child, Esc),
 * but instead of erasing it, take it with you: its cleaned-up HTML, the
 * computed CSS that differs from the browser's defaults, and the fonts and
 * colours it uses, in a small tabbed window on the page.
 *
 * The page's elements are only read. Their defaults come from a throwaway
 * about:blank iframe (so a site's own CSS resets are not mistaken for browser
 * defaults), which exists for the length of one extraction. Leaving the mode
 * removes the window and everything else this file created. Nothing is sent
 * anywhere and font files are listed, never downloaded.
 *
 * The pure logic is in modes/extract-core.js; this file is the part that needs
 * a browser: the extraction engine, the picker and the panel.
 */

const PE_EXTRACT_PANEL_ID = 'pe-extract-panel';
// Elements with their own intrinsic size, where width/height are content, not layout.
const PE_EXTRACT_REPLACED = new Set(['img', 'video', 'canvas', 'svg', 'input', 'textarea', 'select', 'button', 'meter', 'progress', 'audio']);
// Boxes that shrink-wrap their content: their authored width/height is not recoverable from the parent.
const PE_EXTRACT_SHRINK_DISPLAYS = new Set(['inline-block', 'inline-flex', 'inline-grid', 'inline-table']);
const PE_EXTRACT_ITEM_PARENTS = /^(inline-)?(flex|grid)$/;
const PE_EXTRACT_HTML_NS = 'http://www.w3.org/1999/xhtml';
const PE_EXTRACT_MAX_TOKENS = 20000;           // beyond this the panel shows plain text
const PE_EXTRACT_MAX_HIGHLIGHT_CHARS = 400000;

/* ─── Defaults from a blank document ───────────────────────── */

/* An off-screen about:blank iframe: its only style sheet is the browser's own,
 * so an empty <div> in it shows what a <div> looks like with no CSS at all.
 * If the iframe cannot be made, fall back to the page itself and say so. */
function PE_extractCreateSandbox(pageDoc) {
  let iframe = null;
  try {
    iframe = pageDoc.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.cssText = 'position:fixed!important;left:-10000px!important;top:0!important;width:1000px!important;height:800px!important;border:0!important;visibility:hidden!important;pointer-events:none!important;';
    pageDoc.documentElement.appendChild(iframe);
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) { iframe.remove(); throw new Error('no sandbox'); }
    doc.open();
    doc.write('<!DOCTYPE html><html><head></head><body></body></html>');
    doc.close();
    return { doc, win, fallback: false, destroy: () => iframe.remove() };
  } catch (e) {
    if (iframe) iframe.remove(); // never leave a half-built sandbox on the page
    return { doc: pageDoc, win: pageDoc.defaultView, fallback: true, destroy: () => {} };
  }
}

/* Reads the default value of every property for a tag (and for ::before and
 * ::after), once per tag. */
function PE_extractMakeRefs(sandbox, names) {
  const { doc, win } = sandbox;
  const cache = new Map();
  let svgRoot = null;

  const read = (el, pseudo) => {
    const cs = win.getComputedStyle(el, pseudo || null);
    const map = new Map();
    for (const n of names) map.set(n, cs.getPropertyValue(n));
    return map;
  };

  return {
    forElement(el) {
      const svg = el.namespaceURI === PE_EXTRACT_SVG_NS;
      const key = (svg ? 'svg:' : '') + el.localName;
      let map = cache.get(key);
      if (!map) {
        try {
          let probe;
          if (svg) {
            if (!svgRoot) {
              svgRoot = doc.createElementNS(PE_EXTRACT_SVG_NS, 'svg');
              doc.body.appendChild(svgRoot);
            }
            probe = doc.createElementNS(PE_EXTRACT_SVG_NS, el.localName);
            svgRoot.appendChild(probe);
          } else {
            probe = doc.createElement(el.localName);
            // The browser's link rules (colour, underline, pointer) only apply to a link.
            if (el.localName === 'a' || el.localName === 'area') probe.setAttribute('href', '#');
            doc.body.appendChild(probe);
          }
          map = read(probe);
          probe.remove();
        } catch (e) {
          map = new Map();
        }
        cache.set(key, map);
      }
      return map;
    },

    forPseudo(which) {
      const key = 'pseudo:' + which;
      let map = cache.get(key);
      if (!map) {
        try {
          const style = doc.createElement('style');
          style.textContent = '#pe-ref-pseudo::before,#pe-ref-pseudo::after{content:"x"}';
          doc.head.appendChild(style);
          const probe = doc.createElement('span');
          probe.id = 'pe-ref-pseudo';
          doc.body.appendChild(probe);
          map = read(probe, which);
          probe.remove();
          style.remove();
        } catch (e) {
          map = new Map();
        }
        cache.set(key, map);
      }
      return map;
    }
  };
}

/* ─── Fonts ────────────────────────────────────────────────── */

const PE_EXTRACT_WEIGHT_NAMES = { normal: '400', bold: '700' };
const PE_extractWeight = (w) => PE_EXTRACT_WEIGHT_NAMES[String(w).trim()] || String(w).trim();

/* Every @font-face the page declares that we are allowed to read, joined with
 * document.fonts for load state. A cross-origin style sheet (Google Fonts, a
 * CDN) refuses to show its rules: those are counted so the panel can say so. */
function PE_extractGatherFontFaces(doc) {
  const faces = [];
  let blocked = 0;

  const visit = (rules, base, depth) => {
    for (const rule of Array.from(rules)) {
      if (rule.style && rule.cssText && /^@font-face/i.test(rule.cssText)) {
        faces.push({
          family: rule.style.getPropertyValue('font-family').trim().replace(/^["']|["']$/g, ''),
          weight: rule.style.getPropertyValue('font-weight').trim() || '400',
          style: rule.style.getPropertyValue('font-style').trim() || 'normal',
          status: '',
          urls: PE_extractParseFontSrc(rule.style.getPropertyValue('src'), base)
        });
      } else if (rule.styleSheet) {
        try { visit(rule.styleSheet.cssRules, rule.styleSheet.href || base, depth + 1); } catch (e) { blocked++; }
      } else if (rule.cssRules && depth < 8) {
        visit(rule.cssRules, base, depth + 1);
      }
    }
  };

  for (const sheet of Array.from(doc.styleSheets)) {
    try { visit(sheet.cssRules, sheet.href || doc.baseURI, 0); } catch (e) { blocked++; }
  }

  try {
    if (doc.fonts && typeof doc.fonts.forEach === 'function') {
      doc.fonts.forEach((f) => {
        const family = String(f.family).replace(/^["']|["']$/g, '');
        const match = faces.find((x) => !x.status &&
          x.family.toLowerCase() === family.toLowerCase() &&
          PE_extractWeight(x.weight) === PE_extractWeight(f.weight) && x.style === f.style);
        if (match) match.status = f.status;
        else faces.push({ family, weight: f.weight, style: f.style, status: f.status, urls: [] });
      });
    }
  } catch (e) { /* document.fonts is best effort */ }

  return { faces, blocked };
}

/* Which fonts the extracted elements use, and where each web font lives. */
function PE_extractCollectFonts(list, csOf, doc, notes) {
  const used = new Map();
  for (const el of list) {
    const stack = csOf(el).fontFamily;
    PE_extractParseFontFamily(stack).forEach((family, i) => {
      const key = family.toLowerCase();
      let u = used.get(key);
      if (!u) { u = { family, stack, primary: 0, any: 0 }; used.set(key, u); }
      u.any++;
      if (i === 0) u.primary++;
    });
  }

  const { faces, blocked } = PE_extractGatherFontFaces(doc);
  const fonts = [];
  let missingUrls = false;
  for (const u of used.values()) {
    const matches = faces
      .filter((f) => f.family.toLowerCase() === u.family.toLowerCase())
      .sort((a, b) => (b.status === 'loaded') - (a.status === 'loaded'))
      .slice(0, 12);
    if (matches.some((f) => f.urls.length === 0)) missingUrls = true;
    fonts.push({ family: u.family, stack: u.stack, count: u.primary || u.any, web: matches.length > 0, faces: matches });
  }
  fonts.sort((a, b) => b.count - a.count);

  if (blocked > 0) {
    notes.push(`${blocked} style sheet${blocked === 1 ? ' is' : 's are'} cross-origin: their @font-face rules cannot be read.`);
  }
  if (missingUrls) {
    try {
      const files = Array.from(new Set(performance.getEntriesByType('resource')
        .map((e) => e.name)
        .filter((n) => /\.(woff2?|ttf|otf|eot)(?:[?#]|$)/i.test(n)))).slice(0, 12);
      if (files.length) {
        notes.push('Font files this page loaded:');
        files.forEach((f) => notes.push('  ' + f));
      }
    } catch (e) { /* resource timing unavailable */ }
  }
  return fonts;
}

/* ─── The extraction ───────────────────────────────────────── */

/* 'div#hero.card.wide' for the status line. */
function PE_extractLabel(el) {
  let s = el.localName;
  if (el.id) s += '#' + el.id;
  if (el.classList && el.classList.length) s += '.' + Array.from(el.classList).filter((c) => !/^pe-/.test(c)).slice(0, 2).join('.');
  return s.length > 48 ? s.slice(0, 47) + '…' : s;
}

/* Everything for one element: { html, css, fonts, colors, tokensText, label,
 * notes, stats }. May take a few hundred milliseconds on 500 elements. */
function PE_extractRun(root, env) {
  const win = env.win;
  const collected = PE_extractCollect(root, PE_EXTRACT_MAX_ELEMENTS);
  const list = collected.list;
  const included = new Set(list);
  const keepIds = PE_extractReferencedIds(list);
  const notes = [];

  const sandbox = PE_extractCreateSandbox(env.doc);
  if (sandbox.fallback) {
    notes.push('Defaults were measured on the page itself, so its CSS resets count as defaults.');
  }

  try {
    const csCache = new Map();
    const csOf = (el) => {
      let c = csCache.get(el);
      if (!c) { c = win.getComputedStyle(el); csCache.set(el, c); }
      return c;
    };

    const names = Array.from(csOf(root));
    const refs = PE_extractMakeRefs(sandbox, names);
    const baseMap = refs.forElement({ namespaceURI: PE_EXTRACT_HTML_NS, localName: 'div' });
    const baseGet = (p) => baseMap.get(p);
    const classOf = new Map();
    const rules = [];
    let counter = 0;

    for (const el of list) {
      const cs = csOf(el);
      const isRoot = el === root;
      const parentCs = !isRoot && el.parentElement ? csOf(el.parentElement) : null;
      const ref = refs.forElement(el);
      const get = (p) => cs.getPropertyValue(p);
      const refGet = (p) => ref.get(p);

      // A box with nothing inside has no content to size it (icons, spacers,
      // swatches): its width/height can only be authored.
      const hasContent = Array.from(el.childNodes).some((n) => n.nodeType === 1 || (n.nodeType === 3 && /\S/.test(n.data)));
      const keepSize = isRoot || PE_EXTRACT_REPLACED.has(el.localName) ||
        cs.position === 'absolute' || cs.position === 'fixed' || get('float') !== 'none' ||
        !hasContent || PE_EXTRACT_SHRINK_DISPLAYS.has(cs.display) ||
        // A flex/grid item is sized by its own width, not by the parent block.
        (parentCs !== null && PE_EXTRACT_ITEM_PARENTS.test(parentCs.display));

      let decls = PE_extractDiffStyles(names, get, refGet, parentCs ? (p) => parentCs.getPropertyValue(p) : null, { isRoot, keepSize, base: baseGet });
      decls = PE_extractCondense(decls, get, refGet);

      // ::before / ::after — icons and dividers are often only there.
      const pseudo = [];
      for (const which of ['::before', '::after']) {
        const pcs = win.getComputedStyle(el, which);
        const content = pcs.getPropertyValue('content');
        if (!content || content === 'none' || content === 'normal') continue;
        const pref = refs.forPseudo(which);
        const pget = (p) => pcs.getPropertyValue(p);
        const pRefGet = (p) => pref.get(p);
        const pKeep = pcs.position === 'absolute' || pcs.position === 'fixed' || pget('float') !== 'none';
        let pd = PE_extractDiffStyles(names, pget, pRefGet, get, { isRoot: false, keepSize: pKeep });
        pd = PE_extractCondense(pd, pget, pRefGet).filter((d) => d[0] !== 'content');
        pd.unshift(['content', content]);
        pseudo.push({ which, decls: pd });
      }

      if (decls.length || pseudo.length) {
        const cls = 'pe-' + (++counter);
        classOf.set(el, cls);
        rules.push({ selector: '.' + cls, decls });
        pseudo.forEach((p) => rules.push({ selector: `.${cls}${p.which}`, decls: p.decls }));
      }
    }

    const html = PE_extractSerialize(root, {
      included,
      attributes: (el) => PE_extractAttributes(el, {
        keepIds,
        classTokens: PE_extractClassTokens(el.getAttribute('class'), classOf.get(el)),
        resolveUrl: (name, value) => PE_extractResolveUrl(value, env.baseUrl),
        imgSrc: el.localName === 'img' ? (el.currentSrc || '') : ''
      }),
      displayOf: (el) => csOf(el).display,
      preserves: (el) => el.localName === 'pre' || el.localName === 'textarea' || /^pre/.test(csOf(el).whiteSpace)
    });

    const css = PE_extractBuildCss(rules);
    const colors = PE_extractCollectColors(rules.reduce((all, r) => all.concat(r.decls.map((d) => d[1])), []));
    const fonts = PE_extractCollectFonts(list, csOf, env.doc, notes);
    const tokensText = PE_extractTokensText(fonts, colors, notes);

    return {
      html, css, fonts, colors, tokensText, notes,
      label: PE_extractLabel(root),
      stats: {
        total: collected.total,
        shown: list.length,
        truncated: collected.truncated,
        rules: rules.filter((r) => r.decls.length).length,
        fonts: fonts.length,
        colors: colors.length
      }
    };
  } finally {
    sandbox.destroy();
  }
}

/* ─── Clipboard ────────────────────────────────────────────── */

/* navigator.clipboard where the page allows it, otherwise a throwaway
 * <textarea> and execCommand('copy'). Resolves true when something was copied. */
async function PE_extractCopyText(doc, text) {
  try {
    // A page that forbids clipboard-write makes the call log a policy violation
    // in its console even when we catch it: ask first.
    const policy = doc.permissionsPolicy || doc.featurePolicy;
    const allowed = !policy || typeof policy.allowsFeature !== 'function' || policy.allowsFeature('clipboard-write');
    if (allowed && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* blocked by the page's permissions policy: use the fallback */ }

  try {
    const ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed!important;top:-1000px!important;left:0!important;opacity:0!important;';
    doc.documentElement.appendChild(ta);
    ta.select();
    const ok = doc.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch (e) {
    return false;
  }
}

/* ─── The mode ─────────────────────────────────────────────── */

function PE_createExtractMode(host) {
  // The element picker's hover highlight and arrow-key walk are the eraser's,
  // reused as they are (modes/erase.js loads first).
  const picker = PE_createEraseMode(host);

  const OWN_SELECTOR = '#pe-extract-panel, .pe-clippy-buddy, .pe-highlighter, .pe-toast-container, #pe-paint-toolbox, #pe-paint-canvas';
  const inPanel = (n) => !!(n && n.closest && n.closest('#' + PE_EXTRACT_PANEL_ID));

  let panel = null;
  let codeEl = null;
  let statusEl = null;
  let tabButtons = [];
  let result = null;
  let activeTab = 'html';
  let statusTimer = 0;
  let cleanups = [];

  const T = () => (host.isTr
    ? {
        title: 'Koda Çıkar', close: 'Kapat', copy: 'Kopyala', copyFile: 'Tek HTML dosyası olarak kopyala',
        copied: 'Kopyalandı', copyFailed: 'Kopyalanamadı — metni seçip Ctrl+C basın',
        empty: 'Çıkarmak için sayfada bir elemente tıklayın. ↑ ↓ üst/alt elemanı seçer, Esc kapatır.',
        noStyles: 'Tarayıcı varsayılanından farklı stil yok.', noTokens: 'Font veya renk bulunamadı.',
        failed: 'Çıkarma başarısız',
        stats: (s) => `${s.label} · ${s.shown} eleman · ${s.rules} kural · ${s.fonts} font · ${s.colors} renk`,
        truncated: (total, max) => `⚠ Alt ağaçta ${total} eleman var; yalnızca ilk ${max} işlendi.`
      }
    : {
        title: 'Extract to Code', close: 'Close', copy: 'Copy', copyFile: 'Copy as single HTML file',
        copied: 'Copied', copyFailed: 'Copy failed — select the text and press Ctrl+C',
        empty: 'Click an element on the page to extract it. ↑ ↓ pick its parent or child, Esc closes.',
        noStyles: 'No styles differ from the browser defaults.', noTokens: 'No fonts or colors found.',
        failed: 'Extraction failed',
        stats: (s) => `${s.label} · ${s.shown} ${s.shown === 1 ? 'element' : 'elements'} · ${s.rules} ${s.rules === 1 ? 'rule' : 'rules'} · ${s.fonts} ${s.fonts === 1 ? 'font' : 'fonts'} · ${s.colors} ${s.colors === 1 ? 'color' : 'colors'}`,
        truncated: (total, max) => `⚠ The subtree has ${total} elements; only the first ${max} were processed.`
      });

  function listen(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    cleanups.push(() => target.removeEventListener(type, fn, options));
  }

  /* ─── Panel ──────────────────────────────────────────── */

  function summaryText() {
    if (!result) return '';
    const t = T();
    const s = result.stats;
    let text = t.stats({ label: result.label, shown: s.shown, rules: s.rules, fonts: s.fonts, colors: s.colors });
    if (s.truncated) text += '\n' + t.truncated(s.total, PE_EXTRACT_MAX_ELEMENTS);
    return text;
  }

  function flash(message) {
    if (!statusEl) return;
    statusEl.textContent = message;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { if (statusEl) statusEl.textContent = summaryText(); }, 2500);
  }

  function currentText() {
    if (!result) return '';
    const t = T();
    if (activeTab === 'html') return result.html;
    if (activeTab === 'css') return result.css || `/* ${t.noStyles} */`;
    return result.tokensText || `/* ${t.noTokens} */`;
  }

  /* Code goes into the <pre> as text nodes and <span>s built with
   * textContent — the page's own strings never pass through innerHTML. Past
   * a size where highlighting would stall the page it is shown plain. */
  function render() {
    if (!codeEl) return;
    codeEl.textContent = '';
    tabButtons.forEach((b) => {
      const on = b.getAttribute('data-tab') === activeTab;
      b.classList.toggle('pe-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });

    if (!result) { codeEl.textContent = T().empty; return; }

    const text = currentText();
    if (text.length > PE_EXTRACT_MAX_HIGHLIGHT_CHARS) { codeEl.textContent = text; return; }
    const tokens = activeTab === 'html' ? PE_highlightHtml(text) : PE_highlightCss(text);
    if (tokens.length > PE_EXTRACT_MAX_TOKENS) { codeEl.textContent = text; return; }

    const frag = document.createDocumentFragment();
    for (const tk of tokens) {
      if (tk.t === 'text') {
        frag.appendChild(document.createTextNode(tk.s));
      } else {
        const span = document.createElement('span');
        span.className = 'pe-tok pe-tok-' + tk.t;
        span.textContent = tk.s;
        frag.appendChild(span);
      }
    }
    codeEl.appendChild(frag);
    codeEl.scrollTop = 0;
    codeEl.scrollLeft = 0;
  }

  function placePanel() {
    if (!panel) return;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const r = panel.getBoundingClientRect();
    if (!panel.style.left) {
      panel.style.setProperty('left', Math.max(8, vw - r.width - 16) + 'px', 'important');
      return;
    }
    // A smaller window must not strand the panel off screen.
    if (r.right > vw) panel.style.setProperty('left', Math.max(0, vw - r.width - 8) + 'px', 'important');
    if (r.bottom > vh) panel.style.setProperty('top', Math.max(0, vh - r.height - 8) + 'px', 'important');
  }

  function ensurePanel() {
    if (panel) return;
    const t = T();
    panel = document.createElement('div');
    panel.id = PE_EXTRACT_PANEL_ID;
    panel.className = 'pe-paint-toolbox pe-extract-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', t.title);
    panel.innerHTML = `
      <div class="pe-paint-toolbox-titlebar">
        <span class="pe-paint-toolbox-title">${t.title}</span>
        <button class="pe-paint-toolbox-close" type="button" aria-label="${t.close}"></button>
      </div>
      <div class="pe-paint-toolbox-body">
        <div class="pe-extract-tabs" role="tablist">
          <button class="pe-extract-tab pe-active" type="button" role="tab" data-tab="html">HTML</button>
          <button class="pe-extract-tab" type="button" role="tab" data-tab="css">CSS</button>
          <button class="pe-extract-tab" type="button" role="tab" data-tab="tokens">Tokens</button>
        </div>
        <pre class="pe-extract-code" tabindex="0"></pre>
        <div class="pe-extract-status"></div>
        <div class="pe-paint-actions-row" style="display: flex !important; gap: 4px !important;">
          <button class="win-btn pe-extract-copy" type="button" style="flex: 1 !important; font-size: 11px; font-weight: bold;">${t.copy}</button>
          <button class="win-btn pe-extract-copy-file" type="button" style="flex: 2 !important; font-size: 11px; font-weight: bold;">${t.copyFile}</button>
        </div>
      </div>
    `;
    document.documentElement.appendChild(panel);

    codeEl = panel.querySelector('.pe-extract-code');
    statusEl = panel.querySelector('.pe-extract-status');
    tabButtons = Array.from(panel.querySelectorAll('.pe-extract-tab'));

    tabButtons.forEach((b) => b.addEventListener('click', () => {
      activeTab = b.getAttribute('data-tab');
      render();
    }));
    panel.querySelector('.pe-extract-copy').addEventListener('click', async () => {
      if (!result) return;
      flash((await PE_extractCopyText(document, currentText())) ? T().copied : T().copyFailed);
    });
    panel.querySelector('.pe-extract-copy-file').addEventListener('click', async () => {
      if (!result) return;
      const file = PE_extractWrapDocument(`PageEraser extract — ${location.hostname}`, result.html, result.css);
      flash((await PE_extractCopyText(document, file)) ? T().copied : T().copyFailed);
    });
    panel.querySelector('.pe-paint-toolbox-close').addEventListener('click', () => host.modes.deactivate());

    host._makeElementDraggable(panel, panel.querySelector('.pe-paint-toolbox-titlebar'));
    placePanel();
  }

  function removePanel() {
    clearTimeout(statusTimer);
    statusTimer = 0;
    if (panel) {
      if (panel._cleanupDrag) panel._cleanupDrag();
      panel.remove();
    }
    panel = codeEl = statusEl = null;
    tabButtons = [];
  }

  /* ─── Extraction ─────────────────────────────────────── */

  function extractFrom(el) {
    ensurePanel();
    // The picker's crosshair lives on <body> and is inherited by everything: it
    // is ours, not the page's, so it must not end up in the extracted CSS.
    const body = document.body;
    const cursor = body.style.getPropertyValue('cursor');
    const cursorPriority = body.style.getPropertyPriority('cursor');
    body.style.removeProperty('cursor');
    try {
      result = PE_extractRun(el, { win: window, doc: document, baseUrl: location.href });
    } catch (err) {
      result = null;
      codeEl.textContent = '';
      statusEl.textContent = `${T().failed}: ${(err && err.message) || err}`;
      return;
    } finally {
      if (cursor) body.style.setProperty('cursor', cursor, cursorPriority);
    }
    render();
    statusEl.textContent = summaryText();
    host._playSelectionSound();
  }

  /* ─── Mode interface ─────────────────────────────────── */

  return {
    enter(opts) {
      if (!document.body) {
        host.modes.release('extract');
        return;
      }
      host._pickerAction = 'extract';
      host._altPressed = false;
      if (!(opts && opts.silent)) host._playSelectionSound();
      host._ensureHighlighterElements();
      document.body.style.setProperty('cursor', 'crosshair', 'important');
      listen(window, 'resize', placePanel);
    },

    exit() {
      cleanups.forEach((fn) => fn());
      cleanups = [];
      host._pickerAction = null;
      host._altPressed = false;
      if (host.highlighterEl) host.highlighterEl.classList.remove('pe-active', 'pe-extract-mode');
      if (document.body) document.body.style.removeProperty('cursor');
      // removeProperty leaves an empty style="" behind: do not leave even that.
      if (document.body && document.body.getAttribute('style') === '') document.body.removeAttribute('style');
      host.highlightedElement = null;
      host.selectedElement = null;
      removePanel();
      result = null;
      activeTab = 'html';
    },

    onPointerMove(info) {
      if (inPanel(info.target)) return;
      picker.onPointerMove(info);
    },

    onClick(e) {
      const target = e.target;
      if (!target || target.nodeType !== 1) return;
      // Clicks on our own windows must work normally.
      if (target.closest(OWN_SELECTOR)) return;

      e.preventDefault();
      e.stopPropagation();

      const el = host.selectedElement && host.selectedElement.nodeType === 1 ? host.selectedElement : target;
      if (!el || el === document.body || el === document.documentElement) return;
      extractFrom(el);
    },

    onKey(e) {
      // Arrow keys inside the code window scroll it; they do not move the pick.
      if (inPanel(e.target)) return;
      picker.onKey(e);
    }
  };
}

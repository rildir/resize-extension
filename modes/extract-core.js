/**
 * PageEraser Chrome Extension — Extract to Code: pure helpers
 *
 * Everything the Extract mode (modes/extract.js) needs that does not touch the
 * live page: deciding which computed styles are worth writing down, collapsing
 * them into shorthands, cleaning and printing HTML, collecting colours, parsing
 * font declarations, and a small dependency-free syntax highlighter.
 *
 * Nothing here reads the DOM globally or calls a browser API. Elements are
 * only ever accessed through the handful of properties a real DOM node and a
 * plain test double both have (localName, attributes, childNodes, children,
 * nodeType, data, namespaceURI), and computed styles arrive as getter
 * functions. That is what lets tests/run.js exercise all of it in Node.
 *
 * Loaded before modes/extract.js as a classic script — see manifest.json.
 */

const PE_EXTRACT_MAX_ELEMENTS = 500;
const PE_EXTRACT_SVG_NS = 'http://www.w3.org/2000/svg';

// Elements that never become part of an extract. Their effect (styles) is
// already in the computed CSS, or they run code, or they pull in other pages.
const PE_EXTRACT_REMOVE_TAGS = new Set([
  'script', 'iframe', 'noscript', 'style', 'link', 'object', 'embed',
  'template', 'base', 'meta', 'head', 'title'
]);

const PE_EXTRACT_VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'source', 'track', 'wbr'
]);

// display values whose whitespace to neighbours is significant.
const PE_EXTRACT_INLINE_DISPLAYS = new Set([
  'inline', 'inline-block', 'inline-flex', 'inline-grid', 'inline-table',
  'contents', 'ruby', 'ruby-base', 'ruby-text'
]);

/* ─── Escaping ─────────────────────────────────────────────── */

function PE_extractEscapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;');
}

function PE_extractEscapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\u00a0/g, '&nbsp;');
}

/* ─── Which computed properties are worth writing ──────────── */

const PE_EXTRACT_INHERITED = new Set([
  'azimuth', 'border-collapse', 'border-spacing', 'caption-side', 'caret-color', 'color',
  'color-interpolation', 'color-interpolation-filters', 'color-scheme', 'cursor', 'direction',
  'empty-cells', 'forced-color-adjust', 'hyphens', 'image-rendering', 'letter-spacing',
  'line-break', 'line-height', 'orphans', 'overflow-wrap', 'paint-order', 'pointer-events',
  'quotes', 'ruby-position', 'shape-rendering', 'tab-size', 'text-align', 'text-align-last',
  'text-anchor', 'text-indent', 'text-justify', 'text-orientation', 'text-rendering',
  'text-shadow', 'text-size-adjust', 'text-transform', 'text-underline-offset',
  'text-underline-position', 'visibility', 'white-space', 'widows', 'word-break',
  'word-spacing', 'word-wrap', 'writing-mode', 'accent-color', 'clip-rule'
]);

/* Properties that inherit: a child whose value equals its parent's does not
 * need to repeat it. font-*, list-style-*, text-emphasis-*, stroke-*, fill-*,
 * marker-* are families, matched by prefix. */
function PE_extractIsInherited(name) {
  return PE_EXTRACT_INHERITED.has(name) ||
    /^(font|list-style|text-emphasis|stroke|fill|marker)(-|$)/.test(name);
}

const PE_EXTRACT_KEEP_PREFIXED = new Set([
  '-webkit-line-clamp', '-webkit-box-orient', '-webkit-background-clip',
  '-webkit-text-stroke-width', '-webkit-text-stroke-color', '-webkit-mask-image'
]);

// Geometry that depends on the box size at the moment of reading, or that is
// carried by the element's own attributes (SVG).
const PE_EXTRACT_SKIP_EXACT = new Set([
  'transform-origin', 'perspective-origin', 'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y',
  'view-transition-name', 'anchor-name', 'position-anchor'
]);

/* True for properties never worth writing: vendor/internal ones (but a few
 * that have no standard spelling), animations (their @keyframes are not
 * exported), logical duplicates of physical properties (margin-inline-start
 * next to margin-left), and the geometry above. */
function PE_extractSkipProp(name) {
  if (name.charAt(0) === '-') return !PE_EXTRACT_KEEP_PREFIXED.has(name);
  if (name.indexOf('animation') === 0) return true;
  if (/^border-(start|end)-(start|end)-radius$/.test(name)) return true; // logical twins of border-*-radius
  if (/(^|-)(inline|block)(-|$)/.test(name)) return true;
  return PE_EXTRACT_SKIP_EXACT.has(name);
}

// width/height are the *current* box, not an authored value: kept only where
// they are really part of the design (the root, images, positioned elements).
const PE_EXTRACT_SIZE_PROPS = new Set(['width', 'height']);

// The root's margins belong to the page it was on, not to the component.
const PE_EXTRACT_ROOT_SKIP = /^margin-(top|right|bottom|left)$/;

// These resolve `currentcolor` to a concrete colour, so they differ from the
// default on every element with a non-black text colour — even where there is
// no border, outline or underline to colour. Only meaningful when the matching
// style/line is on.
const PE_EXTRACT_DEPENDS = {
  'border-top-color': 'border-top-style',
  'border-right-color': 'border-right-style',
  'border-bottom-color': 'border-bottom-style',
  'border-left-color': 'border-left-style',
  'outline-color': 'outline-style',
  'column-rule-color': 'column-rule-style',
  'row-rule-color': 'row-rule-style',
  '-webkit-text-stroke-color': '-webkit-text-stroke-width',
  'text-decoration-color': 'text-decoration-line',
  'text-emphasis-color': 'text-emphasis-style'
};

/* The declarations to write for one element.
 *   names   every longhand property name to consider
 *   get     name → this element's computed value
 *   ref     name → the browser's default for an empty element of the same tag
 *   parent  name → the parent's computed value, or null for the root
 *   opts    { isRoot, keepSize, base } — base: name → the default of a plain <div>
 * An inherited property is compared with the parent (a child that merely
 * inherits writes nothing; one that resets to the default does write it);
 * everything else with the default. */
function PE_extractDiffStyles(names, get, ref, parent, opts) {
  const o = opts || {};
  const out = [];
  for (const name of names) {
    if (PE_extractSkipProp(name)) continue;
    if (!o.keepSize && PE_EXTRACT_SIZE_PROPS.has(name)) continue;
    if (o.isRoot && PE_EXTRACT_ROOT_SKIP.test(name)) continue;

    const value = get(name);
    if (value == null || value === '') continue;

    const dep = PE_EXTRACT_DEPENDS[name];
    if (dep) {
      const state = get(dep);
      if (state === 'none' || state === 'hidden' || state === '0px') continue;
    }

    if (!o.isRoot && parent && PE_extractIsInherited(name)) {
      if (value !== parent(name)) {
        out.push([name, value]);
      } else if (o.base && ref(name) !== o.base(name) && value !== ref(name)) {
        // The element merely inherits, but the browser has a rule of its own for
        // this tag (a:any-link colour, textarea font…) that would win over the
        // inheritance once the CSS is somewhere else: say it out loud.
        out.push([name, value]);
      }
      continue;
    }
    if (value !== ref(name)) out.push([name, value]);
  }
  return out;
}

/* ─── Shorthands ───────────────────────────────────────────── */

function PE_extractCollapse4(v) {
  const t = v[0], r = v[1], b = v[2], l = v[3];
  if (t === r && r === b && b === l) return t;
  if (t === b && r === l) return `${t} ${r}`;
  if (r === l) return `${t} ${r} ${b}`;
  return `${t} ${r} ${b} ${l}`;
}

/* Fold four-sided longhands into shorthands so the CSS reads like CSS:
 * margin, padding, border (per side or all), border-radius, gap, flex,
 * overflow. `get` reads any property of the same element; `ref` the default.
 * A group is folded as soon as any member was going to be written, using the
 * element's real value for every member. */
function PE_extractCondense(decls, get, ref) {
  const present = new Set(decls.map((d) => d[0]));
  const done = new Set();
  const out = [];
  const SIDES = ['top', 'right', 'bottom', 'left'];
  const take = (names) => names.forEach((n) => done.add(n));

  for (const [name, value] of decls) {
    if (done.has(name)) continue;

    let m;
    if ((m = /^(margin|padding)-(top|right|bottom|left)$/.exec(name))) {
      const base = m[1];
      take(SIDES.map((s) => `${base}-${s}`));
      out.push([base, PE_extractCollapse4(SIDES.map((s) => get(`${base}-${s}`)))]);
      continue;
    }

    if (/^border-(top|right|bottom|left)-(width|style|color)$/.test(name)) {
      const all = [];
      SIDES.forEach((s) => ['width', 'style', 'color'].forEach((p) => all.push(`border-${s}-${p}`)));
      take(all);
      const sideValue = SIDES.map((s) => {
        const style = get(`border-${s}-style`);
        if (style === 'none' || style === 'hidden') {
          // Nothing to draw — but if the browser's default would draw
          // something (fieldset, hr), say so.
          return ref(`border-${s}-style`) !== 'none' ? 'none' : null;
        }
        return `${get(`border-${s}-width`)} ${style} ${get(`border-${s}-color`)}`;
      });
      if (sideValue.every((v) => v !== null && v === sideValue[0])) {
        out.push(['border', sideValue[0]]);
      } else {
        SIDES.forEach((s, i) => { if (sideValue[i] !== null) out.push([`border-${s}`, sideValue[i]]); });
      }
      continue;
    }

    if (/^border-(top-left|top-right|bottom-right|bottom-left)-radius$/.test(name)) {
      const corners = ['top-left', 'top-right', 'bottom-right', 'bottom-left'].map((c) => `border-${c}-radius`);
      const values = corners.map((c) => get(c));
      take(corners);
      if (values.some((v) => /\s/.test(v))) {
        // an elliptical corner cannot be written in the 4-value form
        corners.forEach((c, i) => { if (present.has(c)) out.push([c, values[i]]); });
      } else {
        out.push(['border-radius', PE_extractCollapse4(values)]);
      }
      continue;
    }

    if (name === 'row-gap' || name === 'column-gap') {
      take(['row-gap', 'column-gap']);
      const r = get('row-gap');
      const c = get('column-gap');
      out.push(['gap', r === c ? r : `${r} ${c}`]);
      continue;
    }

    if (name === 'flex-grow' || name === 'flex-shrink' || name === 'flex-basis') {
      take(['flex-grow', 'flex-shrink', 'flex-basis']);
      out.push(['flex', `${get('flex-grow')} ${get('flex-shrink')} ${get('flex-basis')}`]);
      continue;
    }

    if (name === 'overflow-x' || name === 'overflow-y') {
      take(['overflow-x', 'overflow-y']);
      const x = get('overflow-x');
      const y = get('overflow-y');
      out.push(['overflow', x === y ? x : `${x} ${y}`]);
      continue;
    }

    out.push([name, value]);
  }
  return out;
}

/* [{ selector, decls: [[name, value]] }] → stylesheet text. Rules with no
 * declarations are left out. */
function PE_extractBuildCss(rules) {
  return rules
    .filter((r) => r.decls.length > 0)
    .map((r) => `${r.selector} {\n${r.decls.map(([n, v]) => `  ${n}: ${v};`).join('\n')}\n}`)
    .join('\n\n');
}

/* ─── HTML: which elements, which attributes, how to print ─── */

function PE_extractAttrsOf(el) {
  return Array.from(el.attributes || []);
}

/* Is this element left out of an extract (with everything inside it)? */
function PE_extractIsRemoved(el) {
  const tag = String(el.localName || '').toLowerCase();
  if (el.namespaceURI === PE_EXTRACT_SVG_NS) return tag === 'script' || tag === 'style';
  if (PE_EXTRACT_REMOVE_TAGS.has(tag)) return true;
  // <picture>'s alternatives are replaced by the <img>'s resolved source.
  return tag === 'source' && !!el.parentElement && el.parentElement.localName === 'picture';
}

/* The first `max` elements of the subtree in document order, and how many
 * there are in all. Because the list is a prefix of document order, an element
 * missing from it never has a descendant that is present. */
function PE_extractCollect(root, max) {
  const list = [];
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const el = stack.pop();
    if (PE_extractIsRemoved(el)) continue;
    total++;
    if (list.length < max) list.push(el);
    const kids = el.children || [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return { list, total, truncated: total > list.length };
}

const PE_EXTRACT_ID_REF_ATTRS = new Set([
  'for', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns',
  'aria-activedescendant', 'aria-details', 'aria-errormessage', 'aria-flowto',
  'list', 'form', 'headers'
]);

/* Ids that something inside the extract points at (label for=, aria-*, #anchor
 * links, SVG url(#gradient)). Any other id is dropped: ids are the page's
 * business and collide when the snippet lands in another one. */
function PE_extractReferencedIds(elements) {
  const ids = new Set();
  const add = (v) => { if (v) ids.add(v); };
  for (const el of elements) {
    for (const a of PE_extractAttrsOf(el)) {
      const n = a.name.toLowerCase();
      if (PE_EXTRACT_ID_REF_ATTRS.has(n)) {
        a.value.split(/\s+/).forEach(add);
      } else if ((n === 'href' || n === 'xlink:href') && a.value.charAt(0) === '#' && a.value.length > 1) {
        let id = a.value.slice(1);
        try { id = decodeURIComponent(id); } catch (e) { /* keep as is */ }
        add(id);
      }
      const re = /url\(\s*['"]?#([^)'"\s]+)/g;
      let m;
      while ((m = re.exec(a.value))) add(m[1]);
    }
  }
  return ids;
}

const PE_EXTRACT_URL_ATTRS = new Set([
  'href', 'src', 'poster', 'action', 'formaction', 'cite', 'background', 'xlink:href'
]);

/* The attributes to write for one element, id and class first.
 * Removed: style (replaced by the generated CSS), data-*, on* handlers, nonce
 * and integrity, srcset/sizes on images, and every id nothing refers to.
 *   opts.keepIds      Set of ids to keep
 *   opts.classTokens  the final class list (original + generated)
 *   opts.resolveUrl   (attrName, value) → value
 *   opts.imgSrc       an <img>'s resolved source (currentSrc) */
function PE_extractAttributes(el, opts) {
  const o = opts || {};
  const tag = String(el.localName || '').toLowerCase();
  const rest = [];
  let id = null;
  let sawSrc = false;

  for (const a of PE_extractAttrsOf(el)) {
    const name = a.name;
    const n = name.toLowerCase();
    const value = a.value;

    if (n === 'style' || n === 'class') continue;
    if (n.indexOf('on') === 0 || n.indexOf('data-') === 0) continue;
    if (n === 'nonce' || n === 'integrity' || n === 'crossorigin' || n === 'autofocus' || n === 'fetchpriority') continue;
    if ((tag === 'img' || tag === 'source') && (n === 'srcset' || n === 'sizes')) continue;
    if (n === 'id') {
      if (o.keepIds && o.keepIds.has(value)) id = value;
      continue;
    }
    if (PE_EXTRACT_URL_ATTRS.has(n)) {
      if (tag === 'img' && n === 'src') {
        sawSrc = true;
        rest.push([name, o.imgSrc || (o.resolveUrl ? o.resolveUrl(n, value) : value)]);
      } else {
        rest.push([name, o.resolveUrl ? o.resolveUrl(n, value) : value]);
      }
      continue;
    }
    rest.push([name, value]);
  }
  if (tag === 'img' && !sawSrc && o.imgSrc) rest.push(['src', o.imgSrc]);

  const out = [];
  if (id !== null) out.push(['id', id]);
  if (o.classTokens && o.classTokens.length) out.push(['class', o.classTokens.join(' ')]);
  return out.concat(rest);
}

/* The original class list without our own animation classes, plus `generated`. */
function PE_extractClassTokens(classAttr, generated) {
  const tokens = String(classAttr || '').split(/\s+/).filter((t) => t && !/^pe-(erasing|restoring)$/.test(t));
  if (generated) tokens.push(generated);
  return tokens;
}

/* Pretty-prints the subtree as HTML without changing how it renders: line
 * breaks and indentation go only between block-level children, whose
 * whitespace is insignificant. Anything with text or inline-level children is
 * kept on one line with whitespace collapsed to single spaces.
 *
 * ctx = {
 *   included      Set of elements that are part of the extract
 *   attributes    el → [[name, value]] (see PE_extractAttributes)
 *   displayOf     el → computed display
 *   preserves     el → true when whitespace is significant (pre, textarea…)
 * } */
function PE_extractSerialize(root, ctx) {
  const IND = '  ';
  const isSvg = (el) => el.namespaceURI === PE_EXTRACT_SVG_NS;
  const SVG_TEXT = new Set(['text', 'tspan', 'textPath']);

  const inlineLevel = (el) => {
    if (isSvg(el)) return SVG_TEXT.has(el.localName);
    return PE_EXTRACT_INLINE_DISPLAYS.has(ctx.displayOf(el));
  };
  // Whitespace at the edge of these is significant to the siblings around them.
  const edgeSensitive = (el) => {
    if (isSvg(el)) return SVG_TEXT.has(el.localName);
    const d = ctx.displayOf(el);
    return d === 'inline' || d === 'contents';
  };

  const openTag = (el) => {
    const attrs = ctx.attributes(el).map(([n, v]) => (v === '' ? ` ${n}` : ` ${n}="${PE_extractEscapeAttr(v)}"`)).join('');
    return `<${el.localName}${attrs}>`;
  };
  const closeTag = (el) => `</${el.localName}>`;
  const textOf = (n) => (n.data !== undefined ? n.data : n.nodeValue) || '';
  const collapse = (s, keep) => (keep ? s : s.replace(/[ \t\r\n\f]+/g, ' '));

  const flatChildren = (el, keep) => {
    let s = '';
    for (const n of Array.from(el.childNodes || [])) {
      if (n.nodeType === 3) s += PE_extractEscapeText(collapse(textOf(n), keep));
      else if (n.nodeType === 1 && ctx.included.has(n)) s += flat(n);
    }
    return s;
  };

  function flat(el) {
    const open = openTag(el);
    if (PE_EXTRACT_VOID_TAGS.has(el.localName)) return open;
    return open + flatChildren(el, ctx.preserves(el)) + closeTag(el);
  }

  function block(el, depth) {
    const pad = IND.repeat(depth);
    const open = openTag(el);
    if (PE_EXTRACT_VOID_TAGS.has(el.localName)) return pad + open;

    const kids = Array.from(el.childNodes || []).filter((n) =>
      (n.nodeType === 1 && ctx.included.has(n)) || (n.nodeType === 3 && textOf(n) !== ''));
    if (kids.length === 0) return pad + open + closeTag(el);

    const keep = ctx.preserves(el);
    const hasText = kids.some((n) => n.nodeType === 3 && (keep || /\S/.test(textOf(n))));
    const hasInline = kids.some((n) => n.nodeType === 1 && inlineLevel(n));

    if (keep || hasText || hasInline) {
      let inner = flatChildren(el, keep);
      if (!keep && !edgeSensitive(el)) inner = inner.trim();
      return pad + open + inner + closeTag(el);
    }

    const lines = kids.filter((n) => n.nodeType === 1).map((n) => block(n, depth + 1));
    if (lines.length === 0) return pad + open + closeTag(el);
    return `${pad}${open}\n${lines.join('\n')}\n${pad}${closeTag(el)}`;
  }

  return block(root, 0);
}

/* ─── Colours ──────────────────────────────────────────────── */

/* 'rgb(26, 43, 60)' → '#1a2b3c'; 'rgba(0, 0, 0, 0.5)' → '#00000080';
 * anything else → null. */
function PE_extractRgbToHex(str) {
  const m = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)(?:\s*[,/]\s*(\d*\.?\d+%?))?\s*\)$/i.exec(String(str).trim());
  if (!m) return null;
  const hex = (n) => Math.max(0, Math.min(255, Math.round(parseFloat(n)))).toString(16).padStart(2, '0');
  let out = '#' + hex(m[1]) + hex(m[2]) + hex(m[3]);
  if (m[4] !== undefined) {
    let a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    a = Math.max(0, Math.min(1, a));
    if (a < 1) out += hex(a * 255);
  }
  return out;
}

/* Every distinct colour found in the given declaration values, most used
 * first: [{ hex, count }]. Fully transparent colours are ignored. */
function PE_extractCollectColors(values) {
  const counts = new Map();
  for (const v of values) {
    const re = /rgba?\([^)]*\)/gi;
    let m;
    while ((m = re.exec(String(v)))) {
      const hex = PE_extractRgbToHex(m[0]);
      if (!hex || (hex.length === 9 && hex.slice(7) === '00')) continue;
      counts.set(hex, (counts.get(hex) || 0) + 1);
    }
  }
  return Array.from(counts, ([hex, count]) => ({ hex, count }))
    .sort((a, b) => b.count - a.count);
}

/* ─── Fonts ────────────────────────────────────────────────── */

const PE_EXTRACT_GENERIC_FONTS = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif',
  'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong'
]);

/* 'Inter, "Helvetica Neue", sans-serif' → ['Inter', 'Helvetica Neue', 'sans-serif'] */
function PE_extractParseFontFamily(value) {
  const out = [];
  let cur = '';
  let quote = '';
  const flush = () => {
    let name = cur.trim();
    if (name.length > 1 && /^["']/.test(name) && name.charAt(name.length - 1) === name.charAt(0)) name = name.slice(1, -1);
    if (name) out.push(name);
    cur = '';
  };
  for (const ch of String(value == null ? '' : value)) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      flush();
    } else {
      cur += ch;
    }
  }
  flush();
  return out;
}

/* A @font-face `src` value → [{ url, format }], URLs made absolute against `base`. */
function PE_extractParseFontSrc(value, base) {
  const out = [];
  const re = /url\(\s*(['"]?)(.*?)\1\s*\)(?:\s*format\(\s*(['"]?)(.*?)\3\s*\))?/gi;
  let m;
  while ((m = re.exec(String(value == null ? '' : value)))) {
    let url = m[2];
    try { url = new URL(url, base).href; } catch (e) { /* leave relative */ }
    out.push({ url, format: m[4] || '' });
  }
  return out;
}

/* The Tokens tab as text. Fonts are comments (the font files themselves are
 * never fetched), colours are a ready-to-paste :root block.
 *   fonts   [{ family, stack, count, web, faces: [{ weight, style, status, urls: [{url, format}] }] }]
 *   colors  [{ hex, count }]
 *   notes   [string] */
function PE_extractTokensText(fonts, colors, notes) {
  const lines = [];
  if (fonts.length) {
    lines.push('/* Fonts */');
    for (const f of fonts) {
      lines.push(`/* ${f.stack} — ${f.count} element${f.count === 1 ? '' : 's'} */`);
      if (!f.web) {
        lines.push('/*   no @font-face found: a system or generic font */');
        continue;
      }
      for (const face of f.faces) {
        lines.push(`/*   ${f.family} ${face.weight} ${face.style}${face.status ? ' · ' + face.status : ''} */`);
        for (const u of face.urls) lines.push(`/*   ${u.url}${u.format ? ' (' + u.format + ')' : ''} */`);
      }
    }
  }
  if (colors.length) {
    if (lines.length) lines.push('');
    lines.push('/* Colors */');
    lines.push(':root {');
    colors.forEach((c, i) => lines.push(`  --pe-color-${i + 1}: ${c.hex}; /* ${c.count}× */`));
    lines.push('}');
  }
  if (notes && notes.length) {
    if (lines.length) lines.push('');
    notes.forEach((n) => lines.push(`/* ${n} */`));
  }
  return lines.join('\n');
}

/* ─── URLs ─────────────────────────────────────────────────── */

/* Make a link work outside the page it came from: relative URLs become
 * absolute, javascript: links become '#', in-page '#anchors', data:, blob:,
 * mailto: and tel: stay as they are. */
function PE_extractResolveUrl(value, base) {
  const v = String(value == null ? '' : value).trim();
  if (!v || v.charAt(0) === '#') return value;
  if (/^javascript:/i.test(v)) return '#';
  if (/^(data|blob|mailto|tel|sms|about):/i.test(v)) return value;
  try { return new URL(v, base).href; } catch (e) { return value; }
}

/* ─── One self-contained file ──────────────────────────────── */

function PE_extractWrapDocument(title, html, css) {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${PE_extractEscapeText(title)}</title>`,
    '<style>',
    String(css).replace(/<\/style/gi, '<\\/style'),
    '</style>',
    '</head>',
    '<body>',
    html,
    '</body>',
    '</html>',
    ''
  ].join('\n');
}

/* ─── Syntax highlighting ──────────────────────────────────── */
/* Both tokenizers return [{ t: kind, s: text }] and are lossless: joining the
 * `s` of every token gives back the input exactly. The panel turns tokens into
 * <span>s with textContent, so page-controlled text never reaches innerHTML. */

function PE_highlightHtml(code) {
  const out = [];
  const n = code.length;
  const push = (t, s) => { if (s) out.push({ t, s }); };
  let i = 0;

  while (i < n) {
    const lt = code.indexOf('<', i);
    if (lt === -1) { push('text', code.slice(i)); break; }
    if (lt > i) push('text', code.slice(i, lt));

    const m = /^<(\/?)([A-Za-z][\w:.-]*)/.exec(code.slice(lt, lt + 80));
    if (!m) { push('text', '<'); i = lt + 1; continue; }

    push('punct', '<' + m[1]);
    push('tag', m[2]);
    i = lt + m[0].length;

    while (i < n && code[i] !== '>') {
      const ch = code[i];
      if (/\s/.test(ch)) {
        let j = i;
        while (j < n && /\s/.test(code[j])) j++;
        push('text', code.slice(i, j));
        i = j;
      } else if (ch === '/') {
        push('punct', '/');
        i++;
      } else if (ch === '=') {
        push('punct', '=');
        i++;
        if (code[i] === '"' || code[i] === "'") {
          const q = code[i];
          const end = code.indexOf(q, i + 1);
          const e = end === -1 ? n : end + 1;
          push('string', code.slice(i, e));
          i = e;
        } else {
          let j = i;
          while (j < n && !/[\s>]/.test(code[j])) j++;
          push('string', code.slice(i, j));
          i = j;
        }
      } else {
        let j = i;
        while (j < n && !/[\s=>/]/.test(code[j])) j++;
        if (j === i) j = i + 1;
        push('attr', code.slice(i, j));
        i = j;
      }
    }
    if (i < n) { push('punct', '>'); i++; }
  }
  return out;
}

function PE_highlightCss(code) {
  const out = [];
  const n = code.length;
  const push = (t, s) => { if (s) out.push({ t, s }); };
  // One value token: whitespace | string | #hex | number(+unit) | function name | keyword | punctuation | anything
  const valueToken = /\s+|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|#[0-9a-fA-F]{3,8}(?![\w-])|-?\d*\.?\d+[a-zA-Z%]*|[A-Za-z_-][\w-]*(?=\()|[A-Za-z_-][\w-]*|[(),/]|[^\s]/y;

  let i = 0;
  let depth = 0;
  let mode = 'selector'; // selector | prop | value

  while (i < n) {
    const ch = code[i];

    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      const e = end === -1 ? n : end + 2;
      push('comment', code.slice(i, e));
      i = e;
    } else if (ch === '{') {
      push('punct', '{'); depth++; mode = 'prop'; i++;
    } else if (ch === '}') {
      push('punct', '}'); depth = Math.max(0, depth - 1); mode = depth ? 'prop' : 'selector'; i++;
    } else if (mode === 'selector') {
      let j = i;
      while (j < n && code[j] !== '{' && !(code[j] === '/' && code[j + 1] === '*')) j++;
      push('selector', code.slice(i, j));
      i = j;
    } else if (mode === 'prop') {
      if (/\s/.test(ch) || ch === ';') {
        push('text', ch); i++;
      } else if (ch === ':') {
        push('punct', ':'); mode = 'value'; i++;
      } else {
        let j = i;
        while (j < n && !/[:;{}\s]/.test(code[j])) j++;
        if (j === i) j = i + 1;
        const name = code.slice(i, j);
        push(name.indexOf('--') === 0 ? 'var' : 'prop', name);
        i = j;
      }
    } else if (ch === ';') {
      push('punct', ';'); mode = 'prop'; i++;
    } else {
      valueToken.lastIndex = i;
      const m = valueToken.exec(code);
      const tok = m ? m[0] : ch;
      let kind = 'keyword';
      if (/^\s/.test(tok)) kind = 'text';
      else if (/^["']/.test(tok)) kind = 'string';
      else if (tok.charAt(0) === '#' && tok.length > 1) kind = 'color';
      else if (/^-?\d*\.?\d+[a-zA-Z%]*$/.test(tok)) kind = 'number';
      else if (/^[(),/]$/.test(tok)) kind = 'punct';
      else if (/^[A-Za-z_-]/.test(tok) && code[i + tok.length] === '(') kind = 'func';
      push(kind, tok);
      i += tok.length || 1;
    }
  }
  return out;
}

// Lets tests/run.js load these in Node; a no-op inside the extension.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PE_EXTRACT_MAX_ELEMENTS, PE_EXTRACT_SVG_NS, PE_EXTRACT_GENERIC_FONTS,
    PE_extractEscapeText, PE_extractEscapeAttr,
    PE_extractIsInherited, PE_extractSkipProp, PE_extractDiffStyles,
    PE_extractCondense, PE_extractBuildCss,
    PE_extractIsRemoved, PE_extractCollect, PE_extractReferencedIds,
    PE_extractAttributes, PE_extractClassTokens, PE_extractSerialize, PE_extractResolveUrl,
    PE_extractRgbToHex, PE_extractCollectColors,
    PE_extractParseFontFamily, PE_extractParseFontSrc, PE_extractTokensText,
    PE_extractWrapDocument, PE_highlightHtml, PE_highlightCss
  };
}

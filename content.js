/**
 * PageEraser Chrome Extension — Content Script
 *
 * Interactively select and hide elements from any webpage.
 * Saves hidden element selectors persistently to storage.
 *
 * @version 1.0.0
 */
(function () {
  'use strict';

  const DEBUG = false;

  // Eraser sweep animation. content.css (.pe-erasing / .pe-restoring) plays
  // the same 350ms — keep the two in step; tests/run.js checks that they are.
  const PE_SWEEP_MS = 350;
  // How long a rule write waits for its Web Lock before it carries on without it.
  const PE_LOCK_WAIT_MS = 2000;
  // Concurrent sweeps allowed before the effect is skipped.
  const PE_SWEEP_MAX_ACTIVE = 6;
  // Restoring more elements than this in one go (Restore All on a busy site)
  // skips the effect entirely rather than masking dozens of subtrees at once.
  const PE_SWEEP_BULK_LIMIT = 6;
  const PE_XHTML_NS = 'http://www.w3.org/1999/xhtml';
  const PE_SVG_NS = 'http://www.w3.org/2000/svg';

  /* ─── Extension Context Guard ───────────────────────────────
   * When the extension is reloaded, updated or disabled, every content script
   * already running in an open tab is orphaned: `chrome.runtime.id` becomes
   * undefined and every chrome.* call throws "Extension context invalidated".
   * Without this guard each orphaned tab spews uncaught rejections for the
   * rest of its life, and the user sees a half-dead UI with no explanation.
   *
   * `chrome.runtime.id` is the cheapest reliable liveness probe.
   */
  function isContextAlive() {
    try {
      return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
    } catch (err) {
      return false;
    }
  }

  let contextLost = false;
  const contextLostCallbacks = [];

  function onContextLost(fn) {
    contextLostCallbacks.push(fn);
  }

  function noteContextLost() {
    if (contextLost) return;
    contextLost = true;
    // Strip our own UI: leaving a highlighter or toolbox on the page after the
    // extension is gone would trap the user with controls that do nothing.
    contextLostCallbacks.forEach(fn => {
      try { fn(); } catch (err) { /* nothing left to report to */ }
    });
  }

  /* A storage facade that degrades instead of throwing. Reads resolve to an
   * empty result and writes resolve to false, so callers keep working against
   * a page that simply has no saved rules. */
  const rawStorage = chrome.storage.local || chrome.storage.sync;

  const storage = {
    async get(keys) {
      if (!isContextAlive()) {
        noteContextLost();
        return {};
      }
      try {
        return await rawStorage.get(keys);
      } catch (err) {
        if (!isContextAlive()) noteContextLost();
        return {};
      }
    },
    async set(items) {
      if (!isContextAlive()) {
        noteContextLost();
        return false;
      }
      try {
        await rawStorage.set(items);
        return true;
      } catch (err) {
        // Quota exceeded and the like: the write failed, the extension is fine.
        if (!isContextAlive()) noteContextLost();
        return false;
      }
    },
    async remove(keys) {
      if (!isContextAlive()) {
        noteContextLost();
        return false;
      }
      try {
        await rawStorage.remove(keys);
        return true;
      } catch (err) {
        if (!isContextAlive()) noteContextLost();
        return false;
      }
    }
  };

  // Page-controlled strings (tag names, ids, class names) end up in our
  // tooltip/toast markup — escape them before any innerHTML assignment.
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ─── Sound Synthesizer (Web Audio API) ────────────────────
  const RetroAudio = {
    ctx: null,
    canPlayAudio() {
      return navigator.userActivation && navigator.userActivation.hasBeenActive;
    },
    getOrCreateCtx() {
      if (!this.canPlayAudio()) return null;
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      }
      // Attempt to resume if suspended
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    },
    async isEnabled() {
      try {
        const data = await storage.get('pe_sounds');
        return data.pe_sounds !== false; // defaults to true
      } catch {
        return true;
      }
    },
    async playSelection() {
      if (!this.canPlayAudio() || !await this.isEnabled()) return;
      const ctx = this.getOrCreateCtx();
      if (!ctx) return;
      const now = ctx.currentTime;
      this._playNote(523.25, now, 0.08, 'square');
      this._playNote(659.25, now + 0.08, 0.08, 'square');
      this._playNote(783.99, now + 0.16, 0.16, 'square');
    },
    async playAction(type) {
      if (!this.canPlayAudio() || !await this.isEnabled()) return;
      const ctx = this.getOrCreateCtx();
      if (!ctx) return;
      const now = ctx.currentTime;
      
      if (type === 'hide' || type === 'erase') {
        this._playNote(880, now, 0.04, 'triangle');
        this._playNote(440, now + 0.04, 0.04, 'triangle');
      } else if (type === 'stretch') {
        try {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(300, now);
          osc.frequency.exponentialRampToValueAtTime(800, now + 0.25);
          gain.gain.setValueAtTime(0.04, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);
          osc.stop(now + 0.25);
        } catch (e) {}
      } else if (type === 'reset') {
        this._playNote(523.25, now, 0.06, 'sawtooth');
        this._playNote(392.00, now + 0.06, 0.06, 'sawtooth');
        this._playNote(261.63, now + 0.12, 0.12, 'sawtooth');
      }
    },
    _playNote(freq, start, duration, type = 'sine') {
      if (!this.canPlayAudio()) return;
      try {
        const ctx = this.getOrCreateCtx();
        if (!ctx) return;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.04, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + duration);
      } catch (e) {}
    },
    async playReset() {
      await this.playAction('reset');
    },
    async playChomp() {
      if (!this.canPlayAudio() || !await this.isEnabled()) return;
      const ctx = this.getOrCreateCtx();
      if (!ctx) return;
      const now = ctx.currentTime;
      this._playNote(120, now, 0.05, 'sawtooth');
      this._playNote(90, now + 0.08, 0.08, 'sawtooth');
    },
    async playSwish() {
      if (!this.canPlayAudio() || !await this.isEnabled()) return;
      const ctx = this.getOrCreateCtx();
      if (!ctx) return;
      const now = ctx.currentTime;
      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(600, now);
        osc.frequency.exponentialRampToValueAtTime(1500, now + 0.15);
        gain.gain.setValueAtTime(0.02, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.15);
      } catch(e) {}
    }
  };

  class PageEraser {
    constructor() {
      this.active = false;
      this.domain = window.location.hostname;
      this.isTr = navigator.language.startsWith('tr');
      
      // Selection targets
      this.highlightedElement = null;
      this.selectedElement = null;
      this._lastRightClickedEl = null;
      this._undoStack = [];

      // DOM Elements
      this.highlighterEl = null;
      this.tooltipEl = null;

      // Modes. The manager owns the page-level listeners and guarantees that
      // only one mode is active at a time — see modes/index.js.
      this.modes = new PE_ModeManager();
      this.modes.register('erase', PE_createEraseMode(this));
      this.modes.register('paint', {
        enter: () => {
          this._enterPaintMode();
          // Nothing opened (a canvas was already there): don't stay "active".
          if (!this._stopPaintFn) this.modes.release('paint');
        },
        exit: () => {
          if (this._stopPaintFn) this._stopPaintFn();
        }
      });
      this.modes.register('xray', PE_createXrayMode(this));
      this.modes.register('extract', PE_createExtractMode(this));
      this.modes.register('diff', PE_createDiffMode(this));

      // Selectors whose erase sweep is still playing. Their stylesheet rule is
      // held back until the wipe finishes, otherwise the rule would hide the
      // element instantly and there would be nothing left to animate.
      this._sweeping = new Set();
      this._activeSweeps = 0;

      // Track last right-clicked element for Context Menus
      document.addEventListener('contextmenu', (e) => {
        this._lastRightClickedEl = e.target;
      }, true);

      // If the extension is reloaded or updated while this tab is open, clean
      // our UI off the page instead of leaving dead controls behind.
      onContextLost(() => this._teardownOnContextLoss());

      this._init();
    }

    /* ─── Init ──────────────────────────────────────────────── */

    async _init() {
      try {
        // Answer the popup and the keyboard shortcuts right away. Registering them
        // after the first storage round trip left a window in which the page was
        // still loading and nothing here was listening yet. The one cost of going
        // first: a toast in those first milliseconds uses the browser's language
        // (set in the constructor) instead of the one saved in the popup.
        this._setupMessageListener();
        this._setupKeyListeners();

        // Load initial dynamic language setting
        const langData = await storage.get('pe_lang');
        if (langData && langData.pe_lang) {
          this.isTr = langData.pe_lang === 'tr';
        }

        // Listen for live language updates from the popup
        if (chrome.storage.onChanged) {
          chrome.storage.onChanged.addListener((changes) => {
            if (changes.pe_lang) {
              this.isTr = changes.pe_lang.newValue === 'tr';
              this._updatePaintbrushLanguage();
              if (this.active) {
                this._updateHighlight();
              }
            }
          });
        }

        // Load and apply hidden elements immediately (runs at document_start)
        await this._loadAndApplyErasedElements();
      } catch (err) {
        this._log('Init error:', err);
      }
    }

    _updatePaintbrushLanguage() {
      const toolbox = document.getElementById('pe-paint-toolbox');
      if (!toolbox) return;
      
      const isTr = this.isTr;
      const titleEl = toolbox.querySelector('.pe-paint-toolbox-title');
      if (titleEl) titleEl.textContent = isTr ? 'Boya 95' : 'Paintbrush 95';
      
      const labels = toolbox.querySelectorAll('.pe-paint-label');
      if (labels.length >= 3) {
        labels[0].textContent = isTr ? 'Araçlar' : 'Tools';
        labels[1].textContent = isTr ? 'Boyut' : 'Size';
        labels[2].textContent = isTr ? 'Palet' : 'Palette';
      }
      
      const brushText = toolbox.querySelector('#pe-tool-brush .pe-paint-tool-text');
      if (brushText) brushText.textContent = isTr ? 'Fırça' : 'Brush';
      
      const sprayText = toolbox.querySelector('#pe-tool-spray .pe-paint-tool-text');
      if (sprayText) sprayText.textContent = isTr ? 'Sprey' : 'Spray';
      
      const eraserText = toolbox.querySelector('#pe-tool-eraser .pe-paint-tool-text');
      if (eraserText) eraserText.textContent = isTr ? 'Silgi' : 'Eraser';
      
      const undoBtn = document.getElementById('pe-paint-undo');
      if (undoBtn) undoBtn.textContent = isTr ? 'Geri Al' : 'Undo';
      
      const clearBtn = document.getElementById('pe-paint-clear');
      if (clearBtn) clearBtn.textContent = isTr ? 'Temizle' : 'Clear All';
    }

    _log(...args) {
      if (DEBUG) console.log('[PageEraser]', ...args);
    }

    // Used by modes/erase.js, which cannot reach the audio engine directly.
    _playSelectionSound() {
      RetroAudio.playSelection();
    }

    // Small settings access for modes, which cannot reach the storage facade.
    async _getSetting(key, fallback) {
      const data = await storage.get(key);
      return data[key] === undefined ? fallback : data[key];
    }

    _saveSetting(key, value) {
      return storage.set({ [key]: value });
    }

    _removeSetting(key) {
      return storage.remove(key);
    }

    /* Bytes still free in chrome.storage.local, or Infinity when that cannot be
     * read. Rules and Visual Diff's remembered design image share one 10 MB
     * quota; Visual Diff asks here so an image can never crowd the rules out. */
    async _storageHeadroom() {
      try {
        if (!isContextAlive()) return 0;
        const used = await rawStorage.getBytesInUse(null);
        const quota = typeof rawStorage.QUOTA_BYTES === 'number' ? rawStorage.QUOTA_BYTES : 10485760;
        return Math.max(0, quota - used);
      } catch (err) {
        return Infinity;
      }
    }

    /* Layout X-Ray's Capture: ask the service worker for a screenshot of the
     * visible tab. Always resolves — { dataUrl } or { error } — never rejects. */
    _captureTab() {
      return new Promise((resolve) => {
        if (!isContextAlive()) {
          noteContextLost();
          resolve({ error: 'Extension context lost' });
          return;
        }
        try {
          chrome.runtime.sendMessage({ type: 'CAPTURE_TAB' }, (response) => {
            if (chrome.runtime.lastError) {
              resolve({ error: chrome.runtime.lastError.message });
              return;
            }
            resolve(response || { error: 'No response' });
          });
        } catch (err) {
          noteContextLost();
          resolve({ error: String(err && err.message || err) });
        }
      });
    }

    /* ─── Eraser Sweep Animation ────────────────────────────────
     * A 350ms wipe, left to right, done with a CSS mask on the element itself
     * (see .pe-erasing in content.css) — no canvas, no clone. Anything that
     * cannot be wiped cleanly falls back to the old instant hide. */

    _prefersReducedMotion() {
      try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch (e) {
        return false;
      }
    }

    _canSweep(element) {
      if (this._prefersReducedMotion()) return false;
      if (this._activeSweeps >= PE_SWEEP_MAX_ACTIVE) return false;
      if (!element || !element.isConnected || element.namespaceURI !== PE_XHTML_NS) return false;

      const display = window.getComputedStyle(element).display;
      if (display === 'none' || display === 'contents') return false;
      // The sweep class overrides mask-image with !important, and the element's
      // own mask would pop back when the class comes off: leave those alone.
      if (this._hasOwnMask(element)) return false;

      // Nobody sees an off-screen element being wiped, and a mask on a huge
      // subtree is not free: skip both.
      const r = element.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
    }

    _hasOwnMask(element) {
      const cs = window.getComputedStyle(element);
      const mask = cs.maskImage || cs.webkitMaskImage;
      return !!mask && mask !== 'none';
    }

    /* Adds the sweep class and resolves when the animation is over (or the
     * safety timer fires — display:contents, a page that removes the node, and
     * a backgrounded tab all mean animationend never arrives). */
    _playSweep(element, kind) {
      return new Promise((resolve) => {
        const cls = kind === 'restore' ? 'pe-restoring' : 'pe-erasing';
        let finished = false;
        let timer = null;
        this._activeSweeps++;

        const onEnd = (e) => {
          if (e.target === element && e.animationName === 'pe-erase-sweep') finish();
        };
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          element.removeEventListener('animationend', onEnd);
          element.classList.remove(cls);
          this._activeSweeps--;
          resolve();
        };

        element.addEventListener('animationend', onEnd);
        timer = setTimeout(finish, PE_SWEEP_MS + 200);
        element.classList.add(cls);
      });
    }

    _sweepErase(element, selector) {
      this._sweeping.add(selector);
      this._playSweep(element, 'erase').then(() => {
        // Restored (or reset) while the wipe was playing: leave it alone.
        if (!this._sweeping.has(selector)) return;
        this._sweeping.delete(selector);
        element.style.setProperty('display', 'none', 'important');
        // Let the stylesheet take over, now that the rule may apply.
        this._loadAndApplyErasedElements();
      });
    }

    /* Call right before un-hiding. Masks every currently hidden match so the
     * wipe plays in reverse as it reappears. A bulk restore skips the effect. */
    _beginRestoreSweeps(selectors) {
      if (this._prefersReducedMotion()) return;

      const targets = [];
      for (const sel of selectors) {
        let found;
        try {
          found = document.querySelectorAll(sel);
        } catch (e) {
          continue; // not a valid selector any more
        }
        for (const el of found) {
          if (el.namespaceURI !== PE_XHTML_NS) continue;
          // Stretch rules leave the element visible: nothing to wipe in.
          if (window.getComputedStyle(el).display !== 'none') continue;
          // Same reason as _canSweep: do not override a mask the page set.
          if (this._hasOwnMask(el)) continue;
          targets.push(el);
          if (targets.length > PE_SWEEP_BULK_LIMIT) return;
        }
      }
      targets.forEach(el => this._playSweep(el, 'restore'));
    }

    /* ─── Persistent CSS Hiding ──────────────────────────────── */

    async _getDomain() {
      try {
        const data = await storage.get('pe_all_subdomains');
        const hostname = window.location.hostname;
        // Shared with the popup via shared.js — see PE_getBaseDomain.
        return data.pe_all_subdomains === true
          ? PE_getBaseDomain(hostname)
          : hostname;
      } catch (e) {
        return window.location.hostname;
      }
    }

    /* Two tabs of one site that erase at the same moment both read the rule
     * list, add their rule and write it back, and the later write used to wipe
     * the earlier one. Web Locks (https pages) make them take turns. Where
     * they are missing, or refuse to work, the work simply runs unlocked.
     * Lock names are shared with the page's own scripts, so a page could hold
     * this one for good; waiting is capped (PE_LOCK_WAIT_MS) and then the write
     * goes ahead without the lock instead of never happening. */
    async _withRulesLock(key, work) {
      const locks = (typeof navigator !== 'undefined') ? navigator.locks : null;
      if (!locks || typeof locks.request !== 'function') return work();
      let started = false;
      const waiting = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = waiting ? setTimeout(() => waiting.abort(), PE_LOCK_WAIT_MS) : null;
      try {
        return await locks.request('pe-rules:' + key, waiting ? { signal: waiting.signal } : {}, async () => {
          started = true;
          if (timer) clearTimeout(timer);
          return work();
        });
      } catch (err) {
        if (started) throw err;
        return work();
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    async _loadAndApplyErasedElements() {
      try {
        const domain = await this._getDomain();
        const key = `pe_selectors_${domain}`;
        const data = await storage.get(key);
        const selectors = data[key] || [];
        this._applySelectors(selectors);
      } catch (err) {
        this._log('Error loading selectors:', err);
      }
    }

    _applySelectors(selectors) {
      let styleEl = document.getElementById('pe-stylesheet');
      if (!styleEl) {
        // createElementNS: in an SVG or XML document createElement makes a
        // style element in no namespace, which no browser applies.
        const svgRoot = document.documentElement.namespaceURI === PE_SVG_NS;
        styleEl = document.createElementNS(svgRoot ? PE_SVG_NS : PE_XHTML_NS, 'style');
        styleEl.id = 'pe-stylesheet';
        // Append to documentElement immediately to avoid layout flash on load
        document.documentElement.appendChild(styleEl);
      }
      // Last line of defence: rules can arrive from an imported backup or a
      // hand-edited selector, and they are about to be interpolated into a
      // stylesheet. Anything that could break out of `sel { … }` is dropped.
      const safeRules = PE_normalizeRules(selectors).filter((rule) => !this._hidesWholePage(rule));

      if (safeRules.length === 0) {
        styleEl.textContent = '';
        this._updateBadge(0);
        return;
      }
      // A rule whose erase sweep is still playing is held back until it ends
      // (_sweepErase re-applies afterwards). The badge still counts it.
      const liveRules = this._sweeping.size
        ? safeRules.filter(r => !(r.action === 'hide' && this._sweeping.has(r.selector)))
        : safeRules;

      const cssRules = liveRules.map(item => {
        const sel = item.selector;
        const act = item.action;

        if (act === 'stretch') {
          const parts = sel.split(/\s*>\s*/);
          const ancestorsRules = [];
          for (let i = 1; i < parts.length; i++) {
            const ancestorSel = parts.slice(0, i).join(' > ');
            ancestorsRules.push(`${ancestorSel} { overflow: visible !important; transform: none !important; clip-path: none !important; filter: none !important; }`);
          }
          const stretchRule = `${sel} { width: 100% !important; max-width: none !important; min-width: 0px !important; flex: 1 1 auto !important; box-sizing: border-box !important; }`;
          return ancestorsRules.length > 0 ? `${stretchRule}\n${ancestorsRules.join('\n')}` : stretchRule;
        } else {
          return `${sel} { display: none !important; }`;
        }
      }).join('\n');
      styleEl.textContent = cssRules;
      this._updateBadge(safeRules.length);
    }

    /* A rule that came from a shared code and has not been kept yet may never
     * hide <html>, <body> or everything inside <body>, however its selector is
     * spelled (PE_isTooBroad reads the text; this asks the page). Before <body>
     * exists only <html> can be checked, so the rules are looked at again once
     * the page is parsed. */
    _hidesWholePage(rule) {
      if (!rule || rule.imported !== true || rule.action !== 'hide') return false;
      try {
        const root = document.documentElement;
        const body = document.body;
        if (!body && !this._bodyRecheck && document.readyState === 'loading') {
          this._bodyRecheck = true;
          document.addEventListener('DOMContentLoaded', () => {
            this._bodyRecheck = false;
            this._loadAndApplyErasedElements();
          }, { once: true });
        }
        if (root && root.matches(rule.selector)) return true;
        if (!body) return false;
        if (body.matches(rule.selector)) return true;
        // Every visible child of <body> hidden is the whole page too (`body *`).
        const content = Array.from(body.children).filter((el) =>
          !/^(?:SCRIPT|STYLE|LINK|NOSCRIPT|TEMPLATE)$/i.test(el.tagName) &&
          !/(?:^|\s)pe-/.test(`${el.id} ${el.getAttribute('class') || ''}`));
        return content.length > 0 && content.every((el) => el.matches(rule.selector));
      } catch (err) {
        return false;
      }
    }

    _updateBadge(count) {
      if (!isContextAlive()) {
        noteContextLost();
        return;
      }
      try {
        // The promise rejects if the service worker is mid-restart; that is
        // harmless, the next apply will re-send the count.
        const sending = chrome.runtime.sendMessage({ type: 'UPDATE_BADGE', count });
        if (sending && typeof sending.catch === 'function') sending.catch(() => {});
      } catch (e) {
        noteContextLost();
      }
    }

    /* Called once the extension context is gone: remove every piece of UI we
     * put on the page, leaving the site exactly as we found it. Applied rules
     * stay — the user asked for those, and the stylesheet keeps working. */
    _teardownOnContextLoss() {
      try {
        if (this.active) this._stopSelectionMode();
      } catch (err) { /* best effort */ }
      try {
        // X-Ray's and Extract's exit() only remove their own nodes; no chrome.* call.
        if (this.modes.isActive('xray') || this.modes.isActive('extract') || this.modes.isActive('diff')) this.modes.deactivate();
      } catch (err) { /* best effort */ }

      // Note: #pe-stylesheet is deliberately left in place. The user asked for
      // those elements to be hidden; the rules should survive an extension
      // reload rather than making the page flash back to its unfiltered state.
      ['pe-toast-container', 'pe-paint-canvas', 'pe-eraser-cursor',
       'pe-paint-toolbox', 'pe-clippy-buddy'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.remove();
      });

      document.querySelectorAll('.pe-highlighter').forEach(el => el.remove());
      this.highlighterEl = null;
      this.tooltipEl = null;
      this.modes.release('paint');
    }

    /* ─── Selection Mode ────────────────────────────────────── */

    /* The picker itself lives in modes/erase.js; these keep the existing
     * entry points (messages, shortcuts, _eraseElement) working unchanged. */
    _startSelectionMode(silent = false) {
      this.modes.activate('erase', { silent });
    }

    _stopSelectionMode() {
      if (this.modes.isActive('erase')) this.modes.deactivate();
    }

    _ensureHighlighterElements() {
      if (this.highlighterEl && this.highlighterEl.isConnected) return;

      const highlighter = document.createElement('div');
      highlighter.className = 'pe-highlighter';

      const tooltip = document.createElement('div');
      tooltip.className = 'pe-tooltip';
      highlighter.appendChild(tooltip);

      document.body.appendChild(highlighter);
      this.highlighterEl = highlighter;
      this.tooltipEl = tooltip;
    }

    _showToast(message, action = 'info', selector = null) {
      try {
        let container = document.getElementById('pe-toast-container');
        if (!container || !container.isConnected) {
          container = document.createElement('div');
          container.id = 'pe-toast-container';
          container.className = 'pe-toast-container';
          document.documentElement.appendChild(container);
        }

        const toast = document.createElement('div');
        toast.className = `pe-toast pe-toast-${action}`;

        // Windows 95 Title bar
        const titlebar = document.createElement('div');
        titlebar.className = 'pe-toast-titlebar';
        titlebar.innerHTML = `
          <span class="pe-toast-title">PageEraser.exe</span>
          <button class="pe-toast-close-btn" type="button"></button>
        `;
        titlebar.querySelector('.pe-toast-close-btn').setAttribute('aria-label', this.isTr ? 'Kapat' : 'Close');

        // Toast body content
        const body = document.createElement('div');
        body.className = 'pe-toast-body';

        const text = document.createElement('span');
        text.className = 'pe-toast-text';

        let icon = 'ℹ️';
        if (action === 'erase') icon = '🗑️';
        if (action === 'stretch') icon = '↔️';
        if (action === 'success') icon = '✔️';
        if (action === 'warn') icon = '⚠️';

        text.innerHTML = `<span style="font-size: 14px; margin-right: 6px; vertical-align: middle;">${icon}</span> ${message}`;
        body.appendChild(text);

        // Add Undo button if applicable
        if ((action === 'erase' || action === 'stretch') && selector) {
          const undoBtn = document.createElement('button');
          undoBtn.className = 'pe-toast-undo-btn';
          const isTr = this.isTr;
          undoBtn.textContent = isTr ? 'Geri Al' : 'Undo';

          undoBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Only the user's own click undoes: a page script can call click().
            if (e.isTrusted === false) return;
            this._restoreSelector(selector);
            toast.classList.remove('pe-toast-visible');
            toast.classList.add('pe-toast-hidden');
            setTimeout(() => {
              toast.remove();
              if (container.children.length === 0) {
                container.remove();
              }
            }, 300);
          });
          body.appendChild(undoBtn);
        }

        toast.appendChild(titlebar);
        toast.appendChild(body);
        container.appendChild(toast);

        // Bind close button
        titlebar.querySelector('.pe-toast-close-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          if (e.isTrusted === false) return;
          toast.classList.remove('pe-toast-visible');
          toast.classList.add('pe-toast-hidden');
          setTimeout(() => {
            toast.remove();
            if (container.children.length === 0) {
              container.remove();
            }
          }, 300);
        });

        // Frame update for animation transition
        requestAnimationFrame(() => {
          toast.classList.add('pe-toast-visible');
        });

        // Autoclose toast after 4s (longer for user interaction)
        setTimeout(() => {
          if (toast.parentNode) {
            toast.classList.remove('pe-toast-visible');
            toast.classList.add('pe-toast-hidden');
            setTimeout(() => {
              toast.remove();
              if (container.children.length === 0) {
                container.remove();
              }
            }, 300);
          }
        }, 4000);
      } catch (err) {
        this._log('Error displaying toast:', err);
      }
    }

    _updateHighlight() {
      if (!this.selectedElement || !this.highlighterEl) return;

      const rect = this.selectedElement.getBoundingClientRect();
      
      // Update position of neon box
      this.highlighterEl.style.top = rect.top + 'px';
      this.highlighterEl.style.left = rect.left + 'px';
      this.highlighterEl.style.width = rect.width + 'px';
      this.highlighterEl.style.height = rect.height + 'px';
      this.highlighterEl.classList.add('pe-active');

      // Update color theme based on Alt key (the extract picker has its own colour)
      const extracting = this._pickerAction === 'extract';
      this.highlighterEl.classList.toggle('pe-extract-mode', extracting);
      this.highlighterEl.classList.toggle('pe-stretch-mode', !extracting && this._altPressed);

      // Update tooltip text and position (prevent overlay overflow at viewport top)
      if (rect.top < 40) {
        this.tooltipEl.style.bottom = 'auto';
        this.tooltipEl.style.top = 'calc(100% + 8px)';
      } else {
        this.tooltipEl.style.bottom = 'calc(100% + 8px)';
        this.tooltipEl.style.top = 'auto';
      }

      const selector = this._getSelector(this.selectedElement);
      const rawDisplay = selector.length > 50 ? '...' + selector.slice(-50) : selector;
      // CSS.escape() in _getSelector() makes the selector valid CSS, not safe
      // HTML — an id like `<img src=x onerror=…>` would still be parsed as
      // markup here. Escape before it goes anywhere near innerHTML.
      const displaySelector = escapeHtml(rawDisplay);
      const tag = escapeHtml(this.selectedElement.tagName.toLowerCase());

      const isTr = this.isTr;
      const actionText = extracting
        ? (isTr
            ? `<span style="color:#a29bfe;font-weight:700;"><kbd>Tıkla</kbd> Koda Çıkar</span>`
            : `<span style="color:#a29bfe;font-weight:700;"><kbd>Click</kbd> Extract to Code</span>`)
        : this._altPressed
        ? (isTr
            ? `<span style="color:#00d2d3;font-weight:700;"><kbd>Tıkla</kbd> Genişliğe Sığdır</span>`
            : `<span style="color:#00d2d3;font-weight:700;"><kbd>Click</kbd> Stretch to Full Width</span>`)
        : (isTr
            ? `<span style="color:#ff4757;font-weight:700;"><kbd>Tıkla</kbd> Elementi Sil</span> <span style="opacity: 0.5; margin: 0 4px;">|</span> <kbd>Alt+Tıkla</kbd> Sığdır`
            : `<span style="color:#ff4757;font-weight:700;"><kbd>Click</kbd> Erase Element</span> <span style="opacity: 0.5; margin: 0 4px;">|</span> <kbd>Alt+Click</kbd> Stretch`);

      const parentText = isTr ? 'Üst' : 'Parent';
      const childText = isTr ? 'Sonraki' : 'Next';
      const siblingText = isTr ? 'Kardeş' : 'Sibling';
      const cancelText = isTr ? 'İptal' : 'Cancel';

      this.tooltipEl.innerHTML = `
        <span class="pe-tooltip-tag">${tag}</span>
        <span class="pe-tooltip-selector">${displaySelector}</span>
        <span class="pe-tooltip-keys">${actionText} <span style="opacity: 0.5; margin: 0 4px;">|</span> <kbd>↑</kbd>${parentText} <kbd>↓</kbd>${childText} <kbd>←→</kbd>${siblingText} <kbd>ESC</kbd>${cancelText}</span>
      `;
    }

    /* ─── Element Selection Path Logic ──────────────────────── */

    _getSelector(el) {
      if (el.id) {
        return `#${CSS.escape(el.id)}`;
      }
      const path = [];
      while (el && el.nodeType === Node.ELEMENT_NODE) {
        let selector = el.nodeName.toLowerCase();
        if (el.id) {
          selector += `#${CSS.escape(el.id)}`;
          path.unshift(selector);
          break; // Stop climbing if we reached an ID
        } else {
          let classSelector = '';
          if (el.classList && el.classList.length > 0) {
            for (let i = 0; i < el.classList.length; i++) {
              const cls = el.classList[i];
              // Skip dynamic-looking or extension-related classes
              if (cls.startsWith('pe-') || cls.length > 22 || /\d/.test(cls)) continue;
              classSelector += `.${CSS.escape(cls)}`;
            }
          }
          if (classSelector) {
            selector += classSelector;
          } else {
            // Sibling position fallback
            let sibling = el;
            let nth = 1;
            while (sibling = sibling.previousElementSibling) {
              if (sibling.nodeName === el.nodeName) {
                nth++;
              }
            }
            selector += `:nth-of-type(${nth})`;
          }
        }
        path.unshift(selector);
        el = el.parentNode;
      }
      return path.join(' > ');
    }

    /* ─── Erasing Actions ───────────────────────────────────── */

    async _eraseElement(element, action = 'hide') {
      const selector = this._getSelector(element);
      this._stopSelectionMode();

      const isTr = this.isTr;
      // Apply style instantly in DOM
      if (action === 'stretch') {
        element.style.setProperty('width', '100%', 'important');
        element.style.setProperty('max-width', 'none', 'important');
        element.style.setProperty('min-width', '0px', 'important');
        element.style.setProperty('flex', '1 1 auto', 'important');
        element.style.setProperty('box-sizing', 'border-box', 'important');
        
        // Walk up parents to apply overrides (breaking containing blocks and clip constraints)
        let parent = element.parentElement;
        while (parent && parent !== document.body && parent !== document.documentElement) {
          parent.style.setProperty('overflow', 'visible', 'important');
          parent.style.setProperty('transform', 'none', 'important');
          parent.style.setProperty('clip-path', 'none', 'important');
          parent.style.setProperty('filter', 'none', 'important');
          parent = parent.parentElement;
        }

        const msg = isTr ? 'Element Genişliğe Sığdırıldı' : 'Element Stretched to Full Width';
        this._showToast(msg, 'stretch', selector);
        RetroAudio.playAction('stretch');
      } else {
        const clippy = document.getElementById('pe-clippy-buddy');
        if (clippy && window.getComputedStyle(clippy).display !== 'none') {
          try {
            const rect = element.getBoundingClientRect();
            const clippyRect = clippy.getBoundingClientRect();
            
            const clone = element.cloneNode(true);
            clone.id = '';
            clone.style.cssText = `
              position: fixed !important;
              z-index: 2147483645 !important;
              top: ${rect.top}px !important;
              left: ${rect.left}px !important;
              width: ${rect.width}px !important;
              height: ${rect.height}px !important;
              margin: 0 !important;
              padding: ${window.getComputedStyle(element).padding} !important;
              border: ${window.getComputedStyle(element).border} !important;
              background: ${window.getComputedStyle(element).background} !important;
              pointer-events: none !important;
              transition: all 0.55s cubic-bezier(0.25, 0.46, 0.45, 0.94) !important;
              box-sizing: border-box !important;
              transform-origin: center center !important;
            `;
            
            document.body.appendChild(clone);
            element.style.setProperty('display', 'none', 'important');
            
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                clone.style.setProperty('top', `${clippyRect.top + 15}px`, 'important');
                clone.style.setProperty('left', `${clippyRect.left + 5}px`, 'important');
                clone.style.setProperty('width', '10px', 'important');
                clone.style.setProperty('height', '10px', 'important');
                clone.style.setProperty('opacity', '0.2', 'important');
                clone.style.setProperty('transform', 'rotate(70deg)', 'important');
              });
            });
            
            setTimeout(() => {
              clone.remove();
              RetroAudio.playChomp();
              this._clippyWink();
              const chompMsg = isTr ? 'Ham! Pek lezzetliydi.' : 'Chomp! That was delicious.';
              this._clippySpeak(chompMsg, 2000);
            }, 550);
          } catch(e) {
            element.style.setProperty('display', 'none', 'important');
            RetroAudio.playAction('erase');
          }
        } else if (this._canSweep(element)) {
          // No Clippy to feed: wipe the element away, left to right.
          RetroAudio.playAction('erase');
          this._sweepErase(element, selector);
        } else {
          element.style.setProperty('display', 'none', 'important');
          RetroAudio.playAction('erase');
        }
        const msg = isTr ? 'Element Gizlendi' : 'Element Erased';
        this._showToast(msg, 'erase', selector);
      }

      const persistData = await storage.get('pe_persist');
      const shouldPersist = persistData.pe_persist !== false;

      if (shouldPersist) {
        try {
          const domain = await this._getDomain();
          const key = `pe_selectors_${domain}`;
          const saved = await this._withRulesLock(key, async () => {
            const data = await storage.get(key);
            let selectors = data[key] || [];

            // Remove existing rule for same selector to prevent conflict
            selectors = selectors.filter(item => {
              const sel = typeof item === 'string' ? item : item.selector;
              return sel !== selector;
            });

            selectors.push({ selector, action });
            const written = await storage.set({ [key]: selectors });
            this._applySelectors(selectors);
            return written;
          });
          this._undoStack.push({ selector, action });
          // A full quota used to fail silently: the element stayed hidden, the
          // toast said "Erased", and the page came back whole on the next load.
          if (!saved && isContextAlive()) {
            this._showToast(
              isTr
                ? 'Şimdilik gizlendi ama kaydedilemedi: tarayıcı depolaması dolu.'
                : 'Hidden for now, but not saved: browser storage is full.',
              'warn'
            );
          }
        } catch (err) {
          this._log('Error saving element selector:', err);
        }
      } else {
        this._undoStack.push({ selector, action });
      }
    }

    async _restoreSelector(selector, silent = false) {
      try {
        const domain = await this._getDomain();
        const key = `pe_selectors_${domain}`;
        const outcome = await this._withRulesLock(key, async () => {
          const data = await storage.get(key);
          const current = data[key] || [];

          // Deleted from the Recycle Bin for good — Ctrl+Z must not resurrect it.
          const existing = current.find(item => typeof item === 'object' && item && item.selector === selector);
          if (existing && existing.permanent === true) return { permanent: true };

          const left = current.filter(item => {
            const sel = typeof item === 'string' ? item : item.selector;
            return sel !== selector;
          });
          await storage.set({ [key]: left });
          return { left };
        });
        if (outcome.permanent) return 'permanent';
        const selectors = outcome.left;

        // Restored mid-sweep: cancel the pending hide.
        this._sweeping.delete(selector);
        // Mask the elements first, then un-hide them in the same task, so the
        // wipe plays in reverse instead of the element popping back.
        this._beginRestoreSweeps([selector]);

        this._applySelectors(selectors);
        if (!silent) {
          RetroAudio.playAction('reset');
        }

        // Remove inline styles if element is present in current page
        try {
          const elements = document.querySelectorAll(selector);
          elements.forEach(el => {
            el.style.removeProperty('display');
            el.style.removeProperty('width');
            el.style.removeProperty('max-width');
            el.style.removeProperty('min-width');
            el.style.removeProperty('flex');
            el.style.removeProperty('box-sizing');
            
            // Clean up parent containing block overrides
            let parent = el.parentElement;
            while (parent && parent !== document.body && parent !== document.documentElement) {
              parent.style.removeProperty('overflow');
              parent.style.removeProperty('transform');
              parent.style.removeProperty('clip-path');
              parent.style.removeProperty('filter');
              parent = parent.parentElement;
            }
          });
        } catch (e) {
          // ignore selector errors
        }
        return true;
      } catch (err) {
        this._log('Error restoring element:', err);
        return false;
      }
    }

    async _resetSite(passedSelectors, silent = false) {
      try {
        const domain = await this._getDomain();
        const key = `pe_selectors_${domain}`;
        let selectors = [];
        if (passedSelectors && Array.isArray(passedSelectors)) {
          selectors = passedSelectors;
        } else {
          const data = await storage.get(key);
          selectors = data[key] || [];
        }
        
        await storage.remove(key);

        this._sweeping.clear();
        this._beginRestoreSweeps(
          selectors.map(item => typeof item === 'string' ? item : (item && item.selector)).filter(Boolean)
        );

        this._applySelectors([]);
        if (!silent) {
          RetroAudio.playAction('reset');
        }

        // Clean up inline styles for all cleared selectors
        selectors.forEach(item => {
          const sel = typeof item === 'string' ? item : item.selector;
          try {
            const elements = document.querySelectorAll(sel);
            elements.forEach(el => {
              el.style.removeProperty('display');
              el.style.removeProperty('width');
              el.style.removeProperty('max-width');
              el.style.removeProperty('min-width');
              el.style.removeProperty('flex');
              el.style.removeProperty('box-sizing');
              
              // Clean up parent containing block overrides
              let parent = el.parentElement;
              while (parent && parent !== document.body && parent !== document.documentElement) {
                parent.style.removeProperty('overflow');
                parent.style.removeProperty('transform');
                parent.style.removeProperty('clip-path');
                parent.style.removeProperty('filter');
                parent = parent.parentElement;
              }
            });
          } catch (e) {
            // ignore
          }
        });
      } catch (err) {
        this._log('Error resetting site selectors:', err);
      }
    }

    /* ─── Keyboard Controls ─────────────────────────────────── */

    _setupKeyListeners() {
      document.addEventListener('keydown', (e) => {
        // Shortcuts, Ctrl+Z and Alt+Shift+D (which deletes the site's rules) come from the
        // user's keyboard only: a page script can dispatch its own keydown events.
        if (e.isTrusted === false) return;
        const activeEl = document.activeElement;
        if (activeEl && (
          activeEl.tagName === 'INPUT' || 
          activeEl.tagName === 'TEXTAREA' || 
          activeEl.isContentEditable
        )) {
          return;
        }

        const keyUpper = e.key ? e.key.toUpperCase() : '';

        // Direct keyboard shortcut fallbacks (Alt+Shift / Ctrl+Shift)
        if ((e.altKey || e.ctrlKey) && e.shiftKey) {
          if (keyUpper === 'E') {
            e.preventDefault();
            if (this.active) {
              this._stopSelectionMode();
            } else {
              this._startSelectionMode();
            }
            return;
          } else if (keyUpper === 'D' || keyUpper === 'R' || keyUpper === 'Y') {
            e.preventDefault();
            this._resetSite();
            return;
          } else if (keyUpper === 'W' || keyUpper === 'P' || keyUpper === 'K') {
            e.preventDefault();
            this._startPaintMode();
            return;
          } else if (keyUpper === 'X') {
            e.preventDefault();
            this.modes.toggle('xray');
            return;
          } else if (keyUpper === 'C' && e.altKey) {
            // Alt only: Ctrl+Shift+C is the browser's own "inspect element".
            e.preventDefault();
            this.modes.toggle('extract');
            return;
          } else if (keyUpper === 'V' && e.altKey) {
            // Alt only: Ctrl+Shift+V is "paste as plain text".
            e.preventDefault();
            this.modes.toggle('diff');
            return;
          }
        }

        // Handle global Undo shortcut (Ctrl+Z)
        if (e.ctrlKey && keyUpper === 'Z') {
          if (this._undoStack && this._undoStack.length > 0) {
            e.preventDefault();
            const lastItem = this._undoStack.pop();
            const isTr = this.isTr;
            this._restoreSelector(lastItem.selector).then((restored) => {
              if (restored === 'permanent') {
                // Deleted from the Recycle Bin for good: nothing to undo.
                const blocked = isTr ? 'Geri Al: Kalıcı olarak silindi' : 'Undo: Permanently deleted';
                this._showToast(blocked, 'info');
                return;
              }
              const msg = isTr ? 'Geri Al: Element Eski Haline Getirildi' : 'Undo: Element Restored';
              this._showToast(msg, 'success');
            });
          }
          return;
        }

        // Escape: close paint mode or selection mode
        if (e.key === 'Escape') {
          e.preventDefault();
          if (this._stopPaintFn) {
            this._stopPaintFn();
            return;
          }
          if (this.modes.isActive('xray') || this.modes.isActive('extract') || this.modes.isActive('diff')) {
            this.modes.deactivate();
            return;
          }
          if (this.active) {
            this._stopSelectionMode();
          }
          return;
        }

        // Whatever mode is running gets the remaining keys — the erase mode's
        // arrow-key navigation lives in modes/erase.js.
        this.modes.handleKey(e);
      });
    }

    /* ─── Message Handling ──────────────────────────────────── */

    _setupMessageListener() {
      if (!isContextAlive()) return;

      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        try {
          switch (msg.type) {
            case 'START_SELECTION':
              const isTr = this.isTr;
              if (this.active) {
                this._stopSelectionMode();
                if (!msg.silent) {
                  const msgText = isTr ? 'PageEraser: Seçim Modu İptal Edildi' : 'PageEraser: Selection Mode Cancelled';
                  this._showToast(msgText, 'info');
                }
              } else {
                this._startSelectionMode(msg.silent);
                if (!msg.silent) {
                  const msgText = isTr ? 'PageEraser: Seçim Modu Aktif' : 'PageEraser: Selection Mode Active';
                  this._showToast(msgText, 'info');
                }
              }
              sendResponse({ success: true });
              break;
            case 'GET_STATUS':
              sendResponse({ active: this.active, xray: this.modes.isActive('xray'), extract: this.modes.isActive('extract'), diff: this.modes.isActive('diff') });
              break;
            case 'RESTORE_SELECTOR':
              this._restoreSelector(msg.selector, msg.silent).then(() => {
                sendResponse({ success: true });
              });
              break;
            case 'RESET_SITE':
              this._resetSite(msg.selectors, msg.silent).then(() => {
                if (!msg.silent) {
                  const isTrLang = this.isTr;
                  const msgText = isTrLang ? 'PageEraser: Tüm Düzen Geri Yüklendi' : 'PageEraser: Layout Restored';
                  this._showToast(msgText, 'success');
                }
                sendResponse({ success: true });
              });
              break;
            case 'REFRESH_RULES':
              this._loadAndApplyErasedElements().then(() => {
                if (!msg.silent) {
                  const isTrLang = this.isTr;
                  const msgText = isTrLang ? 'PageEraser: Kurallar İçe Aktarıldı' : 'PageEraser: Rules Imported';
                  this._showToast(msgText, 'success');
                }
                sendResponse({ success: true });
              });
              break;
            case 'CONTEXT_ERASE':
              if (this._lastRightClickedEl) {
                this._eraseElement(this._lastRightClickedEl, 'hide');
              }
              sendResponse({ success: true });
              break;
            case 'CONTEXT_STRETCH':
              if (this._lastRightClickedEl) {
                this._eraseElement(this._lastRightClickedEl, 'stretch');
              }
              sendResponse({ success: true });
              break;
            case 'HIGHLIGHT_SELECTOR':
              this._highlightSelector(msg.selector);
              sendResponse({ success: true });
              break;
            case 'CLEAR_HIGHLIGHT':
              this._clearHighlight();
              sendResponse({ success: true });
              break;
            case 'START_PAINT':
              this._startPaintMode();
              sendResponse({ success: true });
              break;
            case 'TOGGLE_DIFF':
              if (this.modes.toggle('diff') && !msg.silent) {
                this._showToast(this.isTr ? 'PageEraser: Görsel Fark Aktif' : 'PageEraser: Visual Diff Active', 'info');
              }
              sendResponse({ success: true, active: this.modes.isActive('diff') });
              break;
            case 'TOGGLE_EXTRACT':
              if (this.modes.toggle('extract') && !msg.silent) {
                this._showToast(this.isTr ? 'PageEraser: Koda Çıkar Aktif' : 'PageEraser: Extract to Code Active', 'info');
              }
              sendResponse({ success: true, active: this.modes.isActive('extract') });
              break;
            case 'TOGGLE_XRAY':
              this.modes.toggle('xray');
              sendResponse({ success: true, active: this.modes.isActive('xray') });
              break;
            default:
              sendResponse({ success: false });
          }
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
        return true; // async channel
      });
    }

    _highlightSelector(selector) {
      try {
        const element = document.querySelector(selector);
        if (!element) return;

        this._ensureHighlighterElements();

        const rect = element.getBoundingClientRect();
        
        this.highlighterEl.style.top = rect.top + 'px';
        this.highlighterEl.style.left = rect.left + 'px';
        this.highlighterEl.style.width = rect.width + 'px';
        this.highlighterEl.style.height = rect.height + 'px';
        
        this.highlighterEl.classList.add('pe-active');
        this.highlighterEl.classList.add('pe-list-hover-highlight');
        
        if (this.tooltipEl) {
          this.tooltipEl.style.display = 'none';
        }
      } catch (e) {}
    }

    _clearHighlight() {
      if (!this.active && this.highlighterEl) {
        this.highlighterEl.classList.remove('pe-active');
        this.highlighterEl.classList.remove('pe-list-hover-highlight');
      }
      if (this.tooltipEl) {
        this.tooltipEl.style.display = '';
      }
    }

    /* Paint is a mode like erase, so the manager keeps the two from running
     * together. The drawing code itself is in _enterPaintMode. */
    _startPaintMode() {
      this.modes.activate('paint');
    }

    _enterPaintMode() {
      if (document.getElementById('pe-paint-canvas')) return;

      const isTr = this.isTr;

      const canvas = document.createElement('canvas');
      canvas.id = 'pe-paint-canvas';
      canvas.className = 'pe-paint-canvas';
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      document.body.appendChild(canvas);

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      let isDrawing = false;
      let lastX = 0;
      let lastY = 0;
      let currentX = 0;
      let currentY = 0;
      let currentTool = 'brush'; // 'brush', 'spray', 'eraser'
      let brushColor = '#000000';
      let brushSize = 8;
      let sprayInterval = null;
      let drawingHistory = [];

      const saveState = () => {
        if (drawingHistory.length >= 20) {
          drawingHistory.shift();
        }
        drawingHistory.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
      };

      const undo = () => {
        if (drawingHistory.length > 0) {
          const prevState = drawingHistory.pop();
          ctx.putImageData(prevState, 0, 0);
          RetroAudio.playReset();
        } else {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          RetroAudio.playReset();
        }
      };

      const paintKeydownHandler = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          stopPaint();
          return;
        }
        if (e.ctrlKey && e.key.toLowerCase() === 'z') {
          const activeEl = document.activeElement;
          if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
            return;
          }
          e.preventDefault();
          undo();
        }
      };
      window.addEventListener('keydown', paintKeydownHandler);

      const resizeHandler = () => {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = canvas.width;
        tempCanvas.height = canvas.height;
        const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        tempCtx.drawImage(canvas, 0, 0);

        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = brushColor;
        ctx.lineWidth = brushSize;
        ctx.globalCompositeOperation = currentTool === 'eraser' ? 'destination-out' : 'source-over';

        ctx.drawImage(tempCanvas, 0, 0);
      };
      window.addEventListener('resize', resizeHandler);

      // Custom Eraser Cursor element
      const eraserCursor = document.createElement('div');
      eraserCursor.id = 'pe-eraser-cursor';
      eraserCursor.className = 'pe-eraser-cursor';
      document.body.appendChild(eraserCursor);

      const updateEraserCursor = (e) => {
        if (currentTool === 'eraser') {
          eraserCursor.style.display = 'block';
          eraserCursor.style.width = brushSize + 'px';
          eraserCursor.style.height = brushSize + 'px';
          eraserCursor.style.left = (e.clientX - brushSize / 2) + 'px';
          eraserCursor.style.top = (e.clientY - brushSize / 2) + 'px';
        } else {
          eraserCursor.style.display = 'none';
        }
      };

      const updateCanvasCursor = () => {
        if (currentTool === 'eraser') {
          canvas.style.cursor = 'none';
        } else {
          canvas.style.cursor = 'crosshair';
          eraserCursor.style.display = 'none';
        }
      };

      canvas.addEventListener('mousemove', updateEraserCursor);
      canvas.addEventListener('mouseenter', (e) => {
        if (currentTool === 'eraser') {
          eraserCursor.style.display = 'block';
          updateEraserCursor(e);
        }
      });
      canvas.addEventListener('mouseleave', () => {
        eraserCursor.style.display = 'none';
      });

      const toolbox = document.createElement('div');
      toolbox.id = 'pe-paint-toolbox';
      toolbox.className = 'pe-paint-toolbox';
      
      const titleText = isTr ? 'Boya 95' : 'Paintbrush 95';
      const toolsLabel = isTr ? 'Araçlar' : 'Tools';
      const brushText = isTr ? 'Fırça' : 'Brush';
      const sprayText = isTr ? 'Sprey' : 'Spray';
      const eraserText = isTr ? 'Silgi' : 'Eraser';
      const sizeLabel = isTr ? 'Boyut' : 'Size';
      const colorsLabel = isTr ? 'Palet' : 'Palette';
      const undoBtnText = isTr ? 'Geri Al' : 'Undo';
      const clearBtnText = isTr ? 'Temizle' : 'Clear All';

      toolbox.innerHTML = `
        <div class="pe-paint-toolbox-titlebar">
          <span class="pe-paint-toolbox-title">${titleText}</span>
          <button class="pe-paint-toolbox-close" type="button"></button>
        </div>
        <div class="pe-paint-toolbox-body">
          <div class="pe-paint-group">
            <div class="pe-paint-label">${toolsLabel}</div>
            <div class="pe-paint-row">
              <button id="pe-tool-brush" class="pe-paint-tool-btn pe-active" type="button">
                <span class="pe-paint-tool-icon">🖌️</span>
                <span class="pe-paint-tool-text">${brushText}</span>
              </button>
              <button id="pe-tool-spray" class="pe-paint-tool-btn" type="button">
                <span class="pe-paint-tool-icon">💨</span>
                <span class="pe-paint-tool-text">${sprayText}</span>
              </button>
              <button id="pe-tool-eraser" class="pe-paint-tool-btn" type="button">
                <span class="pe-paint-tool-icon">🧽</span>
                <span class="pe-paint-tool-text">${eraserText}</span>
              </button>
            </div>
          </div>
          <div class="pe-paint-group">
            <div class="pe-paint-label">${sizeLabel}</div>
            <div class="pe-paint-row" style="align-items: center;">
              <input type="range" id="pe-paint-size" min="2" max="40" value="8" class="pe-paint-slider" />
              <span id="pe-paint-size-val" style="font-size: 11px; min-width: 30px; text-align: right; margin-left: 5px;">8px</span>
            </div>
          </div>
          <div class="pe-paint-group">
            <div class="pe-paint-label">${colorsLabel}</div>
            <div class="pe-paint-colors-grid">
              <div class="pe-color-box pe-active" style="background-color: #000000;" data-color="#000000"></div>
              <div class="pe-color-box" style="background-color: #808080;" data-color="#808080"></div>
              <div class="pe-color-box" style="background-color: #800000;" data-color="#800000"></div>
              <div class="pe-color-box" style="background-color: #808000;" data-color="#808000"></div>
              <div class="pe-color-box" style="background-color: #008000;" data-color="#008000"></div>
              <div class="pe-color-box" style="background-color: #008080;" data-color="#008080"></div>
              <div class="pe-color-box" style="background-color: #000080;" data-color="#000080"></div>
              <div class="pe-color-box" style="background-color: #800080;" data-color="#800080"></div>
              <div class="pe-color-box" style="background-color: #ffffff; border: 1px solid #808080;" data-color="#ffffff"></div>
              <div class="pe-color-box" style="background-color: #c0c0c0;" data-color="#c0c0c0"></div>
              <div class="pe-color-box" style="background-color: #ff0000;" data-color="#ff0000"></div>
              <div class="pe-color-box" style="background-color: #ffff00;" data-color="#ffff00"></div>
              <div class="pe-color-box" style="background-color: #00ff00;" data-color="#00ff00"></div>
              <div class="pe-color-box" style="background-color: #00ffff;" data-color="#00ffff"></div>
              <div class="pe-color-box" style="background-color: #0000ff;" data-color="#0000ff"></div>
              <div class="pe-color-box" style="background-color: #ff00ff;" data-color="#ff00ff"></div>
            </div>
          </div>
          <div class="pe-paint-actions-row" style="display: flex !important; gap: 4px !important; margin-top: 4px !important;">
            <button id="pe-paint-undo" class="win-btn" style="flex: 1 !important; font-size: 11px; font-weight: bold;" type="button">${undoBtnText}</button>
            <button id="pe-paint-clear" class="win-btn" style="flex: 1 !important; font-size: 11px; font-weight: bold;" type="button">${clearBtnText}</button>
          </div>
        </div>
      `;

      toolbox.querySelector('.pe-paint-toolbox-close').setAttribute('aria-label', isTr ? 'Kapat' : 'Close');
      document.body.appendChild(toolbox);
      this._makeElementDraggable(toolbox, toolbox.querySelector('.pe-paint-toolbox-titlebar'));
      updateCanvasCursor();

      const stopPaint = () => {
        window.removeEventListener('resize', resizeHandler);
        window.removeEventListener('keydown', paintKeydownHandler);
        if (sprayInterval) clearInterval(sprayInterval);
        if (toolbox._cleanupDrag) toolbox._cleanupDrag();
        canvas.remove();
        toolbox.remove();
        eraserCursor.remove();
        this._stopPaintFn = null;
        this.modes.release('paint');
        RetroAudio.playSelection();
      };
      this._stopPaintFn = stopPaint;

      toolbox.querySelector('.pe-paint-toolbox-close').addEventListener('click', stopPaint);

      const drawStart = (x, y) => {
        saveState();
        isDrawing = true;
        currentX = x;
        currentY = y;
        lastX = x;
        lastY = y;

        ctx.strokeStyle = brushColor;
        ctx.lineWidth = brushSize;
        ctx.globalCompositeOperation = currentTool === 'eraser' ? 'destination-out' : 'source-over';

        if (currentTool === 'spray') {
          RetroAudio.playSwish();
          sprayInterval = setInterval(() => {
            const radius = brushSize * 1.5;
            const density = Math.min(40, radius * 2.5);
            ctx.fillStyle = brushColor;
            for (let i = 0; i < density; i++) {
              const angle = Math.random() * Math.PI * 2;
              const r = Math.random() * radius;
              const sx = currentX + Math.cos(angle) * r;
              const sy = currentY + Math.sin(angle) * r;
              ctx.fillRect(sx, sy, 1.5, 1.5);
            }
          }, 25);
        } else {
          RetroAudio.playSwish();
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
      };

      const drawMove = (x, y) => {
        currentX = x;
        currentY = y;
        if (!isDrawing) return;

        if (currentTool !== 'spray') {
          ctx.strokeStyle = brushColor;
          ctx.lineWidth = brushSize;
          ctx.globalCompositeOperation = currentTool === 'eraser' ? 'destination-out' : 'source-over';
          ctx.beginPath();
          ctx.moveTo(lastX, lastY);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
        lastX = x;
        lastY = y;
      };

      const drawEnd = () => {
        isDrawing = false;
        if (sprayInterval) {
          clearInterval(sprayInterval);
          sprayInterval = null;
        }
      };

      canvas.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        drawStart(e.clientX, e.clientY);
      });

      canvas.addEventListener('mousemove', (e) => {
        drawMove(e.clientX, e.clientY);
      });

      canvas.addEventListener('mouseup', drawEnd);
      canvas.addEventListener('mouseleave', drawEnd);

      // Touch support
      canvas.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        const touch = e.touches[0];
        drawStart(touch.clientX, touch.clientY);
      });

      canvas.addEventListener('touchmove', (e) => {
        if (e.touches.length !== 1) return;
        const touch = e.touches[0];
        drawMove(touch.clientX, touch.clientY);
      });

      canvas.addEventListener('touchend', drawEnd);

      const toolBtns = toolbox.querySelectorAll('.pe-paint-tool-btn');
      toolBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          toolBtns.forEach(b => b.classList.remove('pe-active'));
          btn.classList.add('pe-active');
          currentTool = btn.id.replace('pe-tool-', '');
          updateCanvasCursor();
          RetroAudio.playSelection();
        });
      });

      const sizeSlider = toolbox.querySelector('#pe-paint-size');
      const sizeVal = toolbox.querySelector('#pe-paint-size-val');
      sizeSlider.addEventListener('input', () => {
        brushSize = parseInt(sizeSlider.value);
        sizeVal.textContent = brushSize + 'px';
        if (currentTool === 'eraser') {
          eraserCursor.style.width = brushSize + 'px';
          eraserCursor.style.height = brushSize + 'px';
        }
      });

      const colorBoxes = toolbox.querySelectorAll('.pe-color-box');
      colorBoxes.forEach(box => {
        box.addEventListener('click', () => {
          colorBoxes.forEach(b => b.classList.remove('pe-active'));
          box.classList.add('pe-active');
          brushColor = box.getAttribute('data-color');
          RetroAudio.playSelection();
        });
      });

      toolbox.querySelector('#pe-paint-undo').addEventListener('click', () => {
        undo();
      });

      toolbox.querySelector('#pe-paint-clear').addEventListener('click', () => {
        saveState();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        RetroAudio.playReset();
      });
    }

    _makeElementDraggable(elm, handle) {
      let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
      let currentTop = 0;
      let currentLeft = 0;
      
      const dragMouseDown = (e) => {
        if (e.target.closest('button') || e.target.closest('input')) return;
        e.preventDefault();
        
        pos3 = e.clientX;
        pos4 = e.clientY;
        
        const rect = elm.getBoundingClientRect();
        currentLeft = rect.left;
        currentTop = rect.top;
        
        document.addEventListener('mouseup', closeDragElement);
        document.addEventListener('mousemove', elementDrag);
      };

      const elementDrag = (e) => {
        e.preventDefault();
        
        pos1 = pos3 - e.clientX;
        pos2 = pos4 - e.clientY;
        pos3 = e.clientX;
        pos4 = e.clientY;

        currentLeft = currentLeft - pos1;
        currentTop = currentTop - pos2;

        const maxLeft = window.innerWidth - elm.offsetWidth;
        const maxTop = window.innerHeight - elm.offsetHeight;
        let finalLeft = Math.max(0, Math.min(currentLeft, maxLeft));
        let finalTop = Math.max(0, Math.min(currentTop, maxTop));

        elm.style.setProperty('top', finalTop + 'px', 'important');
        elm.style.setProperty('left', finalLeft + 'px', 'important');

        currentLeft = finalLeft;
        currentTop = finalTop;
      };

      const closeDragElement = () => {
        document.removeEventListener('mouseup', closeDragElement);
        document.removeEventListener('mousemove', elementDrag);
      };

      handle.addEventListener('mousedown', dragMouseDown);
      
      elm._cleanupDrag = () => {
        handle.removeEventListener('mousedown', dragMouseDown);
        document.removeEventListener('mouseup', closeDragElement);
        document.removeEventListener('mousemove', elementDrag);
      };
    }

    _injectClippy() {
      storage.get('pe_clippy_enabled').then(data => {
        if (data.pe_clippy_enabled === false) return;

        if (document.getElementById('pe-clippy-buddy')) return;

        const clippy = document.createElement('div');
        clippy.id = 'pe-clippy-buddy';
        clippy.className = 'pe-clippy-buddy';

        const bubble = document.createElement('div');
        bubble.id = 'pe-clippy-speech-bubble';
        bubble.className = 'pe-clippy-bubble';
        bubble.innerHTML = `
          <div class="pe-clippy-bubble-content"></div>
          <div class="pe-clippy-bubble-arrow"></div>
        `;
        clippy.appendChild(bubble);

        const clippyDrawing = document.createElement('div');
        clippyDrawing.className = 'pe-clippy-drawing';
        clippyDrawing.innerHTML = `
          <svg class="pe-clippy-svg" viewBox="0 0 100 120" width="80" height="96" xmlns="http://www.w3.org/2000/svg">
            <path d="M50 100 C30 100, 20 85, 20 65 L20 35 C20 20, 35 10, 50 10 C65 10, 80 20, 80 35 L80 75 C80 90, 65 105, 45 105 C25 105, 10 90, 10 70 L10 40" 
                  fill="none" stroke="#555" stroke-width="7" stroke-linecap="round" />
            <path d="M50 100 C30 100, 20 85, 20 65 L20 35 C20 20, 35 10, 50 10 C65 10, 80 20, 80 35 L80 75 C80 90, 65 105, 45 105 C25 105, 10 90, 10 70 L10 40" 
                  fill="none" stroke="#ccc" stroke-width="5" stroke-linecap="round" />
            <circle cx="38" cy="40" r="10" fill="#fff" stroke="#000" stroke-width="2"/>
            <circle id="pe-clippy-pupil-l" cx="38" cy="40" r="4" fill="#000"/>
            <circle cx="62" cy="40" r="10" fill="#fff" stroke="#000" stroke-width="2"/>
            <circle id="pe-clippy-pupil-r" cx="62" cy="40" r="4" fill="#000"/>
            <path id="pe-clippy-brow-l" d="M28 26 Q38 24 44 30" fill="none" stroke="#000" stroke-width="3" stroke-linecap="round"/>
            <path id="pe-clippy-brow-r" d="M72 26 Q62 24 56 30" fill="none" stroke="#000" stroke-width="3" stroke-linecap="round"/>
            <path id="pe-clippy-mouth" d="M42 62 Q50 68 58 62" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round"/>
          </svg>
        `;
        clippy.appendChild(clippyDrawing);

        document.body.appendChild(clippy);

        const isTr = this.isTr;
        const welcomeMsg = isTr 
          ? 'PageEraser\'a hoş geldiniz! Silmek istediğiniz bir öğeye tıklayın. Genişletmek için Alt tuşuna basılı tutarak tıklayın.' 
          : 'Welcome to PageEraser! Click any element to erase it. Hold Alt key while clicking to stretch.';
        
        setTimeout(() => {
          clippy.classList.add('pe-clippy-active');
          this._clippySpeak(welcomeMsg, 5000);
        }, 100);
      });
    }

    _removeClippy() {
      const clippy = document.getElementById('pe-clippy-buddy');
      if (clippy) {
        clippy.classList.add('pe-clippy-leaving');
        setTimeout(() => {
          clippy.remove();
        }, 600);
      }
    }

    _clippySpeak(message, duration = 4000) {
      if (this._clippySpeakTimeout) {
        clearTimeout(this._clippySpeakTimeout);
      }
      const bubble = document.getElementById('pe-clippy-speech-bubble');
      if (bubble) {
        const content = bubble.querySelector('.pe-clippy-bubble-content');
        content.textContent = message;
        bubble.classList.add('pe-visible');
        
        this._clippySpeakTimeout = setTimeout(() => {
          bubble.classList.remove('pe-visible');
        }, duration);
      }
    }

    _clippyWink() {
      const pupilR = document.getElementById('pe-clippy-pupil-r');
      const browR = document.getElementById('pe-clippy-brow-r');
      if (pupilR && browR) {
        pupilR.setAttribute('r', '1');
        browR.setAttribute('d', 'M72 32 Q62 34 56 32');
        setTimeout(() => {
          pupilR.setAttribute('r', '4');
          browR.setAttribute('d', 'M72 26 Q62 24 56 30');
        }, 600);
      }
    }
  }

  // Bootstrap PageEraser
  new PageEraser();
})();

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
  const storage = chrome.storage.local || chrome.storage.sync;

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

      // Event handlers (stored for removal)
      this._mouseMoveHandler = null;
      this._clickCaptureHandler = null;
      this._ticking = false;

      // Track last right-clicked element for Context Menus
      document.addEventListener('contextmenu', (e) => {
        this._lastRightClickedEl = e.target;
      }, true);

      this._init();
    }

    /* ─── Init ──────────────────────────────────────────────── */

    async _init() {
      try {
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

        this._setupMessageListener();
        this._setupKeyListeners();
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

    /* ─── Persistent CSS Hiding ──────────────────────────────── */

    async _getDomain() {
      try {
        const data = await storage.get('pe_all_subdomains');
        const hostname = window.location.hostname;
        if (data.pe_all_subdomains === true) {
          const parts = hostname.split('.');
          if (parts.length > 2) {
            const secondLast = parts[parts.length - 2];
            if (['com', 'co', 'net', 'org', 'gov', 'edu'].includes(secondLast) && parts.length > 3) {
              return parts.slice(-3).join('.');
            }
            return parts.slice(-2).join('.');
          }
        }
        return hostname;
      } catch (e) {
        return window.location.hostname;
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
        styleEl = document.createElement('style');
        styleEl.id = 'pe-stylesheet';
        // Append to documentElement immediately to avoid layout flash on load
        document.documentElement.appendChild(styleEl);
      }
      if (selectors.length === 0) {
        styleEl.textContent = '';
        this._updateBadge(0);
        return;
      }
      const cssRules = selectors.map(item => {
        const isString = typeof item === 'string';
        const sel = isString ? item : item.selector;
        const act = isString ? 'hide' : item.action;
        
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
      this._updateBadge(selectors.length);
    }

    _updateBadge(count) {
      try {
        chrome.runtime.sendMessage({ type: 'UPDATE_BADGE', count });
      } catch (e) {
        // Extension context may be invalidated
      }
    }

    /* ─── Selection Mode ────────────────────────────────────── */

    _startSelectionMode(silent = false) {
      if (this.active) return;
      this.active = true;
      this._altPressed = false;
      if (!silent) {
        RetroAudio.playSelection();
      }

      // Create overlay nodes dynamically inside body
      this._ensureHighlighterElements();

      // Mouse movements to track hover
      this._mouseMoveHandler = (e) => {
        if (!this.active) return;
        if (this._ticking) return;
        this._ticking = true;
        
        const target = e.target;
        const altKey = e.altKey;
        
        requestAnimationFrame(() => {
          this._handleMouseMove({ target, altKey });
          this._ticking = false;
        });
      };
      document.addEventListener('mousemove', this._mouseMoveHandler, { passive: true });

      // Click capture to intercept erasure trigger
      this._clickCaptureHandler = (e) => {
        if (!this.active) return;

        const targetEl = e.target;
        if (!targetEl) return;

        // Ignore clicks on our own injected elements
        if (targetEl.closest('.pe-clippy-buddy') || 
            targetEl.closest('.pe-highlighter') || 
            targetEl.closest('.pe-toast-container') ||
            targetEl.closest('#pe-paint-toolbox') ||
            targetEl.closest('#pe-paint-canvas') ||
            targetEl.id === 'pe-stylesheet') {
          return;
        }

        e.preventDefault();
        e.stopPropagation();

        const elementToErase = this.selectedElement && this.selectedElement.nodeType === Node.ELEMENT_NODE 
          ? this.selectedElement 
          : targetEl;

        if (elementToErase && elementToErase !== document.body && elementToErase !== document.documentElement) {
          const action = e.altKey ? 'stretch' : 'hide';
          this._eraseElement(elementToErase, action);
        }
      };
      window.addEventListener('click', this._clickCaptureHandler, true);

      // Alt key listener to dynamically update highlighter borders & tooltip
      this._altKeyHandler = (e) => {
        if (this._altPressed !== e.altKey) {
          this._altPressed = e.altKey;
          this._updateHighlight();
        }
      };
      window.addEventListener('keydown', this._altKeyHandler, true);
      window.addEventListener('keyup', this._altKeyHandler, true);

      // Add dynamic selection cursor style
      if (document.body) {
        document.body.style.setProperty('cursor', 'crosshair', 'important');
      }

      this._injectClippy();
    }

    _stopSelectionMode() {
      if (!this.active) return;
      this.active = false;

      // Clean up event listeners
      if (this._mouseMoveHandler) {
        document.removeEventListener('mousemove', this._mouseMoveHandler);
        this._mouseMoveHandler = null;
      }
      if (this._clickCaptureHandler) {
        window.removeEventListener('click', this._clickCaptureHandler, true);
        this._clickCaptureHandler = null;
      }
      if (this._altKeyHandler) {
        window.removeEventListener('keydown', this._altKeyHandler, true);
        window.removeEventListener('keyup', this._altKeyHandler, true);
        this._altKeyHandler = null;
      }
      this._altPressed = false;

      // Hide highlight box
      if (this.highlighterEl) {
        this.highlighterEl.classList.remove('pe-active');
      }

      // Restore cursor
      if (document.body) {
        document.body.style.removeProperty('cursor');
      }
      
      this.highlightedElement = null;
      this.selectedElement = null;

      setTimeout(() => {
        if (!this.active) {
          this._removeClippy();
        }
      }, 700);
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
          <button class="pe-toast-close-btn" type="button" aria-label="Close"></button>
        `;

        // Toast body content
        const body = document.createElement('div');
        body.className = 'pe-toast-body';

        const text = document.createElement('span');
        text.className = 'pe-toast-text';

        let icon = 'ℹ️';
        if (action === 'erase') icon = '🗑️';
        if (action === 'stretch') icon = '↔️';
        if (action === 'success') icon = '✔️';

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

    _handleMouseMove(e) {
      const target = e.target;
      if (!target || target === document.documentElement || target === document.body) return;

      // Ignore hover on our own highlighter/tooltip elements
      if (target.classList.contains('pe-highlighter') || 
          target.classList.contains('pe-tooltip') || 
          target.closest('.pe-highlighter') || 
          target.id === 'pe-stylesheet') {
        return;
      }

      this._altPressed = e.altKey;

      if (this.highlightedElement !== target) {
        this.highlightedElement = target;
        this.selectedElement = target;
        this._updateHighlight();
      } else {
        this._updateHighlight();
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

      // Update color theme based on Alt key
      this.highlighterEl.classList.toggle('pe-stretch-mode', this._altPressed);

      // Update tooltip text and position (prevent overlay overflow at viewport top)
      if (rect.top < 40) {
        this.tooltipEl.style.bottom = 'auto';
        this.tooltipEl.style.top = 'calc(100% + 8px)';
      } else {
        this.tooltipEl.style.bottom = 'calc(100% + 8px)';
        this.tooltipEl.style.top = 'auto';
      }

      const selector = this._getSelector(this.selectedElement);
      const displaySelector = selector.length > 50 ? '...' + selector.slice(-50) : selector;
      const tag = this.selectedElement.tagName.toLowerCase();

      const isTr = this.isTr;
      const actionText = this._altPressed
        ? (isTr
            ? `<span style="color:#00d2d3;font-weight:700;"><kbd>Tıkla</kbd> Genişliğe Sığdır</span>`
            : `<span style="color:#00d2d3;font-weight:700;"><kbd>Click</kbd> Stretch to Full Width</span>`)
        : (isTr
            ? `<span style="color:#ff4757;font-weight:700;"><kbd>Tıkla</kbd> Elementi Sil</span> <span style="opacity: 0.5; margin: 0 4px;">|</span> <kbd>Alt+Tıkla</kbd> Sığdır`
            : `<span style="color:#ff4757;font-weight:700;"><kbd>Click</kbd> Erase Element</span> <span style="opacity: 0.5; margin: 0 4px;">|</span> <kbd>Alt+Click</kbd> Stretch`);

      const parentText = isTr ? 'Üst' : 'Parent';
      const childText = isTr ? 'Alt' : 'Child';
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
          const data = await storage.get(key);
          let selectors = data[key] || [];
          
          // Remove existing rule for same selector to prevent conflict
          selectors = selectors.filter(item => {
            const sel = typeof item === 'string' ? item : item.selector;
            return sel !== selector;
          });

          selectors.push({ selector, action });
          await storage.set({ [key]: selectors });
          this._applySelectors(selectors);
          this._undoStack.push({ selector, action });
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
        const data = await storage.get(key);
        let selectors = data[key] || [];
        
        selectors = selectors.filter(item => {
          const sel = typeof item === 'string' ? item : item.selector;
          return sel !== selector;
        });
        await storage.set({ [key]: selectors });
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
      } catch (err) {
        this._log('Error restoring element:', err);
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
        // Handle global Undo shortcut (Ctrl+Z)
        if (e.ctrlKey && e.key.toLowerCase() === 'z') {
          const activeEl = document.activeElement;
          if (activeEl && (
            activeEl.tagName === 'INPUT' || 
            activeEl.tagName === 'TEXTAREA' || 
            activeEl.isContentEditable
          )) {
            return;
          }

          if (this._undoStack && this._undoStack.length > 0) {
            e.preventDefault();
            const lastItem = this._undoStack.pop();
            this._restoreSelector(lastItem.selector);
            const isTr = this.isTr;
            const msg = isTr ? 'Geri Al: Element Eski Haline Getirildi' : 'Undo: Element Restored';
            this._showToast(msg, 'success');
          }
          return;
        }

        if (!this.active) return;

        if (e.key === 'Escape') {
          e.preventDefault();
          this._stopSelectionMode();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (this.selectedElement && 
              this.selectedElement.parentElement && 
              this.selectedElement.parentElement !== document.body && 
              this.selectedElement.parentElement !== document.documentElement) {
            this.selectedElement = this.selectedElement.parentElement;
            this._updateHighlight();
          }
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (this.selectedElement) {
            // Tree traversal: first child → next sibling → parent's next sibling
            let next = null;

            // 1. Try first child
            if (this.selectedElement.firstElementChild) {
              next = this.selectedElement.firstElementChild;
            }
            // 2. Try next sibling
            if (!next && this.selectedElement.nextElementSibling) {
              next = this.selectedElement.nextElementSibling;
            }
            // 3. Bubble up to find an ancestor's next sibling
            if (!next) {
              let ancestor = this.selectedElement.parentElement;
              while (ancestor && 
                     ancestor !== document.body && 
                     ancestor !== document.documentElement) {
                if (ancestor.nextElementSibling) {
                  next = ancestor.nextElementSibling;
                  break;
                }
                ancestor = ancestor.parentElement;
              }
            }

            if (next && 
                next !== document.body && 
                next !== document.documentElement) {
              this.selectedElement = next;
              this._updateHighlight();
            }
          }
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          if (this.selectedElement && this.selectedElement.nextElementSibling) {
            this.selectedElement = this.selectedElement.nextElementSibling;
            this._updateHighlight();
          }
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          if (this.selectedElement && this.selectedElement.previousElementSibling) {
            this.selectedElement = this.selectedElement.previousElementSibling;
            this._updateHighlight();
          }
        }
      });
    }

    /* ─── Message Handling ──────────────────────────────────── */

    _setupMessageListener() {
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
              sendResponse({ active: this.active });
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

    _startPaintMode() {
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
          <button class="pe-paint-toolbox-close" type="button" aria-label="Close"></button>
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
        RetroAudio.playSelection();
      };

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

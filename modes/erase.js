/**
 * PageEraser Chrome Extension — Erase Mode
 *
 * The element picker: hover to highlight, arrow keys to walk the tree, click
 * to erase (Alt+click to stretch). This is the selection behaviour that used
 * to live inside content.js, moved behind the mode interface in modes/index.js
 * without changing what it does.
 *
 * The mode owns the picker's interaction only. The page-level state it drives
 * (`active`, `selectedElement`, the highlighter overlay, Clippy) and the actual
 * erasing stay on the PageEraser instance passed in as `host`.
 */
function PE_createEraseMode(host) {
  // Our own injected nodes are never valid targets.
  const isOwnUi = (el) =>
    el.closest('.pe-clippy-buddy') ||
    el.closest('.pe-highlighter') ||
    el.closest('.pe-toast-container') ||
    el.closest('#pe-paint-toolbox') ||
    el.closest('#pe-paint-canvas') ||
    el.id === 'pe-stylesheet';

  return {
    enter(opts) {
      const silent = !!(opts && opts.silent);
      host.active = true;
      host._altPressed = false;
      if (!silent) host._playSelectionSound();

      // Overlay nodes live inside <body>
      host._ensureHighlighterElements();

      // Selection cursor
      if (document.body) {
        document.body.style.setProperty('cursor', 'crosshair', 'important');
      }

      host._injectClippy();
    },

    exit() {
      host.active = false;
      host._altPressed = false;

      // Hide highlight box
      if (host.highlighterEl) {
        host.highlighterEl.classList.remove('pe-active');
      }

      // Restore cursor
      if (document.body) {
        document.body.style.removeProperty('cursor');
      }

      host.highlightedElement = null;
      host.selectedElement = null;

      setTimeout(() => {
        if (!host.active) {
          host._removeClippy();
        }
      }, 700);
    },

    onPointerMove(info) {
      const target = info.target;
      if (!target || target === document.documentElement || target === document.body) return;

      // Our own nodes (highlighter, tooltip, toasts, Clippy, the paint tools)
      // are never a target: hovering a toast used to select it.
      if (isOwnUi(target)) return;

      host._altPressed = info.altKey;

      if (host.highlightedElement !== target) {
        host.highlightedElement = target;
        host.selectedElement = target;
      }
      host._updateHighlight();
    },

    onClick(e) {
      const targetEl = e.target;
      if (!targetEl) return;

      // Ignore clicks on our own injected elements
      if (isOwnUi(targetEl)) return;

      e.preventDefault();
      e.stopPropagation();

      const elementToErase = host.selectedElement && host.selectedElement.nodeType === Node.ELEMENT_NODE
        ? host.selectedElement
        : targetEl;

      if (elementToErase && elementToErase !== document.body && elementToErase !== document.documentElement) {
        const action = e.altKey ? 'stretch' : 'hide';
        host._eraseElement(elementToErase, action);
      }
    },

    /* Alt switches the highlighter between "erase" and "stretch" styling. */
    onModifier(e) {
      if (host._altPressed !== e.altKey) {
        host._altPressed = e.altKey;
        host._updateHighlight();
      }
    },

    /* Arrow keys walk the DOM from the hovered element. */
    onKey(e) {
      const sel = host.selectedElement;

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (sel &&
            sel.parentElement &&
            sel.parentElement !== document.body &&
            sel.parentElement !== document.documentElement) {
          host.selectedElement = sel.parentElement;
          host._updateHighlight();
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (sel) {
          // Tree traversal: first child → next sibling → parent's next sibling
          let next = null;

          // 1. Try first child
          if (sel.firstElementChild) {
            next = sel.firstElementChild;
          }
          // 2. Try next sibling
          if (!next && sel.nextElementSibling) {
            next = sel.nextElementSibling;
          }
          // 3. Bubble up to find an ancestor's next sibling
          if (!next) {
            let ancestor = sel.parentElement;
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
            host.selectedElement = next;
            host._updateHighlight();
          }
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (sel && sel.nextElementSibling) {
          host.selectedElement = sel.nextElementSibling;
          host._updateHighlight();
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (sel && sel.previousElementSibling) {
          host.selectedElement = sel.previousElementSibling;
          host._updateHighlight();
        }
      }
    }
  };
}

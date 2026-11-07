/**
 * PageEraser Chrome Extension — Core Popup & Side Panel Script
 *
 * Coordinates UI rendering, rules management, dynamic side panel updates,
 * locales translation, retro theme/contrast styling, and sub-module loaders.
 *
 * @version 1.6.0
 */
(function () {
  'use strict';

  // Use local storage for unlimited rule storage capacity (10MB limit)
  const storage = chrome.storage.local;

  /* ─── DOM References ─────────────────────────────────────── */
  const btnSelect     = document.getElementById('btn-select');
  const btnXray       = document.getElementById('btn-xray');
  const btnExtract    = document.getElementById('btn-extract');
  const btnDiff       = document.getElementById('btn-diff');
  const btnReset      = document.getElementById('btn-reset');
  const domainNameEl  = document.getElementById('domain-name');
  const reachNotice   = document.getElementById('reach-notice');
  const hiddenCountEl = document.getElementById('hidden-count');
  const selectorsList = document.getElementById('selectors-list');
  const filterInput   = document.getElementById('filter-input');

  // Menu Dropdown references
  const menuItems = document.querySelectorAll('.menu-item');
  const dropdownMenus = document.querySelectorAll('.dropdown-menu');

  // Modal references
  const aboutOverlay = document.getElementById('about-overlay');
  const aboutModal = aboutOverlay.querySelector('.win-modal');
  const aboutTitleBar = aboutModal.querySelector('.title-bar');
  const btnCloseAbout = document.getElementById('btn-close-about');
  const btnOkAbout = document.getElementById('btn-ok-about');

  let currentDomain = '';
  let activeTabId = null;
  let allSelectors = []; // Cache list for live filtering

  // ─── Domain Scope Helpers ─────────────────────────────────
  // PE_getBaseDomain lives in shared.js so the content script scopes rules
  // to exactly the same domain we do here.
  const getBaseDomain = PE_getBaseDomain;

  async function getDomainToUse(hostname) {
    const scopeData = await storage.get('pe_all_subdomains');
    if (scopeData.pe_all_subdomains === true) {
      return getBaseDomain(hostname);
    }
    return hostname;
  }

  const aboutDrag = setupDraggableModal(aboutModal, aboutTitleBar);

  /* ─── Initialization ─────────────────────────────────────── */
  async function init() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;
      activeTabId = tab.id;

      // Initialize language UI state
      const langData = await storage.get('pe_lang');
      const activeLang = langData.pe_lang || (navigator.language.startsWith('tr') ? 'tr' : 'en');
      await selectLanguage(activeLang, false);

      // Initialize subdomains checkmark UI state
      const scopeData = await storage.get('pe_all_subdomains');
      const scopeItem = document.getElementById('menu-item-scope');
      if (scopeData.pe_all_subdomains === true) {
        scopeItem.classList.add('checked');
      } else {
        scopeItem.classList.remove('checked');
      }

      // Initialize persist checkbox UI state
      const persistData = await storage.get('pe_persist');
      const chkPersist = document.getElementById('chk-persist');
      if (chkPersist) {
        chkPersist.checked = persistData.pe_persist !== false; // default to true
        chkPersist.addEventListener('change', async () => {
          await storage.set({ pe_persist: chkPersist.checked });
        });
      }

      await handleActiveTabChange(tab);

      // Initialize option sound checkmark UI state
      const soundData = await storage.get('pe_sounds');
      const soundItem = document.getElementById('menu-item-sounds');
      if (soundData.pe_sounds === false) {
        soundItem.classList.remove('checked');
      } else {
        soundItem.classList.add('checked');
      }

      // Initialize Clippy enabled checkmark UI state
      const clippyData = await storage.get('pe_clippy_enabled');
      const clippyItem = document.getElementById('menu-item-clippy-toggle');
      const clippyEnabled = clippyData.pe_clippy_enabled !== false;
      if (clippyItem) {
        if (clippyEnabled) {
          clippyItem.classList.add('checked');
        } else {
          clippyItem.classList.remove('checked');
        }
      }

      // Initialize theme UI state
      const themeData = await storage.get('pe_theme');
      const activeTheme = themeData.pe_theme || 'teal';
      selectTheme(activeTheme);

      // Initialize Contrast UI state
      const contrastData = await storage.get('pe_contrast');
      const activeContrast = contrastData.pe_contrast === true;
      await selectContrast(activeContrast, false);

      // Initialize Text Scale UI state
      const textScaleData = await storage.get('pe_text_scale');
      const activeTextScale = textScaleData.pe_text_scale === true;
      await selectTextScale(activeTextScale, false);

      startClock();

      // Play Windows 95 startup sound
      RetroAudio.playStartup();

      // Initialize and start Spotlight Tour
      SpotlightTour.init();
      const tourData = await storage.get('pe_tour_completed');
      if (!tourData.pe_tour_completed) {
        SpotlightTour.start();
      }

      // Initialize Minesweeper Easter Egg
      MinesweeperGame.init();

      // Initialize Clippy Assistant
      ClippyAssistant.init();
      ClippyAssistant.setEnabled(clippyEnabled);
    } catch (err) {
      console.log('[PageEraser] Popup init status:', err);
    }
  }

  /* ─── Active Tab Change Handler (Live Sync for Side Panel) ─── */
  async function handleActiveTabChange(tab) {
    if (!tab) return;
    activeTabId = tab.id;

    hideReachNotice();
    if (tab.url) {
      const urlObj = new URL(tab.url);
      if (urlObj.protocol.startsWith('http') && !isRestrictedPage(urlObj)) {
        const domainToUse = await getDomainToUse(urlObj.hostname);
        currentDomain = domainToUse;
        domainNameEl.textContent = currentDomain;
        btnSelect.disabled = false;
        btnXray.disabled = false;
        btnExtract.disabled = false;
        btnDiff.disabled = false;
        await refreshSelectorsList();
      } else {
        currentDomain = '';
        domainNameEl.textContent = LOCALES[currentLang].cannotRun;
        btnSelect.disabled = true;
        btnXray.disabled = true;
        btnExtract.disabled = true;
        btnDiff.disabled = true;
        btnReset.disabled = true;
        selectorsList.innerHTML = `<div class="empty-state">${LOCALES[currentLang].noElements}</div>`;
        hiddenCountEl.textContent = '0';
      }
    }
  }

  /* ─── Messaging Helper ───────────────────────────────────── */
  function sendMessageToTab(message) {
    return new Promise((resolve) => {
      if (!activeTabId) {
        resolve(null);
        return;
      }
      try {
        chrome.tabs.sendMessage(activeTabId, message, (response) => {
          if (chrome.runtime.lastError) {
            console.log('[PageEraser] Tab communication status:', chrome.runtime.lastError.message);
            resolve(null);
          } else {
            resolve(response);
          }
        });
      } catch (err) {
        console.log('[PageEraser] Messaging runtime exception:', err);
        resolve(null);
      }
    });
  }

  /* ─── Starting a mode on the page ────────────────────────── */
  // Chrome keeps extensions out of its own stores, and an extension that was
  // just installed or updated has no content script in the tabs that were
  // already open. Either way nothing answers the message, and closing the popup
  // straight away would look like the button did nothing.
  function isRestrictedPage(urlObj) {
    const host = urlObj.hostname;
    return host === 'chromewebstore.google.com'
      || (host === 'chrome.google.com' && urlObj.pathname.startsWith('/webstore'))
      || (host === 'microsoftedge.microsoft.com' && urlObj.pathname.startsWith('/addons'));
  }

  function showReachNotice() {
    reachNotice.textContent = LOCALES[currentLang].reachNotice;
    reachNotice.hidden = false;
  }

  function hideReachNotice() {
    reachNotice.hidden = true;
  }

  /* Sends a start/toggle message. The popup closes once the page has taken it;
   * when nothing on the page answered it stays open and says what to do. */
  async function launchOnTab(message) {
    const response = await sendMessageToTab(message);
    if (response === null) {
      showReachNotice();
      return false;
    }
    hideReachNotice();
    window.close();
    return true;
  }

  /* ─── UI Refresh & Filtering ─────────────────────────────── */
  async function refreshSelectorsList() {
    if (!currentDomain) return;

    try {
      const key = `pe_selectors_${currentDomain}`;
      const data = await storage.get(key);
      allSelectors = data[key] || [];

      // Update badge count (everything hidden on this site, bin or not)
      hiddenCountEl.textContent = allSelectors.length;

      // Update reset button state
      btnReset.disabled = allSelectors.length === 0;

      applyFilter();
      updateRecycleBinIcon();
    } catch (err) {
      console.log('[PageEraser] Status listing selectors:', err);
    }
  }

  /* What the Recycle Bin holds: every rule except those deleted for good. */
  function binItems() {
    return allSelectors.filter(itemData => !(itemData && itemData.permanent === true));
  }

  /* Full while there is something to restore, empty otherwise. */
  function updateRecycleBinIcon() {
    const icon = document.getElementById('recycle-bin-icon');
    if (!icon) return;
    const full = binItems().length > 0;
    icon.classList.toggle('full', full);
    icon.classList.toggle('empty', !full);
  }

  function applyFilter() {
    selectorsList.innerHTML = '';
    const query = filterInput.value.toLowerCase().trim();
    const inBin = binItems();

    const filtered = inBin.filter(itemData => {
      const selector = typeof itemData === 'string' ? itemData : itemData.selector;
      return selector.toLowerCase().includes(query);
    });

    if (filtered.length === 0) {
      const msg = inBin.length === 0 ? LOCALES[currentLang].noElements : LOCALES[currentLang].noMatches;
      selectorsList.innerHTML = `<div class="empty-state">${msg}</div>`;
      return;
    }

    // Rules that came from someone else's code are listed last, under their own heading.
    const isImportedRule = (rule) => !!rule && typeof rule === 'object' && rule.imported === true;
    const ordered = [...filtered.filter((rule) => !isImportedRule(rule)), ...filtered.filter(isImportedRule)];
    let importedHeadingShown = false;

    ordered.forEach((itemData) => {
      const isString = typeof itemData === 'string';
      const selectorStr = isString ? itemData : itemData.selector;
      const action = isString ? 'hide' : itemData.action;

      const item = document.createElement('div');
      item.className = isImportedRule(itemData) ? 'selector-item imported' : 'selector-item';
      item.draggable = true;

      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', selectorStr);
        e.dataTransfer.effectAllowed = 'move';
      });

      // Hover highlighting logic
      item.addEventListener('mouseenter', () => {
        sendMessageToTab({ type: 'HIGHLIGHT_SELECTOR', selector: selectorStr });
        ClippyAssistant.handleHover('rulesItem');
      });
      item.addEventListener('mouseleave', () => {
        sendMessageToTab({ type: 'CLEAR_HIGHLIGHT' });
      });

      const actionBadge = document.createElement('span');
      actionBadge.className = `action-badge badge-${action}`;
      actionBadge.textContent = action === 'stretch' 
        ? (currentLang === 'tr' ? 'Sığdır' : 'Stretch') 
        : (currentLang === 'tr' ? 'Gizle' : 'Erase');

      const text = document.createElement('span');
      text.className = `selector-text text-${action}`;
      text.textContent = selectorStr;
      text.title = selectorStr;

      // Inline controls container
      const controlsContainer = document.createElement('div');
      controlsContainer.style.display = 'flex';
      controlsContainer.style.gap = '2px';

      const editBtn = document.createElement('button');
      editBtn.className = 'win-btn win-btn-sm';
      editBtn.innerHTML = `<span>${currentLang === 'en' ? 'Edit' : 'Düzenle'}</span>`;

      const restoreBtn = document.createElement('button');
      restoreBtn.className = 'win-btn win-btn-sm';
      restoreBtn.title = currentLang === 'en' ? 'Restore element' : 'Elementi geri yükle';
      restoreBtn.innerHTML = `<span>${LOCALES[currentLang].restoreBtn}</span>`;

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'win-btn win-btn-sm';
      deleteBtn.title = LOCALES[currentLang].deleteForeverBtn;
      deleteBtn.setAttribute('aria-label', LOCALES[currentLang].deleteForeverBtn);
      deleteBtn.innerHTML = '<span>✕</span>';

      // Inline selector editing logic
      editBtn.addEventListener('click', () => {
        // Toggle item text into an input box
        const editInput = document.createElement('input');
        editInput.type = 'text';
        editInput.className = 'win-input';
        editInput.value = selectorStr;
        editInput.style.flex = '1';
        editInput.style.marginRight = '4px';
        editInput.style.fontSize = '11px';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'win-btn win-btn-sm';
        saveBtn.innerHTML = `<span>${currentLang === 'en' ? 'Save' : 'Kaydet'}</span>`;

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'win-btn win-btn-sm';
        cancelBtn.innerHTML = `<span>${currentLang === 'en' ? 'Cancel' : 'İptal'}</span>`;

        // Update layout
        item.innerHTML = '';
        item.appendChild(actionBadge);
        item.appendChild(editInput);
        item.appendChild(saveBtn);
        item.appendChild(cancelBtn);
        editInput.focus();

        saveBtn.addEventListener('click', async () => {
          const newSelector = editInput.value.trim();
          // Saving without changing the selector (or only its spaces) changes
          // nothing. It must not go on: the tab would be told to restore the
          // old selector, and that removes the rule that was just written.
          if (newSelector === selectorStr) {
            applyFilter();
            return;
          }
          // Hand-typed selectors get interpolated into a page stylesheet, so
          // they go through the same validation as an imported rule.
          if (!PE_isSafeSelector(newSelector)) {
            RetroAudio.playError();
            editInput.classList.add('win-input-invalid');
            editInput.focus();
            editInput.select();
            return;
          }
          editInput.classList.remove('win-input-invalid');

          RetroAudio.playSelection();

          // 1. Swap the rule in storage right here, as Restore does. Asking the
          // tab to remove the old one is not enough: a tab that is not
          // answering (opened before an update) used to leave the old rule in
          // place next to the new one.
          const key = `pe_selectors_${currentDomain}`;
          const data = await storage.get(key);
          let selectors = (data[key] || []).filter(item => {
            const sel = typeof item === 'string' ? item : (item && item.selector);
            return sel !== selectorStr;
          });
          if (isString) {
            selectors.push(newSelector);
          } else {
            selectors.push({ selector: newSelector, action: action });
          }
          await storage.set({ [key]: selectors });

          // 2. The tab clears the inline styles the old rule left on the page...
          await sendMessageToTab({ type: 'RESTORE_SELECTOR', selector: selectorStr, silent: true });

          // 3. ...and loads and applies the new list.
          await sendMessageToTab({ type: 'REFRESH_RULES', silent: true });

          await refreshSelectorsList();
        });

        cancelBtn.addEventListener('click', () => {
          applyFilter();
        });
      });

      restoreBtn.addEventListener('click', async () => {
        // Update local storage directly in popup for robust synchronization
        const key = `pe_selectors_${currentDomain}`;
        const data = await storage.get(key);
        let selectors = data[key] || [];
        selectors = selectors.filter(item => {
          const sel = typeof item === 'string' ? item : item.selector;
          return sel !== selectorStr;
        });
        await storage.set({ [key]: selectors });

        // Request content script to remove styles and visually restore the element
        await sendMessageToTab({ type: 'RESTORE_SELECTOR', selector: selectorStr, silent: true });
        RetroAudio.playReset();
        await refreshSelectorsList();
      });

      // Delete permanently: the rule stays (the element stays hidden) but it
      // leaves the bin, so it can no longer be restored one by one.
      deleteBtn.addEventListener('click', async () => {
        const confirmed = await askConfirm('confirmDeleteTitle', 'confirmDeleteMessage', selectorStr);
        if (!confirmed) return;

        const key = `pe_selectors_${currentDomain}`;
        const data = await storage.get(key);
        const selectors = (data[key] || []).map(rule => {
          const sel = typeof rule === 'string' ? rule : rule.selector;
          if (sel !== selectorStr) return rule;
          return { selector: sel, action: typeof rule === 'string' ? 'hide' : rule.action, permanent: true };
        });
        await storage.set({ [key]: selectors });

        RetroAudio.playTrash();
        await refreshSelectorsList();
      });

      controlsContainer.appendChild(editBtn);
      controlsContainer.appendChild(restoreBtn);
      controlsContainer.appendChild(deleteBtn);

      item.appendChild(actionBadge);
      item.appendChild(text);
      item.appendChild(controlsContainer);
      if (isImportedRule(itemData) && !importedHeadingShown) {
        importedHeadingShown = true;
        selectorsList.appendChild(buildImportedBanner());
      }
      selectorsList.appendChild(item);
    });
  }

  /* ─── Imported rules: keep or remove them all in one click ── */
  function importedRules() {
    return allSelectors.filter((rule) => rule && typeof rule === 'object' && rule.imported === true && rule.permanent !== true);
  }

  function buildImportedBanner() {
    const t = LOCALES[currentLang];
    const count = importedRules().length;
    const bar = document.createElement('div');
    bar.className = 'imported-banner';

    const label = document.createElement('span');
    label.className = 'imported-banner-text';
    label.textContent = count === 1 ? t.importedBannerOne : fill(t.importedBanner, { n: count });

    const makeButton = (text, title, handler) => {
      const button = document.createElement('button');
      button.className = 'win-btn win-btn-sm';
      button.type = 'button';
      button.title = title;
      const span = document.createElement('span');
      span.textContent = text;
      button.appendChild(span);
      button.addEventListener('click', handler);
      return button;
    };
    bar.appendChild(label);
    bar.appendChild(makeButton(t.importedKeep, t.importedKeepTitle, keepImported));
    bar.appendChild(makeButton(t.importedRemove, t.importedRemoveTitle, removeImported));
    return bar;
  }

  /* The imported rules become the user's own: same rules, no label. */
  async function keepImported() {
    if (!currentDomain) return;
    const key = `pe_selectors_${currentDomain}`;
    const data = await storage.get(key);
    const rules = (data[key] || []).map((rule) => {
      if (!rule || typeof rule !== 'object' || rule.imported !== true) return rule;
      const own = { ...rule };
      delete own.imported;
      return own;
    });
    await storage.set({ [key]: rules });
    RetroAudio.playSelection();
    await refreshSelectorsList();
  }

  /* One click, no questions: the elements come back as soon as the rules go. */
  async function removeImported() {
    if (!currentDomain) return;
    const key = `pe_selectors_${currentDomain}`;
    const data = await storage.get(key);
    const rules = (data[key] || []).filter((rule) => !(rule && typeof rule === 'object' && rule.imported === true && rule.permanent !== true));
    await storage.set({ [key]: rules });
    await sendMessageToTab({ type: 'REFRESH_RULES', silent: true });
    RetroAudio.playReset();
    await refreshSelectorsList();
  }

  /* ─── Menu Bar Controls ──────────────────────────────────── */
  menuItems.forEach((menuItem) => {
    menuItem.addEventListener('click', (e) => {
      e.stopPropagation();
      const parent = menuItem.parentElement;
      const dropdown = parent.querySelector('.dropdown-menu');
      
      const wasVisible = dropdown.classList.contains('visible');
      closeAllDropdowns();

      if (!wasVisible) {
        dropdown.classList.add('visible');
        menuItem.classList.add('active');
        menuItem.setAttribute('aria-expanded', 'true');
      }
    });
  });

  function closeAllDropdowns() {
    dropdownMenus.forEach(d => d.classList.remove('visible'));
    menuItems.forEach(m => {
      m.classList.remove('active');
      m.setAttribute('aria-expanded', 'false');
    });
  }

  document.addEventListener('click', () => {
    closeAllDropdowns();
  });

  /* ─── Menu Bar: keyboard ──────────────────────────────────
   * The menus used to answer to the mouse only: Tab skipped them, Enter did
   * nothing, and everything under File, Options and Help (export and import,
   * copy as code, language, theme) was out of reach without one.
   *   menu title : Enter / Space / ↓ open it, ↑ opens it at the last entry,
   *                ← → move to the next title, Esc closes
   *   entry      : ↑ ↓ Home End move, Enter / Space choose, ← → change menu,
   *                Esc closes and returns to the title, Tab leaves
   *   Alt + the underlined letter opens a menu (the letter follows the language)
   */
  const menuBarItems = Array.from(menuItems);
  const dropdownOf = (menuItem) => menuItem.parentElement.querySelector('.dropdown-menu');
  const entriesOf = (dropdown) => Array.from(dropdown.querySelectorAll('.dropdown-item'));

  function openMenu(menuItem, focusWhich) {
    closeAllDropdowns();
    const dropdown = dropdownOf(menuItem);
    dropdown.classList.add('visible');
    menuItem.classList.add('active');
    menuItem.setAttribute('aria-expanded', 'true');
    if (focusWhich) {
      const list = entriesOf(dropdown);
      const target = focusWhich === 'last' ? list[list.length - 1] : list[0];
      if (target) target.focus();
    }
  }

  function hopMenu(fromItem, step, keepOpen) {
    const count = menuBarItems.length;
    const next = menuBarItems[(menuBarItems.indexOf(fromItem) + step + count) % count];
    if (keepOpen) openMenu(next, 'first'); else next.focus();
  }

  menuBarItems.forEach((menuItem) => {
    menuItem.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const isOpen = menuItem.classList.contains('active');
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') openMenu(menuItem, 'first');
      else if (e.key === 'ArrowUp') openMenu(menuItem, 'last');
      else if (e.key === 'ArrowRight') hopMenu(menuItem, 1, isOpen);
      else if (e.key === 'ArrowLeft') hopMenu(menuItem, -1, isOpen);
      else if (e.key === 'Escape') closeAllDropdowns();
      else return;
      e.preventDefault();
    });
  });

  dropdownMenus.forEach((dropdown) => {
    const owner = dropdown.parentElement.querySelector('.menu-item');

    dropdown.addEventListener('keydown', (e) => {
      const entry = e.target.closest ? e.target.closest('.dropdown-item') : null;
      if (!entry || e.altKey || e.ctrlKey || e.metaKey) return;
      const list = entriesOf(dropdown);
      const at = list.indexOf(entry);
      switch (e.key) {
        case 'ArrowDown': list[(at + 1) % list.length].focus(); break;
        case 'ArrowUp': list[(at - 1 + list.length) % list.length].focus(); break;
        case 'Home': list[0].focus(); break;
        case 'End': list[list.length - 1].focus(); break;
        case 'ArrowRight': hopMenu(owner, 1, true); break;
        case 'ArrowLeft': hopMenu(owner, -1, true); break;
        case 'Escape': closeAllDropdowns(); owner.focus(); break;
        case 'Tab': closeAllDropdowns(); return; // let Tab carry on from here
        case 'Enter':
        case ' ': entry.click(); break;
        default: return;
      }
      e.preventDefault();
    });

    // Choosing an entry that closes the menu hands focus back to the menu
    // title first: a dialog it opens then remembers a visible place to return
    // to (the entry itself is about to disappear). Capture phase, so this runs
    // before the entry's own handler.
    dropdown.addEventListener('click', (e) => {
      const entry = e.target.closest ? e.target.closest('.dropdown-item') : null;
      if (entry && !entry.classList.contains('checkable')) owner.focus();
    }, true);
  });

  // Checkable entries say whether they are on, for screen readers.
  document.querySelectorAll('.dropdown-item[aria-checked]').forEach((entry) => {
    const sync = () => entry.setAttribute('aria-checked', entry.classList.contains('checked') ? 'true' : 'false');
    sync();
    new MutationObserver(sync).observe(entry, { attributes: true, attributeFilter: ['class'] });
  });

  const dialogIsOpen = () => Array.from(
    document.querySelectorAll('.win-modal-overlay, .win-overlay, .win-tour-overlay, #bsod-overlay')
  ).some((overlay) => window.getComputedStyle(overlay).display !== 'none');

  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
    const letter = String(e.key || '').toLowerCase();
    const target = menuBarItems.find((menuItem) => {
      const mark = menuItem.querySelector('.underline');
      return mark && mark.textContent.trim().toLowerCase() === letter;
    });
    if (!target || dialogIsOpen()) return;
    e.preventDefault();
    openMenu(target, 'first');
  });

  /* About and Minesweeper were plain overlays: no dialog role, Tab walked out
   * to the page behind and Esc did nothing. They get what the other dialogs
   * have: focus moves in, Tab stays inside, Esc closes, focus goes back to
   * where it came from. Several files show them through style.display, so the
   * overlay is watched instead of every caller being changed. */
  function makeDialogKeyboardFriendly(overlay, closeButton) {
    if (!overlay || !closeButton) return;
    let before = null;
    let wasOpen = false;
    const isOpen = () => overlay.style.display !== '' && overlay.style.display !== 'none';
    const focusables = () => Array.from(
      overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    ).filter((el) => !el.disabled && el.getClientRects().length > 0);

    new MutationObserver(() => {
      const open = isOpen();
      if (open && !wasOpen) {
        before = document.activeElement;
        (focusables()[0] || closeButton).focus();
      } else if (!open && wasOpen) {
        if (before && typeof before.focus === 'function' && document.contains(before)) before.focus();
        before = null;
      }
      wasOpen = open;
    }).observe(overlay, { attributes: true, attributeFilter: ['style'] });

    overlay.addEventListener('keydown', (e) => {
      if (!isOpen()) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeButton.click();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (!overlay.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  makeDialogKeyboardFriendly(aboutOverlay, btnCloseAbout);
  makeDialogKeyboardFriendly(document.getElementById('minesweeper-overlay'), document.getElementById('btn-close-minesweeper'));

  /* ─── Alert Dialog ───────────────────────────────────────── */
  const alertOverlay = document.getElementById('alert-overlay');
  const alertTitleEl = document.getElementById('alert-title');
  const alertMessageEl = document.getElementById('alert-message');
  const alertIconEl = document.getElementById('alert-icon');
  const alertOkBtn = document.getElementById('btn-ok-alert');
  let alertPreviousFocus = null;

  function showAlert(titleKey, messageKey, icon = 'ℹ️') {
    const t = LOCALES[currentLang];
    alertTitleEl.textContent = t[titleKey] || titleKey;
    alertMessageEl.textContent = t[messageKey] || messageKey;
    alertIconEl.textContent = icon;
    alertPreviousFocus = document.activeElement;
    alertOverlay.style.display = 'flex';
    alertOkBtn.focus();
  }

  function hideAlert() {
    alertOverlay.style.display = 'none';
    // Return focus where the user left it, rather than dumping it on <body>.
    if (alertPreviousFocus && alertPreviousFocus.focus) alertPreviousFocus.focus();
    alertPreviousFocus = null;
  }

  function isAlertOpen() {
    return alertOverlay.style.display === 'flex';
  }

  alertOkBtn.addEventListener('click', () => {
    RetroAudio.playSelection();
    hideAlert();
  });
  document.getElementById('btn-close-alert').addEventListener('click', hideAlert);

  // A modal has to be operable from the keyboard, and must not let focus
  // wander into the page behind it. Capture phase so it wins over the
  // shortcut handlers registered further down.
  document.addEventListener('keydown', (e) => {
    if (!isAlertOpen()) return;
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      hideAlert();
    } else if (e.key === 'Tab') {
      // Only one focusable control in this dialog, so the trap is simply
      // "keep it here".
      e.preventDefault();
      alertOkBtn.focus();
    }
  }, true);

  /* ─── Confirm Dialog ─────────────────────────────────────── */
  const confirmOverlay = document.getElementById('confirm-overlay');
  const confirmTitleEl = document.getElementById('confirm-title');
  const confirmMessageEl = document.getElementById('confirm-message');
  const confirmDetailEl = document.getElementById('confirm-detail');
  const confirmYesBtn = document.getElementById('btn-yes-confirm');
  const confirmNoBtn = document.getElementById('btn-no-confirm');
  let confirmResolve = null;
  let confirmPreviousFocus = null;

  function isConfirmOpen() {
    return confirmOverlay.style.display === 'flex';
  }

  /* Resolves true on Yes, false on No / Esc / the close button. Focus starts
   * on No, so a stray Enter can never delete anything. */
  function askConfirm(titleKey, messageKey, detail = '') {
    const t = LOCALES[currentLang];
    confirmTitleEl.textContent = t[titleKey] || titleKey;
    confirmMessageEl.textContent = t[messageKey] || messageKey;
    confirmDetailEl.textContent = detail;
    confirmDetailEl.title = detail;
    confirmPreviousFocus = document.activeElement;
    confirmOverlay.style.display = 'flex';
    confirmNoBtn.focus();
    return new Promise((resolve) => {
      confirmResolve = resolve;
    });
  }

  function closeConfirm(result) {
    confirmOverlay.style.display = 'none';
    if (confirmPreviousFocus && confirmPreviousFocus.focus) confirmPreviousFocus.focus();
    confirmPreviousFocus = null;
    const resolve = confirmResolve;
    confirmResolve = null;
    if (resolve) resolve(result);
  }

  confirmYesBtn.addEventListener('click', () => closeConfirm(true));
  confirmNoBtn.addEventListener('click', () => closeConfirm(false));
  document.getElementById('btn-close-confirm').addEventListener('click', () => closeConfirm(false));

  // Same rules as the alert dialog: operable from the keyboard, focus kept
  // inside, capture phase so it wins over the shortcut handlers below.
  document.addEventListener('keydown', (e) => {
    if (!isConfirmOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeConfirm(false);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      (document.activeElement === confirmNoBtn ? confirmYesBtn : confirmNoBtn).focus();
    } else if (e.key === 'Enter') {
      // Let the focused button handle it; just keep it from reaching the rest.
      e.stopPropagation();
    }
  }, true);

  /* ─── Import / Export Rules ──────────────────────────────── */
  const BACKUP_FORMAT = 'PageEraser-rules';
  const BACKUP_VERSION = 1;
  const SELECTOR_KEY_PREFIX = 'pe_selectors_';

  async function exportRules() {
    try {
      const all = await storage.get(null);
      const rules = {};
      let ruleCount = 0;

      Object.keys(all).forEach(key => {
        if (!key.startsWith(SELECTOR_KEY_PREFIX)) return;
        const normalized = PE_normalizeRules(all[key]);
        if (normalized.length === 0) return;
        rules[key.slice(SELECTOR_KEY_PREFIX.length)] = normalized;
        ruleCount += normalized.length;
      });

      if (ruleCount === 0) {
        RetroAudio.playError();
        showAlert('exportFailedTitle', 'exportEmptyMsg', '⚠️');
        return;
      }

      const backup = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        rules
      };

      const blob = new Blob([JSON.stringify(backup, null, 2)], {
        type: 'application/json'
      });
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 10);
      const link = document.createElement('a');
      link.href = url;
      link.download = `pageeraser-rules-${stamp}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Give the download a tick to start before the blob is released.
      setTimeout(() => URL.revokeObjectURL(url), 10000);

      RetroAudio.playSelection();
      showAlert('exportSuccessTitle', 'exportSuccessMsg', '💾');
    } catch (err) {
      console.error('[PageEraser] Export failed:', err);
      RetroAudio.playError();
      showAlert('exportFailedTitle', 'exportFailedMsg', '❌');
    }
  }

  function parseBackup(text) {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.format !== BACKUP_FORMAT) return null;
    if (!parsed.rules || typeof parsed.rules !== 'object') return null;

    const clean = {};
    let ruleCount = 0;
    let rawCount = 0;

    // Counted before any rule is checked: validating 100 000 selectors is what
    // used to freeze the popup.
    const domains = Object.keys(parsed.rules);
    if (domains.length > PE_BACKUP_MAX_RULES_TOTAL) return null;
    for (const domain of domains) {
      const list = parsed.rules[domain];
      if (Array.isArray(list)) {
        if (list.length > PE_BACKUP_MAX_RULES_PER_SITE) return null;
        rawCount += list.length;
        if (rawCount > PE_BACKUP_MAX_RULES_TOTAL) return null;
      }
    }

    domains.forEach(domain => {
      // Domains become storage keys and scope which sites a rule touches, so
      // only accept something that actually looks like a hostname.
      if (typeof domain !== 'string' || domain.length > 253) return;
      if (!/^[a-z0-9.-]+$/i.test(domain)) return;

      const normalized = PE_normalizeRules(parsed.rules[domain]);
      if (normalized.length === 0) return;
      clean[domain] = normalized;
      ruleCount += normalized.length;
    });

    return ruleCount > 0 ? clean : null;
  }

  async function importRules(file) {
    try {
      // Refused by size before the file is even read into memory.
      if (!file || file.size > PE_BACKUP_MAX_BYTES) {
        RetroAudio.playError();
        showAlert('importFailedTitle', 'importFailedMsg', '❌');
        return;
      }
      const text = await file.text();
      const incoming = parseBackup(text);

      if (!incoming) {
        RetroAudio.playError();
        showAlert('importFailedTitle', 'importFailedMsg', '❌');
        return;
      }

      // Merge rather than replace: an import should never silently wipe rules
      // for sites the backup does not mention.
      const domains = Object.keys(incoming);
      const keys = domains.map(d => SELECTOR_KEY_PREFIX + d);
      const existing = await storage.get(keys);

      const toSave = {};
      let added = 0;

      domains.forEach(domain => {
        const key = SELECTOR_KEY_PREFIX + domain;
        const current = PE_normalizeRules(existing[key] || []);
        const merged = PE_normalizeRules([...current, ...incoming[domain]]);
        added += merged.length - current.length;
        toSave[key] = merged;
      });

      await storage.set(toSave);
      await sendMessageToTab({ type: 'REFRESH_RULES', silent: true });
      await refreshSelectorsList();

      RetroAudio.playSelection();
      showAlert('importSuccessTitle', 'importSuccessMsg', '✔️');
      console.log(`[PageEraser] Imported ${added} new rule(s) across ${domains.length} domain(s).`);
    } catch (err) {
      console.error('[PageEraser] Import failed:', err);
      RetroAudio.playError();
      showAlert('importFailedTitle', 'importFailedMsg', '❌');
    }
  }

  /* ─── Share rules as a code / Import from a code ──────────── */
  // "{n} rules for {site}" -> text. Used on locale strings only.
  function fill(template, values) {
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match));
  }

  /* navigator.clipboard where the browser lets the popup use it, otherwise a
   * throwaway <textarea> and execCommand('copy'). Resolves true when copied. */
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) {
      // Fall through to the textarea route.
    }
    try {
      const box = document.createElement('textarea');
      box.value = text;
      box.setAttribute('readonly', '');
      box.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(box);
      box.select();
      const copied = document.execCommand('copy');
      box.remove();
      return copied;
    } catch (err) {
      return false;
    }
  }

  async function copyRulesAsCode() {
    const fail = (messageKey, titleKey = 'codeCopyFailedTitle') => {
      RetroAudio.playError();
      showAlert(titleKey, messageKey, '⚠️');
    };
    if (!currentDomain) return fail('codeNoSiteMsg');
    const key = `pe_selectors_${currentDomain}`;
    const data = await storage.get(key);
    const rules = PE_normalizeRules(data[key] || []);
    if (rules.length === 0) return fail('codeNothingMsg');
    const code = PE_buildShare(currentDomain, rules);
    if (!code) return fail('codeTooBigMsg');
    if (await copyText(code)) {
      RetroAudio.playSelection();
      showAlert('codeCopiedTitle', 'codeCopiedMsg', '📋');
    } else {
      fail('codeCopyFailedMsg');
    }
  }

  const codeOverlay = document.getElementById('code-overlay');
  const codeInput = document.getElementById('code-input');
  const codePreview = document.getElementById('code-preview');
  const codeAddBtn = document.getElementById('btn-add-code');
  const codeCancelBtn = document.getElementById('btn-cancel-code');
  const codeCloseBtn = document.getElementById('btn-close-code');
  const CODE_PREVIEW_ROWS = 5;
  // Why PE_parseShare said no -> the sentence that explains it.
  const CODE_ERRORS = {
    empty: 'codeHint',
    size: 'codeErrSize',
    format: 'codeErrFormat',
    version: 'codeErrVersion',
    decode: 'codeErrDecode',
    domain: 'codeErrDomain',
    'too-many': 'codeErrTooMany',
    rules: 'codeErrRules'
  };
  let codeParsed = null;
  let codePreviousFocus = null;

  function isCodeOpen() {
    return codeOverlay.style.display === 'flex';
  }

  function openCodeDialog() {
    codeInput.value = '';
    renderCodePreview();
    codePreviousFocus = document.activeElement;
    codeOverlay.style.display = 'flex';
    codeInput.focus();
  }

  function closeCodeDialog() {
    codeOverlay.style.display = 'none';
    codeInput.value = '';
    codeParsed = null;
    if (codePreviousFocus && codePreviousFocus.focus) codePreviousFocus.focus();
    codePreviousFocus = null;
  }

  /* What the pasted code holds, before anything is added. Everything that comes
   * from the code is put in with textContent: it is someone else's text. */
  function renderCodePreview() {
    const t = LOCALES[currentLang];
    const addLine = (className, text, title) => {
      const line = document.createElement('div');
      line.className = className;
      line.textContent = text;
      if (title) line.title = title;
      codePreview.appendChild(line);
    };
    codePreview.textContent = '';
    codeParsed = null;
    codeAddBtn.disabled = true;

    if (!codeInput.value.trim()) {
      addLine('code-hint', t.codeHint);
      return;
    }
    const result = PE_parseShare(codeInput.value);
    if (!result.ok) {
      addLine('code-error', t[CODE_ERRORS[result.reason]] || t.codeErrDecode);
      return;
    }
    codeParsed = result;
    addLine('code-summary', result.rules.length === 1
      ? fill(t.codeSummaryOne, { site: result.domain })
      : fill(t.codeSummary, { n: result.rules.length, site: result.domain }));
    result.rules.slice(0, CODE_PREVIEW_ROWS).forEach((rule) => {
      addLine(`selector-text text-${rule.action}`, `${rule.action === 'stretch' ? '↔' : '✕'} ${rule.selector}`, rule.selector);
    });
    if (result.rules.length > CODE_PREVIEW_ROWS) {
      addLine('code-more', fill(t.codeMore, { n: result.rules.length - CODE_PREVIEW_ROWS }));
    }
    if (result.skipped > 0) addLine('code-skipped', fill(t.codeSkipped, { n: result.skipped }));
    codeAddBtn.disabled = false;
  }

  /* Merges the rules into the site's list. Rules you already have stay yours;
   * the new ones are marked imported. */
  async function addSharedRules() {
    if (!codeParsed) return;
    const { domain, rules } = codeParsed;
    codeAddBtn.disabled = true;
    try {
      // The same scope rule as everywhere else: with "all subdomains" on, a rule
      // for www.example.com is kept under example.com.
      const site = await getDomainToUse(domain);
      const key = SELECTOR_KEY_PREFIX + site;
      const data = await storage.get(key);
      const current = PE_normalizeRules(data[key] || []);
      const merged = PE_normalizeRules([...current, ...rules]);
      const added = merged.length - current.length;
      await storage.set({ [key]: merged });
      closeCodeDialog();
      await sendMessageToTab({ type: 'REFRESH_RULES', silent: true });
      await refreshSelectorsList();

      const t = LOCALES[currentLang];
      let message = added === 0
        ? fill(t.codeAddedNone, { site })
        : (added === 1 ? fill(t.codeAddedMsgOne, { site }) : fill(t.codeAddedMsg, { n: added, site }));
      if (added > 0 && site !== currentDomain) message += ' ' + fill(t.codeAddedElsewhere, { site });
      RetroAudio.playSelection();
      showAlert('codeAddedTitle', message, '✔️');
    } catch (err) {
      console.error('[PageEraser] Adding shared rules failed:', err);
      closeCodeDialog();
      RetroAudio.playError();
      showAlert('importFailedTitle', 'codeAddFailedMsg', '❌');
    }
  }

  codeInput.addEventListener('input', renderCodePreview);
  codeAddBtn.addEventListener('click', addSharedRules);
  codeCancelBtn.addEventListener('click', closeCodeDialog);
  codeCloseBtn.addEventListener('click', closeCodeDialog);
  document.getElementById('menu-item-copycode').addEventListener('click', copyRulesAsCode);
  document.getElementById('menu-item-importcode').addEventListener('click', openCodeDialog);

  // Same keyboard rules as the other dialogs: Esc closes, Tab stays inside.
  document.addEventListener('keydown', (e) => {
    if (!isCodeOpen() || isAlertOpen() || isConfirmOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeCodeDialog();
    } else if (e.key === 'Tab') {
      const stops = [codeInput, codeAddBtn, codeCancelBtn, codeCloseBtn].filter((el) => !el.disabled);
      const at = stops.indexOf(document.activeElement);
      const next = e.shiftKey ? stops[(at <= 0 ? stops.length : at) - 1] : stops[(at + 1) % stops.length];
      e.preventDefault();
      next.focus();
    }
  }, true);

  const importFileInput = document.getElementById('import-file-input');

  document.getElementById('menu-item-export').addEventListener('click', () => {
    closeAllDropdowns();
    exportRules();
  });

  document.getElementById('menu-item-import').addEventListener('click', () => {
    closeAllDropdowns();
    importFileInput.click();
  });

  importFileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    // Reset first so picking the same file twice still fires a change event.
    e.target.value = '';
    if (file) await importRules(file);
  });

  // Dropdown Action Bindings
  document.getElementById('menu-item-exit').addEventListener('click', () => {
    window.close();
  });

  document.getElementById('menu-item-select').addEventListener('click', async () => {
    RetroAudio.playSelection();
    await launchOnTab({ type: 'START_SELECTION', silent: true });
  });

  document.getElementById('menu-item-reset').addEventListener('click', async (e) => {
    if (btnReset.disabled) {
      RetroAudio.playError();
      return;
    }
    RetroAudio.playReset();
    await sendMessageToTab({ type: 'RESET_SITE', selectors: allSelectors, silent: true });
    if (currentDomain) {
      const key = `pe_selectors_${currentDomain}`;
      await storage.remove(key);
    }
    setTimeout(async () => {
      await refreshSelectorsList();
    }, 100);
  });

  document.getElementById('menu-item-sounds').addEventListener('click', async (e) => {
    e.stopPropagation();
    const item = document.getElementById('menu-item-sounds');
    const currentlyChecked = item.classList.contains('checked');
    
    if (currentlyChecked) {
      item.classList.remove('checked');
      await storage.set({ pe_sounds: false });
    } else {
      item.classList.add('checked');
      await storage.set({ pe_sounds: true });
      RetroAudio.playSelection();
    }
  });

  document.getElementById('menu-item-clippy-toggle').addEventListener('click', async (e) => {
    e.stopPropagation();
    const item = document.getElementById('menu-item-clippy-toggle');
    const currentlyChecked = item.classList.contains('checked');
    const newValue = !currentlyChecked;
    
    if (newValue) {
      item.classList.add('checked');
    } else {
      item.classList.remove('checked');
    }
    await storage.set({ pe_clippy_enabled: newValue });
    ClippyAssistant.setEnabled(newValue);
    RetroAudio.playSelection();
  });

  document.getElementById('menu-item-scope').addEventListener('click', async (e) => {
    e.stopPropagation();
    const item = document.getElementById('menu-item-scope');
    const currentlyChecked = item.classList.contains('checked');
    const newValue = !currentlyChecked;
    
    if (newValue) {
      item.classList.add('checked');
    } else {
      item.classList.remove('checked');
    }
    await storage.set({ pe_all_subdomains: newValue });
    RetroAudio.playSelection();

    // Refresh layout domains and rules list
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      await handleActiveTabChange(tab);
      await sendMessageToTab({ type: 'REFRESH_RULES', silent: true });
    }
  });

  document.getElementById('menu-item-about').addEventListener('click', () => {
    RetroAudio.playSelection();
    aboutDrag.reset();
    aboutOverlay.style.display = 'flex';
    closeAllDropdowns();
  });

  document.getElementById('menu-item-clippy-trigger').addEventListener('click', () => {
    ClippyAssistant.triggerMenuInteraction();
    closeAllDropdowns();
  });

  // About Modal buttons
  const hideAbout = () => {
    aboutOverlay.style.display = 'none';
  };
  btnCloseAbout.addEventListener('click', hideAbout);
  btnOkAbout.addEventListener('click', hideAbout);

  // ─── Options Theme Management ──────────────────────────────
  async function selectTheme(theme) {
    const windowEl = document.querySelector('.window');
    windowEl.classList.remove('theme-teal', 'theme-blue', 'theme-plum');
    
    const modals = document.querySelectorAll('.win-modal');
    modals.forEach(m => m.classList.remove('theme-teal', 'theme-blue', 'theme-plum'));

    if (theme !== 'teal') {
      windowEl.classList.add('theme-' + theme);
      modals.forEach(m => m.classList.add('theme-' + theme));
    }
    
    // Update theme checkmark in menu
    ['teal', 'blue', 'plum'].forEach(t => {
      const el = document.getElementById('menu-item-theme-' + t);
      if (el) {
        if (t === theme) {
          el.classList.add('checked');
        } else {
          el.classList.remove('checked');
        }
      }
    });

    await storage.set({ pe_theme: theme });
  }

  document.getElementById('menu-item-theme-teal').addEventListener('click', (e) => {
    e.stopPropagation();
    selectTheme('teal');
  });

  document.getElementById('menu-item-theme-blue').addEventListener('click', (e) => {
    e.stopPropagation();
    selectTheme('blue');
  });

  document.getElementById('menu-item-theme-plum').addEventListener('click', (e) => {
    e.stopPropagation();
    selectTheme('plum');
  });

  // ─── Accessibility Option Selectors ─────────────────────────
  async function selectContrast(highContrast, playFeedback = true) {
    const windowEl = document.querySelector('.window');
    const modals = document.querySelectorAll('.win-modal');
    const contrastItem = document.getElementById('menu-item-contrast-high');

    if (highContrast) {
      windowEl.classList.add('theme-high-contrast');
      modals.forEach(m => m.classList.add('theme-high-contrast'));
      contrastItem.classList.add('checked');
    } else {
      windowEl.classList.remove('theme-high-contrast');
      modals.forEach(m => m.classList.remove('theme-high-contrast'));
      contrastItem.classList.remove('checked');
    }

    await storage.set({ pe_contrast: highContrast });

    if (playFeedback) {
      RetroAudio.playSelection();
    }
  }

  async function selectTextScale(largeText, playFeedback = true) {
    const textItem = document.getElementById('menu-item-text-large');

    if (largeText) {
      document.body.classList.add('text-large');
      textItem.classList.add('checked');
    } else {
      document.body.classList.remove('text-large');
      textItem.classList.remove('checked');
    }

    await storage.set({ pe_text_scale: largeText });

    if (playFeedback) {
      RetroAudio.playSelection();
    }
  }

  document.getElementById('menu-item-contrast-high').addEventListener('click', (e) => {
    e.stopPropagation();
    const isChecked = document.getElementById('menu-item-contrast-high').classList.contains('checked');
    selectContrast(!isChecked);
  });

  document.getElementById('menu-item-text-large').addEventListener('click', (e) => {
    e.stopPropagation();
    const isChecked = document.getElementById('menu-item-text-large').classList.contains('checked');
    selectTextScale(!isChecked);
  });

  // ─── Dynamic UI Translation Update ──────────────────────────
  function updateUI() {
    // Translate all standard text/HTML content
    const elements = document.querySelectorAll('[data-i18n]');
    elements.forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (LOCALES[currentLang] && LOCALES[currentLang][key] !== undefined) {
        // {version} is filled from the manifest so the About box can never
        // drift out of sync with the released version again.
        el.innerHTML = LOCALES[currentLang][key]
          .replace('{version}', chrome.runtime.getManifest().version);
      }
    });

    // Translate placeholder attributes
    const inputs = document.querySelectorAll('[data-i18n-placeholder]');
    inputs.forEach(input => {
      const key = input.getAttribute('data-i18n-placeholder');
      if (LOCALES[currentLang] && LOCALES[currentLang][key] !== undefined) {
        input.placeholder = LOCALES[currentLang][key];
      }
    });

    // A minimised window shows its title with a suffix: keep it in the new language.
    const windowForTitle = document.querySelector('.window');
    const mainTitle = document.querySelector('.window > .title-bar .title-bar-text');
    if (windowForTitle && mainTitle && windowForTitle.classList.contains('minimized') &&
        LOCALES[currentLang] && LOCALES[currentLang].minimizedTitle) {
      mainTitle.textContent = LOCALES[currentLang].minimizedTitle;
    }

    // Translate aria-label and title attributes
    document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
      const key = el.getAttribute('data-i18n-aria-label');
      if (LOCALES[currentLang] && LOCALES[currentLang][key] !== undefined) {
        el.setAttribute('aria-label', LOCALES[currentLang][key]);
      }
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      if (LOCALES[currentLang] && LOCALES[currentLang][key] !== undefined) {
        el.title = LOCALES[currentLang][key];
      }
    });

    // Update active lang checkmarks in the options menu
    ['en', 'tr'].forEach(lang => {
      const el = document.getElementById('menu-item-lang-' + lang);
      if (el) {
        if (lang === currentLang) {
          el.classList.add('checked');
        } else {
          el.classList.remove('checked');
        }
      }
    });
  }

  // ─── Localization Manager ───────────────────────────────────
  async function selectLanguage(lang, playFeedback = true) {
    currentLang = lang;
    await storage.set({ pe_lang: lang });
    
    updateUI();
    await refreshSelectorsList();

    if (playFeedback) {
      RetroAudio.playSelection();
    }
  }

  document.getElementById('menu-item-lang-en').addEventListener('click', (e) => {
    e.stopPropagation();
    selectLanguage('en');
  });

  document.getElementById('menu-item-lang-tr').addEventListener('click', (e) => {
    e.stopPropagation();
    selectLanguage('tr');
  });

  // ─── Onboarding Tour Triggers ──────────────────────────────
  document.getElementById('menu-item-tour').addEventListener('click', () => {
    RetroAudio.playSelection();
    SpotlightTour.start();
    closeAllDropdowns();
  });

  // ─── Live Status Clock ────────────────────────────────────
  function startClock() {
    const clockEl = document.getElementById('status-clock');
    if (!clockEl) return;
    
    function updateClock() {
      const now = new Date();
      let hours = now.getHours();
      let minutes = now.getMinutes();
      hours = hours < 10 ? '0' + hours : hours;
      minutes = minutes < 10 ? '0' + minutes : minutes;
      clockEl.textContent = `${hours}:${minutes}`;
    }
    
    updateClock();
    setInterval(updateClock, 1000);
  }

  /* ─── Main Action Elements ───────────────────────────────── */
  btnSelect.addEventListener('click', async () => {
    RetroAudio.playSelection();
    await launchOnTab({ type: 'START_SELECTION', silent: true });
  });

  btnReset.addEventListener('click', async () => {
    RetroAudio.playReset();
    await sendMessageToTab({ type: 'RESET_SITE', selectors: allSelectors, silent: true });
    if (currentDomain) {
      const key = `pe_selectors_${currentDomain}`;
      await storage.remove(key);
    }
    await refreshSelectorsList();
  });

  filterInput.addEventListener('input', () => {
    applyFilter();
  });

  // ─── Clippy Hover Guidance Bindings ───────────────────────
  btnSelect.addEventListener('mouseenter', () => ClippyAssistant.handleHover('selectBtn'));
  btnReset.addEventListener('mouseenter', () => ClippyAssistant.handleHover('resetBtn'));
  filterInput.addEventListener('mouseenter', () => ClippyAssistant.handleHover('filterInput'));

  const chkPersist = document.getElementById('chk-persist');
  if (chkPersist) {
    chkPersist.addEventListener('mouseenter', () => ClippyAssistant.handleHover('persistChk'));
  }

  const soundItem = document.getElementById('menu-item-sounds');
  if (soundItem) {
    soundItem.addEventListener('mouseenter', () => ClippyAssistant.handleHover('menuSounds'));
  }

  const scopeItem = document.getElementById('menu-item-scope');
  if (scopeItem) {
    scopeItem.addEventListener('mouseenter', () => ClippyAssistant.handleHover('menuScope'));
  }

  const aboutItem = document.getElementById('menu-item-about');
  if (aboutItem) {
    aboutItem.addEventListener('mouseenter', () => ClippyAssistant.handleHover('menuAbout'));
  }

  const tourItem = document.getElementById('menu-item-tour');
  if (tourItem) {
    tourItem.addEventListener('mouseenter', () => ClippyAssistant.handleHover('menuTour'));
  }

  // ─── Title Bar Button Actions (Win95 Authentic) ─────────
  const windowEl = document.querySelector('.window');
  const titleBar = document.querySelector('.title-bar');
  const titleText = document.querySelector('.title-bar-text');

  // Close button — shutdown jingle + close
  windowEl.querySelector('.title-bar .close-btn').addEventListener('click', () => {
    RetroAudio.playShutdown();
    setTimeout(() => window.close(), 700);
  });

  // Minimize button — collapse window body (in-place minimize)
  let isMinimized = false;
  windowEl.querySelector('.title-bar .minimize-btn').addEventListener('click', () => {
    isMinimized = !isMinimized;
    RetroAudio.playMinimize();

    if (isMinimized) {
      windowEl.classList.add('minimized');
      titleText.textContent = LOCALES[currentLang].minimizedTitle;
    } else {
      windowEl.classList.remove('minimized');
      titleText.textContent = 'PageEraser.exe';
    }
  });

  // Double-click title bar to toggle minimize (classic Win95)
  titleBar.addEventListener('dblclick', (e) => {
    if (e.target.closest('.title-bar-controls')) return;
    isMinimized = !isMinimized;
    RetroAudio.playMinimize();

    if (isMinimized) {
      windowEl.classList.add('minimized');
      titleText.textContent = LOCALES[currentLang].minimizedTitle;
    } else {
      windowEl.classList.remove('minimized');
      titleText.textContent = 'PageEraser.exe';
    }
  });

  // Maximize button — fun wobble shake + Clippy joke
  windowEl.querySelector('.title-bar .maximize-btn').addEventListener('click', () => {
    RetroAudio.playMaximizeDeny();

    // Wobble animation
    windowEl.classList.remove('wobble');
    // Force reflow to restart animation
    void windowEl.offsetWidth;
    windowEl.classList.add('wobble');
    windowEl.addEventListener('animationend', () => {
      windowEl.classList.remove('wobble');
    }, { once: true });

    // Clippy reacts
    ClippyAssistant.handleHover('maximizeDeny');
  });

  // ─── Layout X-Ray ──────────────────────────────────────────
  // Starting it from here (toolbar button) is what grants the extension
  // activeTab on this page, which the overlay's Capture button relies on.
  async function toggleXray() {
    RetroAudio.playSelection();
    await launchOnTab({ type: 'TOGGLE_XRAY' });
  }
  btnXray.addEventListener('click', toggleXray);
  document.getElementById('menu-item-xray').addEventListener('click', toggleXray);

  // ─── Extract to Code ───────────────────────────────────────
  async function toggleExtract() {
    RetroAudio.playSelection();
    await launchOnTab({ type: 'TOGGLE_EXTRACT' });
  }
  btnExtract.addEventListener('click', toggleExtract);
  document.getElementById('menu-item-extract').addEventListener('click', toggleExtract);

  // ─── Visual Diff ───────────────────────────────────────────
  // Started from here (toolbar button), the extension holds activeTab for this
  // page, which the Compare button needs to capture it.
  async function toggleDiff() {
    RetroAudio.playSelection();
    await launchOnTab({ type: 'TOGGLE_DIFF' });
  }
  btnDiff.addEventListener('click', toggleDiff);
  document.getElementById('menu-item-diff').addEventListener('click', toggleDiff);

  // ─── Paint Webpage Actions Menu Trigger ────────────────────
  const paintBtn = document.getElementById('menu-item-paint');
  if (paintBtn) {
    paintBtn.addEventListener('click', async () => {
      RetroAudio.playSelection();
      await launchOnTab({ type: 'START_PAINT' });
    });
  }

  // ─── Soundboard Event Listeners ───────────────────────────
  const soundboardBtn = document.getElementById('menu-item-soundboard');
  const overlaySoundboard = document.getElementById('overlay-soundboard');
  const btnCloseSoundboard = document.getElementById('btn-close-soundboard');
  const btnOkSoundboard = document.getElementById('btn-ok-soundboard');
  const btnPlaySoundboard = document.getElementById('btn-play-soundboard');
  const soundItems = document.querySelectorAll('.sound-event-item');

  if (soundboardBtn) {
    soundboardBtn.addEventListener('click', () => {
      RetroAudio.playSelection();
      overlaySoundboard.style.display = 'flex';
      closeAllDropdowns();
    });
  }

  const hideSoundboard = () => {
    overlaySoundboard.style.display = 'none';
    RetroAudio.playSelection();
  };

  if (btnCloseSoundboard) btnCloseSoundboard.addEventListener('click', hideSoundboard);
  if (btnOkSoundboard) btnOkSoundboard.addEventListener('click', hideSoundboard);
  makeDialogKeyboardFriendly(overlaySoundboard, btnCloseSoundboard);

  soundItems.forEach(item => {
    item.addEventListener('click', () => {
      soundItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      RetroAudio.playMinesweeperClick();
    });
  });

  if (btnPlaySoundboard) {
    btnPlaySoundboard.addEventListener('click', () => {
      const activeItem = document.querySelector('.sound-event-item.active');
      if (!activeItem) return;
      const soundType = activeItem.getAttribute('data-sound');
      switch (soundType) {
        case 'startup':
          RetroAudio.playStartup();
          break;
        case 'shutdown':
          RetroAudio.playShutdown();
          break;
        case 'chord':
          RetroAudio.playChord();
          break;
        case 'error':
          RetroAudio.playErrorTone();
          break;
        case 'selection':
          RetroAudio.playSelection();
          break;
        case 'chomp':
          RetroAudio.playChomp();
          break;
        case 'trash':
          RetroAudio.playTrash();
          break;
        case 'swish':
          RetroAudio.playSwish();
          break;
      }
    });
  }

  // ─── BSOD (Blue Screen of Death) Simulator ────────────────
  const bsodOverlay = document.getElementById('bsod-overlay');
  
  const triggerBSOD = () => {
    RetroAudio.playChord();
    bsodOverlay.style.display = 'block';
  };

  const closeBSOD = () => {
    bsodOverlay.style.display = 'none';
    RetroAudio.playSelection();
  };

  // Trigger BSOD on Ctrl+Shift+B
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      triggerBSOD();
    }
  });

  // Handle BSOD keys
  bsodOverlay.addEventListener('click', closeBSOD);
  document.addEventListener('keydown', async (e) => {
    if (bsodOverlay.style.display === 'block') {
      e.preventDefault();
      if (e.key === 'Enter') {
        // Reset site layout
        await sendMessageToTab({ type: 'RESET_SITE', selectors: allSelectors, silent: true });
        if (currentDomain) {
          const key = `pe_selectors_${currentDomain}`;
          await storage.remove(key);
        }
        await refreshSelectorsList();
        bsodOverlay.style.display = 'none';
        RetroAudio.playReset();
      } else if (e.key === 'Escape') {
        closeBSOD();
      } else {
        closeBSOD();
      }
    }
  });

  // Double click About version to trigger BSOD
  const aboutVerEl = document.querySelector('.about-version');
  if (aboutVerEl) {
    aboutVerEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      triggerBSOD();
    });
  }

  // ─── Recycle Bin Drag & Drop Listeners ────────────────────
  const recycleBin = document.getElementById('recycle-bin-container');

  if (recycleBin) {
    recycleBin.addEventListener('dragover', (e) => {
      e.preventDefault();
      recycleBin.classList.add('drag-over');
    });

    recycleBin.addEventListener('dragleave', () => {
      recycleBin.classList.remove('drag-over');
    });

    recycleBin.addEventListener('drop', async (e) => {
      e.preventDefault();
      recycleBin.classList.remove('drag-over');
      
      const selectorStr = e.dataTransfer.getData('text/plain');
      if (!selectorStr) return;

      // Play trash crumpling audio
      RetroAudio.playTrash();

      // Update storage and notify tab
      const key = `pe_selectors_${currentDomain}`;
      const data = await storage.get(key);
      let selectors = data[key] || [];
      selectors = selectors.filter(item => {
        const sel = typeof item === 'string' ? item : item.selector;
        return sel !== selectorStr;
      });
      await storage.set({ [key]: selectors });

      await sendMessageToTab({ type: 'RESTORE_SELECTOR', selector: selectorStr, silent: true });
      // The refresh also redraws the bin: empty once the last item is gone.
      await refreshSelectorsList();
    });

    // Double-click Recycle Bin to Empty/Reset
    recycleBin.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (btnReset && !btnReset.disabled) {
        btnReset.click();
      }
    });
  }

  // Run initial loading
  init();
})();

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
  const btnReset      = document.getElementById('btn-reset');
  const domainNameEl  = document.getElementById('domain-name');
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
  function getBaseDomain(hostname) {
    if (!hostname) return '';
    const parts = hostname.split('.');
    if (parts.length > 2) {
      const secondLast = parts[parts.length - 2];
      if (['com', 'co', 'net', 'org', 'gov', 'edu'].includes(secondLast) && parts.length > 3) {
        return parts.slice(-3).join('.');
      }
      return parts.slice(-2).join('.');
    }
    return hostname;
  }

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
      console.error('[PageEraser] Popup init error:', err);
    }
  }

  /* ─── Active Tab Change Handler (Live Sync for Side Panel) ─── */
  async function handleActiveTabChange(tab) {
    if (!tab) return;
    activeTabId = tab.id;

    if (tab.url) {
      const urlObj = new URL(tab.url);
      if (urlObj.protocol.startsWith('http')) {
        const domainToUse = await getDomainToUse(urlObj.hostname);
        currentDomain = domainToUse;
        domainNameEl.textContent = currentDomain;
        btnSelect.disabled = false;
        await refreshSelectorsList();
      } else {
        currentDomain = '';
        domainNameEl.textContent = LOCALES[currentLang].cannotRun;
        btnSelect.disabled = true;
        btnReset.disabled = true;
        selectorsList.innerHTML = `<div class="empty-state">${LOCALES[currentLang].noElements}</div>`;
        hiddenCountEl.textContent = '0';
      }
    }
  }

  /* ─── Messaging Helper ───────────────────────────────────── */
  async function sendMessageToTab(message) {
    if (!activeTabId) return null;
    try {
      return await chrome.tabs.sendMessage(activeTabId, message);
    } catch (err) {
      console.warn('[PageEraser] Could not communicate with tab:', err);
      return null;
    }
  }

  /* ─── UI Refresh & Filtering ─────────────────────────────── */
  async function refreshSelectorsList() {
    if (!currentDomain) return;

    try {
      const key = `pe_selectors_${currentDomain}`;
      const data = await storage.get(key);
      allSelectors = data[key] || [];

      // Update badge count
      hiddenCountEl.textContent = allSelectors.length;

      // Update reset button state
      btnReset.disabled = allSelectors.length === 0;

      applyFilter();
    } catch (err) {
      console.error('[PageEraser] Error listing selectors:', err);
    }
  }

  function applyFilter() {
    selectorsList.innerHTML = '';
    const query = filterInput.value.toLowerCase().trim();
    
    const filtered = allSelectors.filter(itemData => {
      const selector = typeof itemData === 'string' ? itemData : itemData.selector;
      return selector.toLowerCase().includes(query);
    });

    if (filtered.length === 0) {
      const msg = allSelectors.length === 0 ? LOCALES[currentLang].noElements : LOCALES[currentLang].noMatches;
      selectorsList.innerHTML = `<div class="empty-state">${msg}</div>`;
      return;
    }

    filtered.forEach((itemData) => {
      const isString = typeof itemData === 'string';
      const selectorStr = isString ? itemData : itemData.selector;
      const action = isString ? 'hide' : itemData.action;

      const item = document.createElement('div');
      item.className = 'selector-item';
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
          if (!newSelector) {
            RetroAudio.playError();
            return;
          }

          RetroAudio.playSelection();

          // 1. Tell tab to restore old selector (clears inline styles and removes from storage)
          await sendMessageToTab({ type: 'RESTORE_SELECTOR', selector: selectorStr, silent: true });

          // 2. Fetch the updated list from storage (which now has the old selector removed)
          const key = `pe_selectors_${currentDomain}`;
          const data = await storage.get(key);
          let selectors = data[key] || [];

          // 3. Add the new selector rule
          if (isString) {
            selectors.push(newSelector);
          } else {
            selectors.push({ selector: newSelector, action: action });
          }
          await storage.set({ [key]: selectors });

          // 4. Tell tab to load and apply the new rules
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

      controlsContainer.appendChild(editBtn);
      controlsContainer.appendChild(restoreBtn);

      item.appendChild(actionBadge);
      item.appendChild(text);
      item.appendChild(controlsContainer);
      selectorsList.appendChild(item);
    });
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
      }
    });
  });

  function closeAllDropdowns() {
    dropdownMenus.forEach(d => d.classList.remove('visible'));
    menuItems.forEach(m => m.classList.remove('active'));
  }

  document.addEventListener('click', () => {
    closeAllDropdowns();
  });

  // Dropdown Action Bindings
  document.getElementById('menu-item-exit').addEventListener('click', () => {
    window.close();
  });

  document.getElementById('menu-item-select').addEventListener('click', async () => {
    RetroAudio.playSelection();
    await sendMessageToTab({ type: 'START_SELECTION', silent: true });
    window.close();
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
        el.innerHTML = LOCALES[currentLang][key];
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
    await sendMessageToTab({ type: 'START_SELECTION', silent: true });
    window.close();
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
      titleText.textContent = 'PageEraser.exe — [Minimized]';
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
      titleText.textContent = 'PageEraser.exe — [Minimized]';
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

  // ─── Paint Webpage Actions Menu Trigger ────────────────────
  const paintBtn = document.getElementById('menu-item-paint');
  if (paintBtn) {
    paintBtn.addEventListener('click', async () => {
      RetroAudio.playSelection();
      await sendMessageToTab({ type: 'START_PAINT' });
      window.close();
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
  const recycleBinIcon = document.getElementById('recycle-bin-icon');

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

      // Show full recycle bin icon state
      recycleBinIcon.classList.remove('empty');
      recycleBinIcon.classList.add('full');

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
      await refreshSelectorsList();

      // Revert bin icon back to empty after a delay
      setTimeout(() => {
        recycleBinIcon.classList.remove('full');
        recycleBinIcon.classList.add('empty');
      }, 1500);
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

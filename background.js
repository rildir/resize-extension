/**
 * PageEraser Chrome Extension — Background Service Worker
 *
 * Handles background operations:
 *  - Listens for global keyboard command shortcuts
 *  - Registers and handles right-click context menu options
 *  - Manages extension icon badge counter per tab
 *
 * @version 1.6.0
 */

// LOCALES / currentLang are shared with the popup so context-menu titles stay
// in sync with the language the user picked in Options.
importScripts('locales.js');

const MENU_ERASE = 'pe-erase';
const MENU_STRETCH = 'pe-stretch';

// ─── Badge State (per-tab) ────────────────────────────────
// MV3 service workers are torn down after ~30s idle, so an in-memory Map loses
// every count. storage.session survives the teardown and is cleared on browser
// exit, which is exactly the lifetime a badge count should have.
const BADGE_KEY = 'pe_badge_counts';

async function readBadgeCounts() {
  try {
    const data = await chrome.storage.session.get(BADGE_KEY);
    return data[BADGE_KEY] || {};
  } catch (err) {
    return {};
  }
}

async function writeBadgeCount(tabId, count) {
  try {
    const counts = await readBadgeCounts();
    if (count > 0) {
      counts[tabId] = count;
    } else {
      delete counts[tabId];
    }
    await chrome.storage.session.set({ [BADGE_KEY]: counts });
  } catch (err) {
    console.error('[PageEraser] Badge state write error:', err);
  }
}

async function setBadge(tabId, count) {
  try {
    await chrome.action.setBadgeText({
      text: count > 0 ? String(count) : '',
      tabId
    });
  } catch (err) {
    // Tab may have been closed between read and write.
  }
}

// ─── Storage Migration (sync -> local) ──────────────────────
async function migrateSyncToLocal() {
  try {
    const syncData = await chrome.storage.sync.get(null);
    const keysToMigrate = Object.keys(syncData).filter(key => key.startsWith('pe_'));
    if (keysToMigrate.length > 0) {
      const dataToSave = {};
      keysToMigrate.forEach(k => {
        dataToSave[k] = syncData[k];
      });
      await chrome.storage.local.set(dataToSave);
      await chrome.storage.sync.clear();
      console.log('[PageEraser] Storage successfully migrated to local storage.');
    }
  } catch (err) {
    console.error('[PageEraser] Storage migration error:', err);
  }
}

// ─── Context Menu Setup ───────────────────────────────────
async function getLang() {
  try {
    const data = await chrome.storage.local.get('pe_lang');
    return LOCALES[data.pe_lang] ? data.pe_lang : 'en';
  } catch (err) {
    return 'en';
  }
}

async function setupContextMenus() {
  const lang = await getLang();
  const t = LOCALES[lang];

  // removeAll() first: onInstalled also fires on every extension update, and
  // create() with an already-registered id throws "duplicate id".
  await new Promise(resolve => chrome.contextMenus.removeAll(resolve));

  chrome.contextMenus.create({
    id: MENU_ERASE,
    title: t.ctxErase,
    contexts: ['all']
  });

  chrome.contextMenus.create({
    id: MENU_STRETCH,
    title: t.ctxStretch,
    contexts: ['all']
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await setupContextMenus();

  // Set default badge style
  chrome.action.setBadgeBackgroundColor({ color: '#008080' });

  // Run database migration
  await migrateSyncToLocal();
});

// Context menus are not persisted across browser restarts.
chrome.runtime.onStartup.addListener(async () => {
  await setupContextMenus();
  chrome.action.setBadgeBackgroundColor({ color: '#008080' });
});

// Re-label the menus when the user switches language in Options.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.pe_lang) {
    setupContextMenus();
  }
});

// ─── Shortcut Commands Listener ──────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;

    const messageTypes = {
      'start-selection': 'START_SELECTION',
      'reset-layout': 'RESET_SITE',
      'start-paint': 'START_PAINT'
    };

    const type = messageTypes[command];
    // No url check needed: the content script only exists on pages we are
    // allowed to run on, so sendMessage simply rejects everywhere else.
    if (type) {
      chrome.tabs.sendMessage(tab.id, { type }).catch(() => {});
    }
  } catch (err) {
    console.error('[PageEraser] Command listener error:', err);
  }
});

// ─── Context Menu Click Handler ───────────────────────────
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;

  try {
    if (info.menuItemId === MENU_ERASE) {
      chrome.tabs.sendMessage(tab.id, { type: 'CONTEXT_ERASE' }).catch(() => {});
    } else if (info.menuItemId === MENU_STRETCH) {
      chrome.tabs.sendMessage(tab.id, { type: 'CONTEXT_STRETCH' }).catch(() => {});
    }
  } catch (err) {
    console.error('[PageEraser] Context menu handler error:', err);
  }
});

// ─── Badge Counter Handler ────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'UPDATE_BADGE' && sender.tab) {
    const tabId = sender.tab.id;
    const count = msg.count || 0;

    setBadge(tabId, count);
    writeBadgeCount(tabId, count);
  }
});

// ─── Clear badge when tab is closed ───────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  writeBadgeCount(tabId, 0);
});

// ─── Refresh badge when switching tabs ────────────────────
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const counts = await readBadgeCounts();
  await setBadge(activeInfo.tabId, counts[activeInfo.tabId] || 0);
});

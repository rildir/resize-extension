/**
 * PageEraser Chrome Extension — Background Service Worker
 *
 * Handles background operations:
 *  - Listens for global keyboard command shortcuts
 *  - Registers and handles right-click context menu options
 *  - Manages extension icon badge counter per tab
 *
 * @version 1.5.0
 */

// ─── Badge State (per-tab) ────────────────────────────────
const tabBadgeCounts = new Map();

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

// ─── Context Menu Setup on Install ────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.create({
    id: "pe-erase",
    title: "PageEraser: Erase Element",
    contexts: ["all"]
  });

  chrome.contextMenus.create({
    id: "pe-stretch",
    title: "PageEraser: Stretch Element (Max Width)",
    contexts: ["all"]
  });

  // Set default badge style
  chrome.action.setBadgeBackgroundColor({ color: '#008080' });

  // Run database migration
  await migrateSyncToLocal();
});

// ─── Shortcut Commands Listener ──────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !tab.url) return;

    if (tab.url.startsWith('http')) {
      if (command === 'start-selection') {
        chrome.tabs.sendMessage(tab.id, { type: 'START_SELECTION' }).catch(() => {});
      } else if (command === 'reset-layout') {
        chrome.tabs.sendMessage(tab.id, { type: 'RESET_SITE' }).catch(() => {});
      } else if (command === 'start-paint') {
        chrome.tabs.sendMessage(tab.id, { type: 'START_PAINT' }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[PageEraser] Command listener error:', err);
  }
});

// ─── Context Menu Click Handler ───────────────────────────
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;
  
  try {
    if (info.menuItemId === "pe-erase") {
      chrome.tabs.sendMessage(tab.id, { type: "CONTEXT_ERASE" }).catch(() => {});
    } else if (info.menuItemId === "pe-stretch") {
      chrome.tabs.sendMessage(tab.id, { type: "CONTEXT_STRETCH" }).catch(() => {});
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

    tabBadgeCounts.set(tabId, count);

    chrome.action.setBadgeText({
      text: count > 0 ? String(count) : '',
      tabId
    });
  }
});

// ─── Clear badge when tab is closed ───────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  tabBadgeCounts.delete(tabId);
});

// ─── Refresh badge when switching tabs ────────────────────
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const count = tabBadgeCounts.get(activeInfo.tabId) || 0;
  chrome.action.setBadgeText({
    text: count > 0 ? String(count) : '',
    tabId: activeInfo.tabId
  });
});

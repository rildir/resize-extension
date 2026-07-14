// Mock chrome extension APIs if running outside extension context (e.g. directly in a browser tab)
(function() {
  'use strict';
  
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.storage) {
    const listeners = [];
    const storageListeners = [];
    
    window.chrome = {
      runtime: {
        id: "mock-extension-id",
        sendMessage: function(message, callback) {
          console.log("Mock sendMessage called:", message);
          if (callback) setTimeout(() => callback({ success: true }), 0);
        },
        onMessage: {
          addListener: function(listener) {
            listeners.push(listener);
          },
          removeListener: function(listener) {
            const idx = listeners.indexOf(listener);
            if (idx !== -1) listeners.splice(idx, 1);
          }
        },
        lastError: null
      },
      storage: {
        local: {
          get: function(keys, callback) {
            return new Promise((resolve) => {
              let result = {};
              if (keys === null) {
                for (let i = 0; i < localStorage.length; i++) {
                  const k = localStorage.key(i);
                  try {
                    result[k] = JSON.parse(localStorage.getItem(k));
                  } catch {
                    result[k] = localStorage.getItem(k);
                  }
                }
              } else if (typeof keys === 'string') {
                const val = localStorage.getItem(keys);
                try {
                  result[keys] = val ? JSON.parse(val) : undefined;
                } catch {
                  result[keys] = val;
                }
              } else if (Array.isArray(keys)) {
                keys.forEach(key => {
                  const val = localStorage.getItem(key);
                  try {
                    result[key] = val ? JSON.parse(val) : undefined;
                  } catch {
                    result[key] = val;
                  }
                });
              } else if (typeof keys === 'object' && keys !== null) {
                Object.keys(keys).forEach(key => {
                  const val = localStorage.getItem(key);
                  try {
                    result[key] = val ? JSON.parse(val) : keys[key];
                  } catch {
                    result[key] = val;
                  }
                });
              }
              if (callback) callback(result);
              resolve(result);
            });
          },
          set: function(items, callback) {
            return new Promise((resolve) => {
              const changes = {};
              Object.keys(items).forEach(key => {
                const oldValue = localStorage.getItem(key);
                localStorage.setItem(key, JSON.stringify(items[key]));
                changes[key] = {
                  oldValue: oldValue ? JSON.parse(oldValue) : undefined,
                  newValue: items[key]
                };
              });
              // Trigger onChanged listeners
              storageListeners.forEach(listener => {
                try {
                  listener(changes, 'local');
                } catch (e) {
                  console.error("Error in mock storage listener:", e);
                }
              });
              // Notify parent/opener to sync storage
              if (window.parent && window.parent !== window) {
                window.parent.postMessage({ source: 'page-eraser-mock-storage', changes }, '*');
              } else if (window.opener) {
                window.opener.postMessage({ source: 'page-eraser-mock-storage', changes }, '*');
              }
              if (callback) callback();
              resolve();
            });
          },
          remove: function(keys, callback) {
            return new Promise((resolve) => {
              if (typeof keys === 'string') {
                localStorage.removeItem(keys);
              } else if (Array.isArray(keys)) {
                keys.forEach(key => localStorage.removeItem(key));
              }
              if (callback) callback();
              resolve();
            });
          },
          clear: function(callback) {
            return new Promise((resolve) => {
              localStorage.clear();
              if (callback) callback();
              resolve();
            });
          }
        },
        onChanged: {
          addListener: function(listener) {
            storageListeners.push(listener);
          },
          removeListener: function(listener) {
            const idx = storageListeners.indexOf(listener);
            if (idx !== -1) storageListeners.splice(idx, 1);
          }
        }
      },
      tabs: {
        query: function(queryInfo, callback) {
          return new Promise((resolve) => {
            const tab = {
              id: 1,
              url: "http://localhost:8080/test.html",
              title: "Video Resizer Test Page",
              active: true
            };
            if (callback) callback([tab]);
            resolve([tab]);
          });
        },
        sendMessage: function(tabId, message, options, callback) {
          console.log("Mock tabs.sendMessage called:", tabId, message);
          // Forward message to the test page's content script if loaded in an iframe or parent
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({ source: 'page-eraser-mock-popup', message }, '*');
          } else if (window.opener) {
            window.opener.postMessage({ source: 'page-eraser-mock-popup', message }, '*');
          }
          if (typeof options === 'function') {
            callback = options;
          }
          return new Promise((resolve) => {
            if (callback) callback({ success: true });
            resolve({ success: true });
          });
        }
      },
      action: {
        setBadgeText: function(details, callback) {
          console.log("Mock setBadgeText called:", details);
          if (callback) callback();
        },
        setBadgeBackgroundColor: function(details, callback) {
          console.log("Mock setBadgeBackgroundColor called:", details);
          if (callback) callback();
        }
      }
    };
    window.chrome.storage.sync = window.chrome.storage.local;

    // Handle message events between playground pages
    window.addEventListener('message', (e) => {
      if (e.data && e.data.source === 'page-eraser-mock-popup') {
        console.log("Mock chrome script received postMessage:", e.data.message);
        listeners.forEach(listener => {
          try {
            listener(e.data.message, {}, (res) => {});
          } catch (err) {
            console.error(err);
          }
        });
      } else if (e.data && e.data.source === 'page-eraser-mock-storage') {
        console.log("Mock chrome script received storage sync postMessage:", e.data.changes);
        Object.keys(e.data.changes).forEach(key => {
          localStorage.setItem(key, JSON.stringify(e.data.changes[key].newValue));
        });
        storageListeners.forEach(listener => {
          try {
            listener(e.data.changes, 'local');
          } catch (err) {
            console.error(err);
          }
        });
      }
    });
  }
})();

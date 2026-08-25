/*
 * Fixate — background service worker (MV3).
 *
 * Handles the keyboard shortcut (Alt+B) and broadcasts a state change so the
 * toolbar badge can reflect the active mode on the current tab.
 */

chrome.runtime.onInstalled.addListener(() => {
  // Seed defaults so first-run queries from the content script always have a
  // value to read.
  chrome.storage.sync.get(null, (items) => {
    const seeded = {
      mode: 'fixate',
      fixateEnabled: true,
      fixateIntensity: 40,
      theme: 'auto',
      fontScale: 1,
      keepFiguresLight: false,
      siteOverrides: {}
    };
    const patch = {};
    for (const k of Object.keys(seeded)) {
      if (items[k] === undefined) patch[k] = seeded[k];
    }
    if (Object.keys(patch).length) chrome.storage.sync.set(patch);
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-fixate') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || tabs.length === 0) return;
    const tab = tabs[0];
    if (!tab || !tab.id) return;
    if (tab.url && !/^(https?|file):/.test(tab.url)) return;
    chrome.tabs.sendMessage(tab.id, { type: 'toggle' }, () => {
      void chrome.runtime.lastError;
    });
  });
});

function setBadge(tabId, mode) {
  const text = mode && mode !== 'off' ? 'ON' : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#89553E' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  if (!msg || msg.type !== 'stateChanged' || !sender.tab) return;
  const mode = ['fixate', 'restyle', 'reader'].includes(msg.mode) ? msg.mode : 'off';
  setBadge(sender.tab.id, mode);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') setBadge(tabId, 'off');
});

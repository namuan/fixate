/*
 * Fixate — background service worker (MV3).
 *
 * Handles the keyboard shortcut (Alt+B) and broadcasts a state change so the
 * toolbar badge can reflect the active mode on the current tab.
 */

chrome.runtime.onInstalled.addListener(() => {
  // Seed defaults so first-run queries from the content script always have a
  // value to read. Also migrate legacy mode values from the pre-2.1 shape
  // (mode was a single value: 'off' | 'fixate' | 'restyle' | 'reader') to the
  // current on/off + restyleEnabled + readerEnabled shape, so a freshly
  // installed/updated extension always exposes the canonical keys.
  chrome.storage.sync.get(null, (items) => {
    const seeded = {
      mode: 'on',
      fixateEnabled: true,
      fixateIntensity: 40,
      restyleEnabled: false,
      readerEnabled: false,
      theme: 'auto',
      fontScale: 1,
      keepFiguresLight: false,
      siteOverrides: {}
    };
    const patch = {};

    if (items.mode === 'fixate') { patch.mode = 'on'; }
    else if (items.mode === 'restyle') { patch.mode = 'on'; patch.restyleEnabled = true; }
    else if (items.mode === 'reader') { patch.mode = 'on'; patch.readerEnabled = true; }
    else if (items.mode === undefined || (items.mode !== 'off' && items.mode !== 'on')) {
      patch.mode = seeded.mode;
    }
    if (items.restyleEnabled === undefined) patch.restyleEnabled = seeded.restyleEnabled;
    if (items.readerEnabled === undefined) patch.readerEnabled = seeded.readerEnabled;

    for (const k of Object.keys(seeded)) {
      if (items[k] === undefined && patch[k] === undefined) patch[k] = seeded[k];
    }
    if (Object.keys(patch).length) chrome.storage.sync.set(patch);
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-fixate' && command !== 'toggle-suspend') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || tabs.length === 0) return;
    const tab = tabs[0];
    if (!tab || !tab.id) return;
    if (tab.url && !/^(https?|file):/.test(tab.url)) return;
    const msgType = command === 'toggle-suspend' ? 'toggleSuspended' : 'toggle';
    chrome.tabs.sendMessage(tab.id, { type: msgType }, () => {
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
  const mode = msg.mode === 'on' ? 'on' : 'off';
  setBadge(sender.tab.id, mode);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') setBadge(tabId, 'off');
});

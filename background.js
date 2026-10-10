// background.js — service worker: orchestration only, no detection here.
// Routes: content script (feed pages) <-> offscreen document (camera + engine).

const OFFSCREEN_URL = 'offscreen.html';
const armedTabs = new Set(); // tabIds currently on a reels/shorts feed
let lastArmedTabId = 0;

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install' || reason === 'update') injectIntoOpenFeeds();
  if (reason === 'install') {
    // First run: open the calibration interview. Nothing works well without it.
    chrome.tabs.create({ url: chrome.runtime.getURL('interview.html') });
  }
});

// Chrome does NOT inject content scripts into tabs that were already open
// when the extension loads — without this, a pre-open reels tab would never
// be detected until the user manually reloads it.
async function injectIntoOpenFeeds() {
  try {
    const tabs = await chrome.tabs.query({
      url: ['*://www.instagram.com/*', '*://www.tiktok.com/*', '*://www.youtube.com/*'],
    });
    for (const t of tabs) {
      if (t.id) {
        chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] })
          .catch(() => {}); // tab may not allow scripting (chrome:// etc.)
      }
    }
  } catch { /* scripting permission missing — non-fatal */ }
}

async function ensureOffscreen() {
  try {
    if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
  } catch { /* older Chrome: just try to create */ }
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification:
      'BlinkScroll detects your blinks via webcam to scroll reels. All video is processed on-device; nothing is uploaded anywhere.',
  });
}

function pickTargetTab() {
  return lastArmedTabId && armedTabs.has(lastArmedTabId)
    ? lastArmedTabId
    : [...armedTabs][0];
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'FEED_ACTIVE': {
        if (sender.tab?.id) {
          armedTabs.add(sender.tab.id);
          lastArmedTabId = sender.tab.id;
          await ensureOffscreen();
          // The offscreen document can't read chrome.storage — hand it the
          // saved profile + enabled flag directly with the ARM.
          const data = await chrome.storage.local.get(['profile', 'enabled']);
          chrome.runtime.sendMessage({
            type: 'ARM',
            tabId: sender.tab.id,
            profile: data.profile || null,
            enabled: data.enabled !== false,
          });
        }
        break;
      }
      case 'FEED_INACTIVE': {
        if (sender.tab?.id) {
          armedTabs.delete(sender.tab.id);
          chrome.runtime.sendMessage({ type: 'DISARM', tabId: sender.tab.id });
        }
        break;
      }
      case 'GESTURE': {
        // From the offscreen document: a blink gesture was detected.
        const target = pickTargetTab();
        if (target) {
          // The tab may not have our content script (e.g. wrong page) —
          // never let that reject unhandled.
          chrome.tabs.sendMessage(target, { type: 'DO_GESTURE', gesture: msg.gesture })
            .catch(() => {});
        }
        break;
      }
      case 'GET_STATE': {
        const data = await chrome.storage.local.get(['enabled', 'profile']);
        sendResponse({
          enabled: data.enabled !== false,
          hasProfile: !!data.profile,
          calibratedAt: data.profile?.calibratedAt || 0,
          feedActive: armedTabs.size > 0,
        });
        break;
      }
      case 'SET_ENABLED': {
        await chrome.storage.local.set({ enabled: msg.enabled });
        chrome.runtime.sendMessage({ type: 'ENABLED_CHANGED', enabled: msg.enabled });
        sendResponse({ ok: true });
        break;
      }
      // GET_STATUS is answered by the offscreen document, not here.
    }
  })();
  return true; // async sendResponse
});

chrome.tabs.onRemoved.addListener(id => {
  if (armedTabs.delete(id)) {
    // The offscreen worker keeps its own armed set — tell it, or its camera
    // would run forever watching a tab that no longer exists.
    chrome.runtime.sendMessage({ type: 'DISARM', tabId: id }).catch(() => {});
  }
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (armedTabs.has(tabId)) lastArmedTabId = tabId;
});

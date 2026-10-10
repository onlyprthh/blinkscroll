// background.js — service worker: active-tab routing and camera lifecycle.
// The service worker is restartable, so feed-tab state is kept in storage.session.
importScripts('src/site-routing.js');

const OFFSCREEN_URL = 'offscreen.html';
const FEED_URLS = [...BlinkScrollRouting.urlPatterns];

const feedTabs = new Set();
let feedTabsLoaded = false;
let feedTabsLoadPromise = null;
let offscreenCreatePromise = null;
let offscreenKnown = false;
let lastSyncedTabId; // undefined = not synced yet; null = no active feed
let lastSyncedEnabled;
let syncQueue = Promise.resolve();

// Camera errors that must never auto-retry: re-prompting for a denied,
// missing, or misconfigured camera is hostile, so those stay wedged until the
// user hits retry / Fix camera access in the popup. Anything else is treated
// as transient (a briefly busy device, an interrupted start) and gets a
// throttled re-attempt instead of wedging the camera off forever.
const NO_RETRY_CAMERA_ERRORS = new Set([
  'NotAllowedError',
  'NotFoundError',
  'OverconstrainedError',
  'SecurityError',
  'NotSupportedError',
  'DetectorError',
  'TypeError',
]);
const CAMERA_RETRY_COOLDOWN_MS = 15000;
let lastCameraRetryAt = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install' || reason === 'update') void injectIntoOpenFeeds();
  if (reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('interview.html') }).catch(() => {});
  }
});

chrome.runtime.onStartup?.addListener(() => {
  feedTabs.clear();
  feedTabsLoaded = true;
  void chrome.storage.session?.remove(['feedTabIds']);
  lastSyncedTabId = undefined;
  lastSyncedEnabled = undefined;
});

async function injectIntoOpenFeeds() {
  try {
    await loadFeedTabs();
    const tabs = await chrome.tabs.query({ url: FEED_URLS });
    await Promise.all(tabs.map(tab => ensureFeedContentScript(tab, true)));
    await queueActiveFeedSync(true).catch(() => {});
  } catch { /* Non-fatal: content scripts inject on subsequent navigations. */ }
}

async function ensureFeedContentScript(tab, force = false) {
  if (tab?.id === undefined || !BlinkScrollRouting.isFeedUrl(tab.url)) return false;
  if (!force && feedTabs.has(tab.id)) return true;

  try {
    // This also self-heals already-open tabs after an extension reload/update.
    // The content script's idempotency guard makes repeat injection safe.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['src/site-routing.js', 'content.js'],
    });
  } catch {
    // Restricted pages, discarded tabs, and navigation races can reject injection.
    return false;
  }

  if (!feedTabs.has(tab.id)) {
    feedTabs.add(tab.id);
    await persistFeedTabs();
    lastSyncedTabId = undefined;
    lastSyncedEnabled = undefined;
  }
  return true;
}

async function loadFeedTabs() {
  if (feedTabsLoaded) return;
  if (!feedTabsLoadPromise) {
    feedTabsLoadPromise = (async () => {
      try {
        const saved = await chrome.storage.session?.get(['feedTabIds']);
        const ids = Array.isArray(saved?.feedTabIds) ? saved.feedTabIds : [];
        const openTabs = await chrome.tabs.query({});
        const existing = new Set(openTabs.map(tab => tab.id).filter(id => id !== undefined));
        feedTabs.clear();
        for (const id of ids) {
          if (Number.isInteger(id) && existing.has(id)) feedTabs.add(id);
        }
      } catch {
        // Older browser / unavailable session storage: use the in-memory state.
      } finally {
        feedTabsLoaded = true;
        feedTabsLoadPromise = null;
      }
    })();
  }
  await feedTabsLoadPromise;
}

async function persistFeedTabs() {
  try {
    await chrome.storage.session?.set({ feedTabIds: [...feedTabs] });
  } catch { /* In-memory state remains usable for this worker lifetime. */ }
}

async function hasOffscreenDocument() {
  try {
    if (typeof chrome.runtime.getContexts === 'function') {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
      });
      return contexts.length > 0;
    }
    // Chrome 109–115: runtime.getContexts was not available yet.
    if (globalThis.clients?.matchAll) {
      const clients = await globalThis.clients.matchAll();
      return clients.some(client => client.url === chrome.runtime.getURL(OFFSCREEN_URL));
    }
  } catch { /* Fall back to local knowledge below. */ }
  return offscreenKnown;
}

async function ensureOffscreen() {
  if (await hasOffscreenDocument()) {
    offscreenKnown = true;
    return;
  }
  if (!offscreenCreatePromise) {
    offscreenCreatePromise = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA'],
      justification:
        'BlinkScroll detects blinks with the webcam to control feeds. Frames are processed on-device and never uploaded.',
    }).then(() => {
      offscreenKnown = true;
    }).catch(async err => {
      // The document may have been created by a parallel event.
      if (await hasOffscreenDocument()) {
        offscreenKnown = true;
        return;
      }
      throw err;
    }).finally(() => {
      offscreenCreatePromise = null;
    });
  }
  await offscreenCreatePromise;
}

// The offscreen module script may execute a moment after createDocument resolves.
// Retry until its listener acknowledges the message instead of losing the first ARM.
async function sendOffscreen(message, attempts = 12) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const reply = await chrome.runtime.sendMessage(message);
      if (reply?.ok === true) return reply;
      lastError = new Error('Offscreen document did not acknowledge the message');
    } catch (err) {
      lastError = err;
    }
    await sleep(100 + Math.min(i * 25, 250));
  }
  throw lastError || new Error('Offscreen document unavailable');
}

async function readOffscreenStatus() {
  if (!await hasOffscreenDocument()) return null;
  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    return status?.ok === true ? status : null;
  } catch {
    return null;
  }
}

async function syncActiveFeed(force = false) {
  await loadFeedTabs();
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const { enabled, profile } = await chrome.storage.local.get(['enabled', 'profile']);
  const isEnabled = enabled !== false;
  const target = BlinkScrollRouting.resolveCameraTarget({
    activeTab,
    enabled: isEnabled,
  });
  // Do not make camera startup depend on FEED_ACTIVE having arrived first.
  // The selected tab URL is authoritative; content-script messages are only
  // used for status/injection recovery.
  const targetId = target.targetId;

  if (targetId !== null) {
    await ensureFeedContentScript(activeTab, !feedTabs.has(targetId));
  }

  if (!force && targetId === lastSyncedTabId && isEnabled === lastSyncedEnabled) {
    if (targetId === null) return targetId;

    // Sending START is not proof that the camera actually started. Reconcile
    // against live offscreen status, so a rejected getUserMedia or a restarted
    // offscreen document cannot leave the cached state permanently stuck ON.
    const status = await readOffscreenStatus();
    if (status?.activeTabId === targetId && (status.cameraOn || status.cameraStarting)) {
      return targetId;
    }
    // Don't repeatedly prompt for a denied/missing/misconfigured camera. The
    // popup exposes a deliberate retry / permission-recovery action for those
    // cases. Transient failures get one throttled re-attempt: without this, a
    // single momentary failure (e.g. the device was briefly busy) wedged the
    // camera off forever — every later sync early-returned on the cached
    // cameraError and never tried again.
    if (status?.activeTabId === targetId && status.cameraError) {
      if (NO_RETRY_CAMERA_ERRORS.has(status.cameraError)) return targetId;
      const now = Date.now();
      if (now - lastCameraRetryAt < CAMERA_RETRY_COOLDOWN_MS) return targetId;
      lastCameraRetryAt = now;
    }
  }

  if (targetId !== null && isEnabled) {
    await ensureOffscreen();
    await sendOffscreen({
      type: 'SYNC_ACTIVE_FEED',
      tabId: targetId,
      profile: profile || null,
      enabled: true,
    });
  } else if (await hasOffscreenDocument()) {
    await sendOffscreen({
      type: 'SYNC_ACTIVE_FEED',
      tabId: null,
      profile: profile || null,
      enabled: isEnabled,
    });
  }

  lastSyncedTabId = targetId;
  lastSyncedEnabled = isEnabled;
  return targetId;
}

function queueActiveFeedSync(force = false) {
  syncQueue = syncQueue.catch(() => {}).then(() => syncActiveFeed(force));
  return syncQueue;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // IMPORTANT: return false for messages owned by the offscreen/interview pages.
  // Returning true without calling sendResponse leaves their message channels open.
  const handled = new Set(['FEED_ACTIVE', 'FEED_INACTIVE', 'GET_STATE', 'SET_ENABLED', 'RETRY_CAMERA', 'GESTURE']);
  if (!msg || !handled.has(msg.type)) return false;

  (async () => {
    await loadFeedTabs();
    switch (msg.type) {
      case 'FEED_ACTIVE': {
        const id = sender.tab?.id;
        if (id !== undefined) {
          feedTabs.add(id);
          await persistFeedTabs();
          await queueActiveFeedSync(true);
        }
        const { enabled } = await chrome.storage.local.get('enabled');
        sendResponse({ ok: true, enabled: enabled !== false });
        break;
      }
      case 'FEED_INACTIVE': {
        const id = sender.tab?.id;
        if (id !== undefined) {
          feedTabs.delete(id);
          await persistFeedTabs();
          await queueActiveFeedSync(true);
        }
        const { enabled } = await chrome.storage.local.get('enabled');
        sendResponse({ ok: true, enabled: enabled !== false });
        break;
      }
      case 'GET_STATE': {
        const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (activeTab?.id !== undefined && BlinkScrollRouting.isFeedUrl(activeTab.url)) {
          await ensureFeedContentScript(activeTab, !feedTabs.has(activeTab.id));
        }
        const activeFeedTabId = await queueActiveFeedSync();
        const data = await chrome.storage.local.get(['enabled', 'profile']);
        let activeUrl = '';
        try {
          const u = new URL(activeTab?.url || '');
          activeUrl = `${u.hostname}${u.pathname}`;
        } catch { activeUrl = ''; }
        sendResponse({
          enabled: data.enabled !== false,
          hasProfile: !!data.profile,
          calibratedAt: data.profile?.calibratedAt || 0,
          feedActive: BlinkScrollRouting.isFeedUrl(activeTab?.url),
          cameraTargetActive: activeFeedTabId !== null,
          activeUrl,
        });
        break;
      }
      case 'SET_ENABLED': {
        const isEnabled = msg.enabled !== false;
        await chrome.storage.local.set({ enabled: isEnabled });
        lastSyncedTabId = undefined;
        lastSyncedEnabled = undefined;
        await queueActiveFeedSync(true);
        // The content script also gates manual/test gestures, not just camera input.
        await Promise.allSettled([...feedTabs].map(tabId =>
          chrome.tabs.sendMessage(tabId, { type: 'ENABLED_CHANGED', enabled: isEnabled })
        ));
        sendResponse({ ok: true, enabled: isEnabled });
        break;
      }
      case 'RETRY_CAMERA': {
        lastSyncedTabId = undefined;
        lastSyncedEnabled = undefined;
        const targetId = await queueActiveFeedSync(true);
        sendResponse({ ok: true, cameraTargetActive: targetId !== null });
        break;
      }
      case 'GESTURE': {
        const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const { enabled } = await chrome.storage.local.get('enabled');
        const target = BlinkScrollRouting.resolveCameraTarget({
          activeTab, enabled: enabled !== false,
        });
        if (target.targetId !== null) {
          await ensureFeedContentScript(activeTab, !feedTabs.has(target.targetId));
          try {
            await chrome.tabs.sendMessage(target.targetId, {
              type: 'DO_GESTURE',
              gesture: msg.gesture,
            });
          } catch { /* The active tab may have navigated between checks. */ }
        }
        sendResponse({ ok: true });
        break;
      }
    }
  })().catch(err => {
    try { sendResponse({ ok: false, error: String(err?.message || err) }); } catch { /* Port closed. */ }
  });
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const currentUrl = changeInfo.url || tab.url;
  if (!currentUrl || !(changeInfo.url || changeInfo.status === 'complete')) return;

  void (async () => {
    await loadFeedTabs();
    const currentTab = { ...tab, id: tabId, url: currentUrl };
    if (BlinkScrollRouting.isFeedUrl(currentUrl)) {
      const injected = await ensureFeedContentScript(currentTab, true);
      if (injected) await queueActiveFeedSync(true);
      return;
    }

    // Any navigation away from a feed invalidates that tab's feed status,
    // including navigation from Instagram directly to an unrelated hostname.
    const wasKnownFeed = feedTabs.delete(tabId);
    if (wasKnownFeed) await persistFeedTabs();
    if (wasKnownFeed || tabId === lastSyncedTabId) {
      lastSyncedTabId = undefined;
      lastSyncedEnabled = undefined;
      await queueActiveFeedSync(true);
    }
  })().catch(() => {});
});

chrome.tabs.onRemoved.addListener(id => {
  void (async () => {
    await loadFeedTabs();
    if (feedTabs.delete(id)) await persistFeedTabs();
    lastSyncedTabId = undefined;
    await queueActiveFeedSync(true).catch(() => {});
  })();
});

chrome.tabs.onActivated.addListener(() => {
  lastSyncedTabId = undefined;
  void queueActiveFeedSync(true).catch(() => {});
});

chrome.windows?.onFocusChanged?.addListener(windowId => {
  // Do not stop the camera on WINDOW_ID_NONE. Some browser/OS focus transitions
  // around an extension action popup emit it even though the selected feed tab
  // has not changed. Camera lifetime follows tab activation/navigation and the
  // Enabled setting, never the popup's open/closed state. A real window focus
  // gain just reconciles against whichever tab is now selected.
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  lastSyncedTabId = undefined;
  lastSyncedEnabled = undefined;
  void queueActiveFeedSync(true).catch(() => {});
});

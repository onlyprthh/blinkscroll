// Shared URL routing for the content script and the service worker.
// Kept as a classic-script IIFE so it can run in both extension contexts and Node tests.
(function attachBlinkScrollRouting(root, factory) {
  const routing = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = routing;
  } else {
    root.BlinkScrollRouting = routing;
  }
})(globalThis, function makeBlinkScrollRouting() {
  const urlPatterns = Object.freeze([
    '*://instagram.com/*',
    '*://www.instagram.com/*',
    '*://tiktok.com/*',
    '*://www.tiktok.com/*',
    '*://youtube.com/*',
    '*://www.youtube.com/*',
    '*://facebook.com/*',
    '*://www.facebook.com/*',
    '*://m.facebook.com/*',
  ]);

  function parseUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl) return null;
    try {
      return new URL(rawUrl);
    } catch {
      return null;
    }
  }

  function siteForUrl(rawUrl) {
    const url = parseUrl(rawUrl);
    if (!url) return null;
    const host = url.hostname.toLowerCase();
    if (host === 'instagram.com' || host === 'www.instagram.com') return 'instagram';
    if (host === 'tiktok.com' || host === 'www.tiktok.com') return 'tiktok';
    if (host === 'youtube.com' || host === 'www.youtube.com') return 'youtube';
    if (host === 'facebook.com' || host === 'www.facebook.com' || host === 'm.facebook.com') return 'facebook';
    return null;
  }

  function isSupportedHostUrl(rawUrl) {
    return siteForUrl(rawUrl) !== null;
  }

  function isFeedUrl(rawUrl) {
    const url = parseUrl(rawUrl);
    const site = siteForUrl(rawUrl);
    if (!url || !site) return false;
    const path = url.pathname;

    if (site === 'instagram') return /^\/reels?(?:\/|$)/.test(path);
    if (site === 'facebook') return /^\/reels?(?:\/|$)/.test(path);
    if (site === 'tiktok') {
      // TikTok serves the For You feed under a locale prefix (/en/, /en-US/).
      // Strip it so the feed rules work in every locale.
      const p = path.replace(/^\/[a-z]{2}(?:-[A-Za-z]{2})?(?=\/|$)/, '') || '/';
      return p === '/' || p.startsWith('/foryou') || /^\/@[^/]+\/video\//.test(p);
    }
    if (site === 'youtube') return path === '/shorts' || path.startsWith('/shorts/');
    return false;
  }

  // Camera eligibility is based only on the user's explicit Enabled setting and
  // the selected browser tab URL. Never gate capture on windows.onFocusChanged:
  // Chrome can report WINDOW_ID_NONE during extension action-popup focus changes,
  // which would incorrectly stop the camera when the user dismisses this popup.
  // Content-script heartbeats are telemetry/recovery only, never the source of truth.
  function resolveCameraTarget({ activeTab, enabled = true } = {}) {
    if (enabled === false) return { targetId: null, reason: 'disabled' };
    if (!activeTab || !Number.isInteger(activeTab.id)) {
      return { targetId: null, reason: 'no-active-tab' };
    }
    if (!isFeedUrl(activeTab.url)) {
      return { targetId: null, reason: 'not-a-supported-feed' };
    }
    return { targetId: activeTab.id, reason: 'active-supported-feed' };
  }

  return Object.freeze({ urlPatterns, siteForUrl, isSupportedHostUrl, isFeedUrl, resolveCameraTarget });
});

// Guard: background may inject this into already-open tabs that the
// manifest already injected into — never run twice in one page.
if (!window.__blinkscroll_injected) {
window.__blinkscroll_injected = true;

// content.js — runs on instagram/tiktok/youtube. Detects reels/shorts feeds and
// executes scroll/pause commands from blink gestures. No camera access here.

let feedActive = false;
let extensionEnabled = true;
let lastDomCheck = 0;
let domFeed = false;
let reportedFeedState = null;
let reportPending = false;

function isFeed() {
  // Known site routes are shared with the service worker. This prevents the
  // popup and content script disagreeing about whether a tab is a feed.
  if (globalThis.BlinkScrollRouting?.isSupportedHostUrl(location.href)) {
    return globalThis.BlinkScrollRouting.isFeedUrl(location.href);
  }
  const h = location.hostname;
  const p = location.pathname;
  // Unknown host or path: auto-detect a reel-style feed from the DOM itself,
  // so new layouts/paths keep working without an update.
  const now = performance.now();
  if (now - lastDomCheck > 3000) {
    lastDomCheck = now;
    domFeed = looksLikeReelFeed();
  }
  return domFeed;
}

function looksLikeReelFeed() {
  try {
    // A portrait video dominating the viewport inside something scrollable
    // is a reels/shorts-style feed, whatever the URL says.
    const vids = [...document.querySelectorAll('video')].filter(v =>
      v.offsetParent !== null && v.readyState > 0 &&
      v.videoHeight > v.videoWidth && v.clientHeight > window.innerHeight * 0.6);
    if (!vids.length) return false;
    return !!findFeedScroller() ||
      document.documentElement.scrollHeight > window.innerHeight + 8;
  } catch {
    return false;
  }
}

function report() {
  const f = isFeed();
  feedActive = f;
  // If the service worker was restarting when the first report was sent, retry
  // on the next poll instead of getting stuck forever in an unreported state.
  if (reportPending || reportedFeedState === f) return;
  reportPending = true;
  chrome.runtime.sendMessage({ type: f ? 'FEED_ACTIVE' : 'FEED_INACTIVE' })
    .then(response => {
      if (response?.ok === true) {
        reportedFeedState = f;
        if (typeof response.enabled === 'boolean') extensionEnabled = response.enabled;
      } else {
        reportedFeedState = null;
      }
    })
    .catch(() => { reportedFeedState = null; })
    .finally(() => { reportPending = false; });
}

// These are SPAs — URL changes without reloads. A 1s poll is the robust way
// to track feed enter/exit (cheaper and simpler than patching history).
setInterval(report, 1000);
report();

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === 'ENABLED_CHANGED') {
    extensionEnabled = msg.enabled !== false;
    return;
  }
  if (msg?.type !== 'DO_GESTURE' || !feedActive || !extensionEnabled) return;
  if (msg.gesture === 'single') scrollFeed(1);   // next reel
  else if (msg.gesture === 'double') scrollFeed(-1); // previous reel
  else if (msg.gesture === 'long') togglePause();    // pause / resume
});

function findFeedScroller() {
  // The biggest visible <video> is the current reel; its nearest scrollable
  // ancestor is the feed's scroll-snap container. Scrolling THAT is far more
  // reliable than synthetic key events (no focus/keybinding quirks per site).
  const vids = [...document.querySelectorAll('video')]
    .filter(v => v.offsetParent !== null && v.readyState > 0);
  if (!vids.length) return null;
  vids.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
  let el = vids[0].parentElement;
  while (el && el !== document.documentElement) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay')
        && el.scrollHeight > el.clientHeight + 8) {
      return el;
    }
    el = el.parentElement;
  }
  // Some feeds scroll the document itself rather than an ancestor of the video.
  const root = document.scrollingElement;
  if (root && root.scrollHeight > root.clientHeight + 8) return root;
  return null;
}

function scrollFeed(dir) {
  const scroller = findFeedScroller();
  if (scroller) {
    const distance = Math.max(scroller.clientHeight, window.innerHeight);
    scroller.scrollBy({ top: dir * distance, behavior: 'smooth' });
    return;
  }

  // Last resort for feeds whose scroll container is hidden behind a player
  // component. Synthetic arrows are kept as a secondary site-specific hint.
  window.scrollBy({ top: dir * window.innerHeight, behavior: 'smooth' });
  pressArrow(dir > 0 ? 'ArrowDown' : 'ArrowUp');
}

function pressArrow(key) {
  // Fallback when no feed scroll-container is found: the three players'
  // native ArrowUp/ArrowDown feed navigation. Key events avoid brittle
  // per-site DOM selectors.
  const keyCode = key === 'ArrowDown' ? 40 : 38;
  for (const type of ['keydown', 'keyup']) {
    document.dispatchEvent(
      new KeyboardEvent(type, {
        key,
        code: key,
        keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
      })
    );
  }
}

function togglePause() {
  // Universal v1 approach: click the largest visible <video>. All three
  // players toggle play/pause on video click.
  const vids = [...document.querySelectorAll('video')].filter(
    v => v.offsetParent !== null && v.readyState > 0
  );
  if (!vids.length) return;
  vids.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
  const video = vids[0];

  // Programmatic media controls are more reliable than an untrusted synthetic
  // click, which browser/player default handlers are allowed to ignore.
  if (video.paused || video.ended) {
    video.play().catch(() => {
      video.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  } else {
    video.pause();
    video.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }
}

} // __blinkscroll_injected

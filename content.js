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

// --- On-page status HUD ------------------------------------------------------
// A small floating pill (shadow DOM: immune to site CSS) showing the live
// running status: camera, face tracking, last gesture. Visible only while on
// a supported feed with BlinkScroll enabled. Click "–" to collapse to a dot.
let hudHost = null;

function ensureHud() {
  if (hudHost || !document.documentElement) return;
  hudHost = document.createElement('div');
  hudHost.id = 'blinkscroll-hud-host';
  const shadow = hudHost.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      #hud { position: fixed; right: 12px; bottom: 12px; z-index: 2147483647;
             font-family: system-ui, -apple-system, sans-serif; font-size: 12px;
             line-height: 1.5; color: #f5f5f7; background: rgba(14,14,16,0.92);
             border: 1px solid #2d2d36; border-radius: 10px; padding: 8px 10px;
             min-width: 148px; box-shadow: 0 4px 16px rgba(0,0,0,0.5);
             user-select: none; }
      .row { display: flex; align-items: center; gap: 6px; margin: 2px 0; white-space: nowrap; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #555; flex: none; }
      .dot.on { background: #11b086; box-shadow: 0 0 5px #11b086; }
      .dot.warn { background: #e0a63c; }
      .title { font-weight: 600; margin-bottom: 4px; display: flex;
               justify-content: space-between; align-items: center; }
      #hudToggle { cursor: pointer; border: none; background: none; color: #a8a8b5;
                   font-size: 14px; padding: 0 4px; line-height: 1; }
      #hudToggle:hover { color: #f5f5f7; }
      #hudMini { display: none; align-items: center; gap: 6px; cursor: pointer; padding: 2px; }
      #hud.collapsed #hudFull { display: none; }
      #hud.collapsed #hudMini { display: flex; }
      .dim { opacity: 0.65; }
    </style>
    <div id="hud">
      <div id="hudMini"><span class="dot" id="hudMiniDot"></span><span>👁 BlinkScroll</span></div>
      <div id="hudFull">
        <div class="title"><span>👁 BlinkScroll</span><button id="hudToggle" title="Minimize">–</button></div>
        <div class="row"><span class="dot" id="hudCamDot"></span><span id="hudCamText">Camera…</span></div>
        <div class="row"><span class="dot" id="hudFaceDot"></span><span id="hudFaceText">Face…</span></div>
        <div class="row"><span class="dim">Last:</span><span id="hudGestText">–</span></div>
      </div>
    </div>`;
  document.documentElement.appendChild(hudHost);
  const hud = shadow.getElementById('hud');
  shadow.getElementById('hudToggle').addEventListener('click', () => hud.classList.add('collapsed'));
  shadow.getElementById('hudMini').addEventListener('click', () => hud.classList.remove('collapsed'));
  hudHost._shadow = shadow;
}

function renderHud(status) {
  if (!hudHost) return;
  const s = hudHost._shadow;
  const setRow = (dotId, textId, text, cls) => {
    s.getElementById(dotId).className = 'dot' + (cls ? ' ' + cls : '');
    s.getElementById(textId).textContent = text;
  };
  const ok = status && status.ok === true;
  const camOn = ok && status.cameraOn === true;
  const camErr = ok && status.cameraError;
  setRow('hudCamDot', 'hudCamText',
    camOn ? 'Camera on' : camErr ? 'Camera blocked' : 'Camera off',
    camOn ? 'on' : camErr ? 'warn' : '');
  const faceOk = camOn && status.engine && !status.engine.suspended;
  setRow('hudFaceDot', 'hudFaceText',
    !camOn ? 'Face –' : faceOk ? 'Face tracking' : 'No face',
    camOn ? (faceOk ? 'on' : 'warn') : '');
  s.getElementById('hudGestText').textContent =
    ok && status.lastGesture ? `${status.lastGesture.type} · ${Math.max(0, Math.round((Date.now() - status.lastGesture.at) / 1000))}s ago` : '–';
  s.getElementById('hudMiniDot').className = 'dot' + (camOn ? ' on' : camErr ? ' warn' : '');
}

setInterval(async () => {
  const show = feedActive && extensionEnabled;
  if (show) ensureHud();
  if (hudHost) hudHost.style.display = show ? '' : 'none';
  if (!show) return;
  try {
    // Answered by the offscreen document (the service worker ignores it).
    renderHud(await chrome.runtime.sendMessage({ type: 'GET_STATUS' }));
  } catch {
    renderHud(null);
  }
}, 2000);

} // __blinkscroll_injected

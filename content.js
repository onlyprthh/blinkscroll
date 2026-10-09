// content.js — runs on instagram/tiktok/youtube. Detects reels/shorts feeds and
// executes scroll/pause commands from blink gestures. No camera access here.

let feedActive = false;

function isFeed() {
  const h = location.hostname;
  const p = location.pathname;
  if (h.includes('instagram.com')) return p.startsWith('/reels');
  if (h.includes('tiktok.com')) {
    return p === '/' || p.startsWith('/foryou') || /\/@[^/]+\/video\//.test(p);
  }
  if (h.includes('youtube.com')) return p.startsWith('/shorts');
  return false;
}

function report() {
  const f = isFeed();
  if (f !== feedActive) {
    feedActive = f;
    chrome.runtime.sendMessage({ type: f ? 'FEED_ACTIVE' : 'FEED_INACTIVE' });
  }
}

// These are SPAs — URL changes without reloads. A 1s poll is the robust way
// to track feed enter/exit (cheaper and simpler than patching history).
setInterval(report, 1000);
report();

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type !== 'DO_GESTURE' || !feedActive) return;
  if (msg.gesture === 'single') pressArrow('ArrowDown'); // next reel
  else if (msg.gesture === 'double') pressArrow('ArrowUp'); // previous reel
  else if (msg.gesture === 'long') togglePause(); // pause / resume
});

function pressArrow(key) {
  // All three players (IG Reels, TikTok, YT Shorts) navigate feeds with
  // ArrowUp/ArrowDown. Key events avoid brittle per-site DOM selectors.
  // NOTE: synthetic-key navigation is UNVERIFIED live per site — verify on
  // first real run; fallback would be scrolling the feed container directly.
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
  vids[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

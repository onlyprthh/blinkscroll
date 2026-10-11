import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const content = readFileSync(new URL('../content.js', import.meta.url), 'utf8');

function fnSource(name) {
  const start = content.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() exists in content.js`);
  return content.slice(start);
}

test('TikTok scrolls via its own chevron buttons, never programmatic scroll()', () => {
  // Live-DOM verification (2026-10-11): TikTok drives its feed through its own
  // key/wheel handlers with animated transitions; scroll() on its container
  // is ignored, and synthetic key events dispatched on `document` miss its
  // handlers. Its prev/next chevron buttons (data-e2e selectors, build-stable)
  // are the reliable actuator: real clicks verified to advance the feed.
  const scrollFeed = fnSource('scrollFeed');
  assert.match(scrollFeed, /tiktok\.com/);
  assert.match(scrollFeed, /button\[data-e2e="feed-navigation-next"\]/);
  assert.match(scrollFeed, /button\[data-e2e="feed-navigation-prev"\]/);
  assert.match(scrollFeed, /chevron\.click\(\)/);
  // The TikTok branch must return before any scrollBy call.
  const tiktokBranch = scrollFeed.slice(
    scrollFeed.indexOf('tiktok.com'),
    scrollFeed.indexOf('findFeedScroller()'),
  );
  assert.doesNotMatch(tiktokBranch, /scrollBy/);
  assert.match(tiktokBranch, /return;/);
});

test('non-TikTok feeds scroll the detected feed container by one viewport', () => {
  const scrollFeed = fnSource('scrollFeed');
  assert.match(scrollFeed, /findFeedScroller\(\)/);
  assert.match(scrollFeed, /scroller\.scrollBy\(\{ top: dir \* distance/);
});

test('pressArrow dispatches a trusted-shape keydown/keyup pair deep in the DOM', () => {
  // Events dispatched on `document` never reach listeners attached below it
  // (no downward propagation). Dispatching from the video element lets the
  // event bubble through app root, body, document, and window.
  const pressArrow = fnSource('pressArrow');
  assert.match(pressArrow, /new KeyboardEvent\(type,/);
  assert.doesNotMatch(pressArrow, /document\.dispatchEvent/);
  assert.match(pressArrow, /target\.dispatchEvent/);
  assert.match(pressArrow, /document\.querySelector\('video'\)/);
  assert.match(pressArrow, /keyCode/);
});

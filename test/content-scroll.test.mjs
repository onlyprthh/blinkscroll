import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const content = readFileSync(new URL('../content.js', import.meta.url), 'utf8');

function fnSource(name) {
  const start = content.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() exists in content.js`);
  return content.slice(start);
}

test('TikTok scrolls via arrow keys, never programmatic scroll()', () => {
  // Live-DOM verification (2026-10-11): TikTok drives its feed through its own
  // key/wheel handlers with animated transitions; scroll() on its container
  // is ignored. Arrow keys are its documented feed navigation.
  const scrollFeed = fnSource('scrollFeed');
  assert.match(scrollFeed, /tiktok\.com/);
  assert.match(scrollFeed, /pressArrow\(dir > 0 \? 'ArrowDown' : 'ArrowUp'\)/);
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

test('pressArrow dispatches a trusted-shape keydown/keyup pair on document', () => {
  const pressArrow = fnSource('pressArrow');
  assert.match(pressArrow, /new KeyboardEvent\(type,/);
  assert.match(pressArrow, /document\.dispatchEvent/);
  assert.match(pressArrow, /keyCode/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/site-routing.js';

const routing = globalThis.BlinkScrollRouting;
assert.ok(routing, 'shared routing helper should register on globalThis');

test('Instagram Reels are recognized with and without www', () => {
  assert.equal(routing.isFeedUrl('https://www.instagram.com/reels/Ddnrp1qLsl/'), true);
  assert.equal(routing.isFeedUrl('https://instagram.com/reels/Ddnrp1qLsl/'), true);
  assert.equal(routing.isFeedUrl('https://instagram.com/reel/Ddnrp1qLsl/'), true);
});

test('Instagram non-feed pages do not arm the camera', () => {
  assert.equal(routing.isFeedUrl('https://www.instagram.com/p/ABC123/'), false);
  assert.equal(routing.isFeedUrl('https://instagram.com/accounts/login/'), false);
});

test('TikTok supported feed routes are recognized on both host variants', () => {
  assert.equal(routing.isFeedUrl('https://www.tiktok.com/'), true);
  assert.equal(routing.isFeedUrl('https://tiktok.com/foryou'), true);
  assert.equal(routing.isFeedUrl('https://www.tiktok.com/@creator/video/123'), true);
});

test('YouTube Shorts routes are recognized on both host variants', () => {
  assert.equal(routing.isFeedUrl('https://www.youtube.com/shorts/abc'), true);
  assert.equal(routing.isFeedUrl('https://youtube.com/shorts'), true);
  assert.equal(routing.isFeedUrl('https://www.youtube.com/watch?v=abc'), false);
});

test('unrelated hosts and malformed URLs are never treated as supported feeds', () => {
  assert.equal(routing.isSupportedHostUrl('https://fakeinstagram.com/reels/123'), false);
  assert.equal(routing.isFeedUrl('not a url'), false);
  assert.equal(routing.isFeedUrl(undefined), false);
});

test('Facebook Reels are recognized on all host variants', () => {
  assert.equal(routing.siteForUrl('https://www.facebook.com/reels/'), 'facebook');
  assert.equal(routing.isFeedUrl('https://www.facebook.com/reels/'), true);
  assert.equal(routing.isFeedUrl('https://facebook.com/reel/123456/'), true);
  assert.equal(routing.isFeedUrl('https://m.facebook.com/reels/'), true);
});

test('Facebook non-reel pages do not arm the camera', () => {
  assert.equal(routing.isFeedUrl('https://www.facebook.com/'), false);
  assert.equal(routing.isFeedUrl('https://www.facebook.com/watch/'), false);
  assert.equal(routing.isFeedUrl('https://www.facebook.com/photo.php?fbid=1'), false);
});

test('URL patterns include apex and www hosts for each supported platform', () => {
  for (const pattern of [
    '*://instagram.com/*', '*://www.instagram.com/*',
    '*://tiktok.com/*', '*://www.tiktok.com/*',
    '*://youtube.com/*', '*://www.youtube.com/*',
    '*://facebook.com/*', '*://www.facebook.com/*', '*://m.facebook.com/*',
  ]) assert.ok(routing.urlPatterns.includes(pattern), `missing pattern ${pattern}`);
});


test('camera target is derived from the currently selected URL, not content-script heartbeat state', () => {
  const target = routing.resolveCameraTarget({
    activeTab: { id: 42, url: 'https://www.instagram.com/reels/Ddnrp1qLsl/' },
    enabled: true,
  });
  assert.deepEqual(target, { targetId: 42, reason: 'active-supported-feed' });
});

test('camera stops when the selected tab leaves a supported feed', () => {
  for (const url of [
    'https://www.instagram.com/p/ABC123/',
    'https://www.google.com/',
    'https://www.youtube.com/watch?v=abc',
  ]) {
    assert.deepEqual(routing.resolveCameraTarget({
      activeTab: { id: 42, url }, enabled: true,
    }), { targetId: null, reason: 'not-a-supported-feed' });
  }
});

test('camera target is disabled only when BlinkScroll is off, not when popup focus changes', () => {
  const activeTab = { id: 42, url: 'https://www.instagram.com/reels/Ddnrp1qLsl/' };
  assert.deepEqual(routing.resolveCameraTarget({ activeTab, enabled: false }), {
    targetId: null, reason: 'disabled',
  });
  // Legacy/browser focus flags are intentionally ignored. Dismissing the
  // toolbar popup must not stop the camera while this supported tab stays active.
  assert.deepEqual(routing.resolveCameraTarget({ activeTab, browserFocused: false, enabled: true }), {
    targetId: 42, reason: 'active-supported-feed',
  });
});

test('invalid or missing active tabs never arm the camera', () => {
  assert.deepEqual(routing.resolveCameraTarget({ enabled: true }), {
    targetId: null, reason: 'no-active-tab',
  });
  assert.deepEqual(routing.resolveCameraTarget({
    activeTab: { id: '42', url: 'https://www.instagram.com/reels/123/' },
    enabled: true,
  }), { targetId: null, reason: 'no-active-tab' });
});

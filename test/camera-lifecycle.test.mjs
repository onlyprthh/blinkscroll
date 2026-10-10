import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const background = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const routing = readFileSync(new URL('../src/site-routing.js', import.meta.url), 'utf8');
const popup = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');

function focusHandlerSource() {
  const start = background.indexOf('chrome.windows?.onFocusChanged?.addListener');
  assert.notEqual(start, -1, 'focus reconciliation listener exists');
  return background.slice(start);
}

test('WINDOW_ID_NONE focus transition does not stop or disarm camera', () => {
  const handler = focusHandlerSource();
  assert.match(handler, /if \(windowId === chrome\.windows\.WINDOW_ID_NONE\) return;/);
  assert.doesNotMatch(handler, /sendOffscreen|SYNC_ACTIVE_FEED|tabId:\s*null|stopCamera/,
    'focus-loss branch must not send a stop/disarm message');
});

test('camera eligibility is not gated by browser focus', () => {
  assert.match(routing, /function resolveCameraTarget\(\{ activeTab, enabled = true \}/);
  assert.doesNotMatch(routing, /if \(!browserFocused\)/);
});

test('popup describes status only and does not own camera lifetime', () => {
  assert.match(popup, /type: 'GET_STATE'/);
  assert.doesNotMatch(popup, /type:\s*['"]STOP_CAMERA['"]|type:\s*['"]SYNC_ACTIVE_FEED['"]|stopCamera\(/);
  assert.doesNotMatch(popup, /paused — browser focus/);
});

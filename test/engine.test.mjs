import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BlinkEngine, BlinkSampler, DEFAULT_PROFILE, earFromLandmarks, median,
  normalizeProfile, profileFromInterview, isPlausibleEAR,
} from '../src/engine.js';

const OPEN = 0.30;
const CLOSED = 0.10;

function blink(engine, closeAt, reopenAt, confidence = 1) {
  engine.update(OPEN, closeAt - 1, confidence);
  engine.update(CLOSED, closeAt, confidence);
  return engine.update(OPEN, reopenAt, confidence);
}

test('median handles odd, even, empty, and non-finite samples', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), 0);
  assert.equal(median([NaN, 4, Infinity, 2]), 3);
});

test('EAR returns a valid average and rejects malformed landmarks', () => {
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0, y: 0 }));
  const defineEye = (p1, p4, p2, p6, p3, p5) => {
    landmarks[p1] = { x: 0, y: 0 };
    landmarks[p4] = { x: 2, y: 0 };
    landmarks[p2] = { x: 0.5, y: 0.3 };
    landmarks[p6] = { x: 0.5, y: -0.3 };
    landmarks[p3] = { x: 1.5, y: 0.3 };
    landmarks[p5] = { x: 1.5, y: -0.3 };
  };
  defineEye(33, 133, 160, 144, 158, 153);
  defineEye(263, 362, 387, 373, 385, 380);
  assert.ok(Math.abs(earFromLandmarks(landmarks) - 0.3) < 1e-9);
  assert.equal(earFromLandmarks([]), null);
  for (const index of [160, 144, 158, 153, 387, 373, 385, 380]) {
    landmarks[index] = { x: landmarks[index].x, y: 0 };
  }
  assert.equal(earFromLandmarks(landmarks), 0);
  assert.equal(isPlausibleEAR(0), true, 'fully closed eyes are a valid face frame');
  assert.equal(isPlausibleEAR(NaN), false);
  assert.equal(isPlausibleEAR(-0.01), false);
  assert.equal(isPlausibleEAR(0.8), false);
  landmarks[33] = { x: NaN, y: 0 };
  assert.equal(earFromLandmarks(landmarks), null);
});

test('sampler emits the completed blink duration', () => {
  const sampler = new BlinkSampler(0.2);
  assert.deepEqual(sampler.feed(OPEN, 0), []);
  assert.deepEqual(sampler.feed(CLOSED, 10), []);
  assert.deepEqual(sampler.feed(OPEN, 180), [
    { type: 'blink', durationMs: 170, atMs: 180 },
  ]);
});

test('natural blink does not navigate', () => {
  const engine = new BlinkEngine();
  assert.deepEqual(blink(engine, 10, 140), []);
  assert.deepEqual(engine.update(OPEN, 1000), []);
});

test('single deliberate blink fires only after the double-blink window', () => {
  const engine = new BlinkEngine();
  assert.deepEqual(blink(engine, 10, 260), []);
  assert.deepEqual(engine.update(OPEN, 700), []);
  assert.deepEqual(engine.update(OPEN, 711), [{ type: 'single', atMs: 711 }]);
});

test('double blink emits previous only, never next then previous', () => {
  const engine = new BlinkEngine();
  assert.deepEqual(blink(engine, 10, 260), []);
  assert.deepEqual(blink(engine, 300, 550), [{ type: 'double', atMs: 550 }]);
  assert.deepEqual(engine.update(OPEN, 800), []);
});

test('long close fires once and clears suppression on reopen during cooldown', () => {
  const engine = new BlinkEngine();
  engine.update(OPEN, 0);
  engine.update(CLOSED, 10);
  assert.deepEqual(engine.update(CLOSED, 1410), [
    { type: 'long', durationMs: 1400, atMs: 1410 },
  ]);
  assert.deepEqual(engine.update(OPEN, 1450), []);
  assert.equal(engine.longFired, false);
  assert.deepEqual(blink(engine, 2700, 2950), []);
  assert.deepEqual(engine.update(OPEN, 3400), [{ type: 'single', atMs: 3400 }]);
});

test('brief face loss preserves an in-progress blink', () => {
  const engine = new BlinkEngine();
  engine.update(OPEN, 0);
  engine.update(CLOSED, 40); // eyes close
  engine.update(CLOSED, 80, 0); // tracking drops mid-blink (grace)
  engine.update(CLOSED, 120, 0);
  engine.update(CLOSED, 160, 0);
  assert.equal(engine.suspended, false);
  engine.update(OPEN, 300); // face back, eyes open: blink duration 260ms
  assert.equal(engine.pendingSingleAt, 300);
  assert.deepEqual(engine.update(OPEN, 750), [{ type: 'single', atMs: 750 }]);
});

test('sustained face loss cancels a pending single instead of firing it later', () => {
  const engine = new BlinkEngine();
  assert.deepEqual(blink(engine, 10, 260), []);
  for (let t = 300; t < 300 + 6 * 40; t += 40) {
    assert.deepEqual(engine.update(OPEN, t, 0), []);
  }
  assert.equal(engine.pendingSingleAt, 0);
  assert.equal(engine.suspended, true);
  assert.deepEqual(engine.update(OPEN, 1200, 1), []);
});

test('inactive/disabled input cannot emit an expired pending gesture', () => {
  const engine = new BlinkEngine();
  assert.deepEqual(blink(engine, 10, 260), []);
  assert.deepEqual(engine.update(OPEN, 800, 0), []);
});

test('cooldown suppresses rapid repeat gestures', () => {
  const engine = new BlinkEngine();
  blink(engine, 10, 260);
  assert.deepEqual(engine.update(OPEN, 711), [{ type: 'single', atMs: 711 }]);
  assert.deepEqual(blink(engine, 800, 1050), []);
  assert.deepEqual(engine.update(OPEN, 1900), []);
});

test('stored profiles are bounded and malformed fields fall back safely', () => {
  const engine = new BlinkEngine({
    earOpenMedian: NaN,
    singleMinMs: 10000,
    singleMaxMs: 2,
    doubleGapMs: -1,
    longMs: -5,
    minConfidence: 99,
  });
  assert.equal(engine.p.earOpenMedian, DEFAULT_PROFILE.earOpenMedian);
  assert.equal(engine.p.singleMinMs, 1200);
  assert.ok(engine.p.singleMaxMs >= engine.p.singleMinMs + 50);
  assert.equal(engine.p.doubleGapMs, 200);
  assert.equal(engine.p.longMs, 800);
  assert.equal(engine.p.minConfidence, 1);
});

test('profileFromInterview handles empty or invalid measurements', () => {
  const profile = profileFromInterview({ singleMs: [NaN], doubleGaps: [], longMs: [] });
  assert.ok(profile.singleMinMs >= 120);
  assert.ok(profile.singleMaxMs > profile.singleMinMs);
  assert.ok(Number.isFinite(profile.calibratedAt));
});

test('non-finite frame values cannot create a blink', () => {
  const sampler = new BlinkSampler();
  sampler.feed(OPEN, 10);
  sampler.feed(CLOSED, 20);
  assert.deepEqual(sampler.feed(NaN, 40), []);
  assert.deepEqual(sampler.feed(OPEN, 60), [{ type: 'blink', durationMs: 40, atMs: 60 }]);
});

// Synthetic-EAR unit tests for the gesture state machine.
// Streams fake eye-aspect-ratio frames (30fps) through BlinkEngine and assert
// the exact gesture sequence. No camera, no MediaPipe needed.
import { strict as assert } from 'node:assert';
import { BlinkEngine, DEFAULT_PROFILE, profileFromInterview, median } from '../src/engine.js';

const DT = 1000 / 30; // 30 fps
const OPEN = 0.28, CLOSED = 0.10;

const P = {
  ...DEFAULT_PROFILE,
  naturalMs: 130, singleMinMs: 220, singleMaxMs: 900,
  doubleGapMs: 450, longMs: 1400, cooldownMs: 1200, earOpenMedian: 0.28,
};

/** closedWindows: [[startMs,endMs],...]. conf: fixed confidence or fn(t). */
function run(closedWindows, { profile = P, conf = 1, padMs = 2500 } = {}) {
  const eng = new BlinkEngine(profile);
  const events = [];
  const end = (closedWindows.length ? Math.max(...closedWindows.map(w => w[1])) : 0) + padMs;
  for (let t = 0; t <= end; t += DT) {
    const closed = closedWindows.some(([s, e]) => t >= s && t < e);
    const c = typeof conf === 'function' ? conf(t) : conf;
    for (const e of eng.update(closed ? CLOSED : OPEN, t, c)) events.push(e);
  }
  return events;
}
const types = evts => evts.map(e => e.type);

// 1. Natural blinks (120ms, every 3s) must NEVER fire.
{
  const wins = [];
  for (let i = 0; i < 10; i++) wins.push([i * 3000, i * 3000 + 120]);
  const evts = run(wins);
  assert.deepEqual(types(evts), [], 'natural blinks must not fire gestures');
  console.log('ok 1 - natural blinks are ignored');
}

// 2. Three deliberate single blinks (300ms) -> three 'single'.
{
  const evts = run([[1000, 1300], [4000, 4300], [7000, 7300]]);
  assert.deepEqual(types(evts), ['single', 'single', 'single']);
  console.log('ok 2 - deliberate singles fire next');
}

// 3. Double blink (250ms blinks, 400ms reopen-to-reopen gap) -> one 'double', zero 'single'.
{
  const evts = run([[1000, 1250], [1400, 1650]]);
  assert.deepEqual(types(evts), ['double'], 'double blink must not also emit single');
  console.log('ok 3 - double blink fires previous only');
}

// 4. Long close (1500ms) -> one 'long', nothing else.
{
  const evts = run([[1000, 2500]]);
  assert.deepEqual(types(evts), ['long']);
  console.log('ok 4 - long close fires pause toggle only');
}

// 5. Two deliberate singles well apart (> doubleGapMs + cooldown) -> two singles.
{
  const evts = run([[1000, 1250], [3500, 3750]]);
  assert.deepEqual(types(evts), ['single', 'single']);
  console.log('ok 5 - spaced deliberate blinks are two singles, not a double');
}

// 5b. Two blinks 650ms apart: definitively not a double, but the second lands
// inside the post-gesture cooldown, so only one 'single' fires. Documented,
// not a bug: it stops eyelid flutter from machine-gunning reels.
{
  const evts = run([[1000, 1250], [1900, 2150]]);
  assert.deepEqual(types(evts), ['single']);
  console.log('ok 5b - rapid re-blink inside cooldown is swallowed (no machine-gun)');
}

// 6. Low confidence during a deliberate blink -> suspended, zero gestures.
{
  const evts = run([[1000, 1300]], { conf: t => (t > 500 && t < 2000 ? 0.1 : 1) });
  assert.deepEqual(types(evts), [], 'must not fire while blind');
  console.log('ok 6 - low confidence suspends firing');
}

// 7. Cooldown: second deliberate blink inside the 1200ms cooldown is swallowed.
{
  const evts = run([[1000, 1300], [1600, 1900]]);
  assert.deepEqual(types(evts), ['single'], 'cooldown must swallow the machine-gun blink');
  console.log('ok 7 - cooldown prevents gesture machine-gunning');
}

// 8. Involuntary blinks still adapt the baseline upward without firing.
{
  const eng = new BlinkEngine(P);
  for (let t = 0; t < 30000; t += DT) {
    const cyc = t % 3000;
    const closed = cyc < 200; // 200ms "tired eyes" blinks, still < singleMinMs
    eng.update(closed ? CLOSED : OPEN, t, 1);
  }
  const st = eng.status(30000);
  assert.ok(st.baselineMs > 130, `baseline should drift up, got ${st.baselineMs}`);
  assert.ok(st.singleMinMs >= st.baselineMs + 80, 'deliberate floor stays above baseline');
  console.log(`ok 8 - adaptive baseline drifts (130 -> ${st.baselineMs}ms), floor at ${st.singleMinMs}ms`);
}

// 9. profileFromInterview turns raw measurements into a sane profile.
{
  const prof = profileFromInterview({
    earOpenMedian: 0.3,
    naturalMs: 140,
    singleMs: [280, 300, 260, 320, 290],
    doubleGaps: [380, 420, 400],
    longMs: [1500, 1600],
  });
  assert.ok(prof.singleMinMs < 290 && prof.singleMinMs >= 180, `singleMin ${prof.singleMinMs}`);
  assert.ok(prof.singleMaxMs >= 950, `singleMax ${prof.singleMaxMs}`);
  assert.ok(prof.doubleGapMs >= 350 && prof.doubleGapMs <= 900, `doubleGap ${prof.doubleGapMs}`);
  assert.ok(prof.longMs >= 1000 && prof.longMs <= 2000, `long ${prof.longMs}`);
  assert.equal(prof.naturalMs, 140);
  console.log('ok 9 - interview measurements become a sane profile:', JSON.stringify({
    singleMinMs: prof.singleMinMs, singleMaxMs: prof.singleMaxMs,
    doubleGapMs: prof.doubleGapMs, longMs: prof.longMs,
  }));
}

// 10. median() sanity.
{
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), 0);
  console.log('ok 10 - median helper');
}

console.log('\nAll 10 engine tests passed.');

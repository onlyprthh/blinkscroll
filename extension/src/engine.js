// engine.js — BlinkScroll gesture state machine.
// Pure logic: no DOM, no chrome.* APIs. Runs in the offscreen document live,
// and is unit-tested in node with synthetic EAR streams (see test/engine.test.mjs).
//
// Gesture map (v1, locked 2026-10-10):
//   single deliberate blink  -> next reel
//   double blink (2 in window)-> previous reel
//   eyes closed >= longMs    -> pause / resume toggle
// Involuntary blinks (below the personal singleMinMs floor) never fire.

// --- Eye Aspect Ratio -------------------------------------------------------
// MediaPipe FaceLandmarker gives 478 landmarks. Standard EAR index sets:
const LEFT_EYE = { p1: 33, p4: 133, p2: 160, p6: 144, p3: 158, p5: 153 };
const RIGHT_EYE = { p1: 263, p4: 362, p2: 387, p6: 373, p3: 385, p5: 380 };

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function eyeAspectRatio(lm, eye) {
  const p1 = lm[eye.p1], p2 = lm[eye.p2], p3 = lm[eye.p3];
  const p4 = lm[eye.p4], p5 = lm[eye.p5], p6 = lm[eye.p6];
  if (!p1 || !p2 || !p3 || !p4 || !p5 || !p6) return null;
  const vertical = dist(p2, p6) + dist(p3, p5);
  const horizontal = 2 * dist(p1, p4);
  return horizontal === 0 ? null : vertical / horizontal;
}

/** Average EAR across both eyes. null when landmarks are unusable. */
export function earFromLandmarks(lm) {
  const l = eyeAspectRatio(lm, LEFT_EYE);
  const r = eyeAspectRatio(lm, RIGHT_EYE);
  if (l == null || r == null) return null;
  return (l + r) / 2;
}

export function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// --- BlinkSampler -----------------------------------------------------------
// Low-level open/closed tracking. Emits raw blink events; shared by the live
// engine and the interview page (which needs raw samples, not gestures).
export class BlinkSampler {
  constructor(earClosedThreshold = 0.2) {
    this.threshold = earClosedThreshold;
    this.state = 'open'; // 'open' | 'closed'
    this.closeStart = 0;
  }
  setThreshold(t) { this.threshold = t; }
  isClosed() { return this.state === 'closed'; }
  currentCloseDuration(nowMs) {
    return this.state === 'closed' ? nowMs - this.closeStart : 0;
  }
  /** Feed one EAR sample. Returns [{type:'blink', durationMs, atMs}]. */
  feed(ear, nowMs) {
    const events = [];
    if (ear == null) return events;
    const closed = ear < this.threshold;
    if (this.state === 'open' && closed) {
      this.state = 'closed';
      this.closeStart = nowMs;
    } else if (this.state === 'closed' && !closed) {
      events.push({ type: 'blink', durationMs: nowMs - this.closeStart, atMs: nowMs });
      this.state = 'open';
    }
    return events;
  }
}

// --- Profile ----------------------------------------------------------------
export const DEFAULT_PROFILE = {
  version: 1,
  earOpenMedian: 0.28,  // learned in interview step 0 (typical open-eye EAR)
  earClosedFactor: 0.72, // closed when EAR < earOpenMedian * factor
  naturalMs: 130,        // median involuntary blink (interview step 0)
  singleMinMs: 220,      // deliberate single-blink lower bound
  singleMaxMs: 900,      // deliberate single-blink upper bound
  doubleGapMs: 450,       // max reopen-to-reopen gap counting as a double blink
  longMs: 1400,          // eyes-closed duration => pause/resume toggle
  cooldownMs: 1200,      // quiet period after any fired gesture
  minConfidence: 0.5,    // below this, gesture firing is suspended entirely
  calibratedAt: 0,
};

/** Build a personal profile from interview measurements. */
export function profileFromInterview(m) {
  const singleMed = median(m.singleMs || []);
  const gapMed = median(m.doubleGaps || []);
  const longMed = median(m.longMs || []);
  return {
    version: 1,
    earOpenMedian: m.earOpenMedian || 0.28,
    earClosedFactor: 0.72,
    naturalMs: Math.round(m.naturalMs || 130),
    singleMinMs: Math.round(Math.max(180, singleMed * 0.7)),
    singleMaxMs: Math.round(Math.max(950, singleMed * 1.8)),
    doubleGapMs: Math.round(Math.min(900, Math.max(350, gapMed + 200))),
    longMs: Math.round(Math.min(2000, Math.max(1000, longMed * 0.9))),
    cooldownMs: 1200,
    minConfidence: 0.5,
    calibratedAt: Date.now(),
  };
}

// --- BlinkEngine ------------------------------------------------------------
export class BlinkEngine {
  constructor(profile = {}) {
    this.p = { ...DEFAULT_PROFILE, ...profile };
    this.sampler = new BlinkSampler(this.p.earOpenMedian * this.p.earClosedFactor);
    this.reset();
  }

  reset() {
    this.sampler.state = 'open';
    this.pendingSingleAt = 0; // reopen-time of a blink awaiting double-check (0 = none)
    this.cooldownUntil = 0;
    this.longFired = false;
    this.baselineMs = this.p.naturalMs;
    this.singleMinMs = this.p.singleMinMs;
    this.openEarSamples = [];
    this.framesSinceEarUpdate = 0;
    this.suspended = false;
  }

  /**
   * Feed one frame. Returns gesture events:
   *   {type:'single'|'double'|'long', atMs, durationMs?}
   * nowMs must be monotonically increasing (ms).
   */
  update(ear, nowMs, confidence = 1) {
    const events = [];

    // 1. A pending single whose double-window expired becomes a confirmed single.
    //    (We wait doubleGapMs after the first blink to see if a second arrives —
    //    firing instantly would make every double-blink do next-then-previous.)
    if (this.pendingSingleAt && nowMs - this.pendingSingleAt >= this.p.doubleGapMs) {
      this.pendingSingleAt = 0;
      events.push({ type: 'single', atMs: nowMs });
      this.cooldownUntil = nowMs + this.p.cooldownMs;
    }

    // 2. Confidence gate: blind (dark room, face out of frame) => suspend firing.
    //    Never guess — a wrong scroll is worse than no scroll.
    if (confidence < this.p.minConfidence) {
      if (!this.suspended) {
        this.suspended = true;
        this.pendingSingleAt = 0;
        this.sampler.state = 'open'; // drop stale state so resume can't misfire
      }
      return events;
    }
    this.suspended = false;

    const inCooldown = nowMs < this.cooldownUntil;

    // 3. Slowly adapt the closed-EAR threshold to lighting/angle drift.
    if (ear != null && this.sampler.state === 'open' && ear >= this.sampler.threshold) {
      this.openEarSamples.push(ear);
      if (this.openEarSamples.length > 240) this.openEarSamples.shift();
      if (++this.framesSinceEarUpdate >= 60) {
        this.framesSinceEarUpdate = 0;
        const m = median(this.openEarSamples);
        if (m > 0) {
          this.sampler.setThreshold(
            Math.min(0.3, Math.max(0.12, m * this.p.earClosedFactor))
          );
        }
      }
    }

    // 4. Long close fires while the eyes are still shut (no need to wait for reopen).
    if (this.sampler.isClosed()) {
      const dur = this.sampler.currentCloseDuration(nowMs);
      if (!inCooldown && !this.longFired && dur >= this.p.longMs) {
        this.longFired = true;
        this.pendingSingleAt = 0; // a long close cancels any pending single
        events.push({ type: 'long', durationMs: Math.round(dur), atMs: nowMs });
        this.cooldownUntil = nowMs + this.p.cooldownMs;
      }
    }

    // 5. Classify completed blinks.
    for (const e of this.sampler.feed(ear, nowMs)) {
      if (inCooldown) continue;
      if (this.longFired) { this.longFired = false; continue; } // reopen after a long close
      const dur = e.durationMs;
      if (dur < this.singleMinMs) { this.adaptBaseline(dur); continue; } // involuntary
      if (dur > this.p.singleMaxMs) continue; // too long for single, too short for long: ignore
      if (this.pendingSingleAt && e.atMs - this.pendingSingleAt <= this.p.doubleGapMs) {
        this.pendingSingleAt = 0;
        events.push({ type: 'double', atMs: e.atMs });
        this.cooldownUntil = e.atMs + this.p.cooldownMs;
      } else {
        this.pendingSingleAt = e.atMs;
      }
    }
    return events;
  }

  /** Nudge the involuntary-blink baseline from clean natural samples. */
  adaptBaseline(dur) {
    if (dur < 60 || dur > 260) return;
    this.baselineMs = 0.92 * this.baselineMs + 0.08 * dur;
    this.baselineMs = Math.min(260, Math.max(80, this.baselineMs));
    // The deliberate floor always stays clearly above the involuntary baseline,
    // so watering eyes can never hijack the feed.
    this.singleMinMs = Math.max(this.p.singleMinMs, this.baselineMs + 80);
  }

  status(nowMs) {
    return {
      eyesClosed: this.sampler.isClosed(),
      suspended: this.suspended,
      coolingDown: nowMs < this.cooldownUntil,
      baselineMs: Math.round(this.baselineMs),
      singleMinMs: Math.round(this.singleMinMs),
      earThreshold: +this.sampler.threshold.toFixed(3),
    };
  }
}

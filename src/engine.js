// BlinkScroll gesture state machine — intentionally DOM/chrome API free.
// Synthetic frame streams are tested with Node's built-in test runner.

const LEFT_EYE = { p1: 33, p4: 133, p2: 160, p6: 144, p3: 158, p5: 153 };
const RIGHT_EYE = { p1: 263, p4: 362, p2: 387, p6: 373, p3: 385, p5: 380 };

function dist(a, b) {
  if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(a.y) ||
      !Number.isFinite(b.x) || !Number.isFinite(b.y)) return NaN;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function eyeAspectRatio(landmarks, eye) {
  if (!Array.isArray(landmarks)) return null;
  const p1 = landmarks[eye.p1], p2 = landmarks[eye.p2], p3 = landmarks[eye.p3];
  const p4 = landmarks[eye.p4], p5 = landmarks[eye.p5], p6 = landmarks[eye.p6];
  if (!p1 || !p2 || !p3 || !p4 || !p5 || !p6) return null;
  const vertical = dist(p2, p6) + dist(p3, p5);
  const horizontal = 2 * dist(p1, p4);
  if (!Number.isFinite(vertical) || !Number.isFinite(horizontal) || horizontal <= 0) return null;
  const ear = vertical / horizontal;
  return Number.isFinite(ear) && ear >= 0 ? ear : null;
}

/** Average EAR across both eyes; null means the landmarks are unusable. */
export function earFromLandmarks(landmarks) {
  const left = eyeAspectRatio(landmarks, LEFT_EYE);
  const right = eyeAspectRatio(landmarks, RIGHT_EYE);
  if (left == null || right == null) return null;
  const ear = (left + right) / 2;
  return Number.isFinite(ear) ? ear : null;
}

// A near-zero EAR is a valid closed-eye frame, not proof that the face vanished.
export function isPlausibleEAR(ear) {
  return Number.isFinite(ear) && ear >= 0 && ear < 0.8;
}

export function median(values) {
  if (!Array.isArray(values)) return 0;
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const clamp = (value, min, max, fallback) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

// Don't trust storage blindly: profiles may be old, partial or manually edited.
export function normalizeProfile(profile = {}) {
  const source = profile && typeof profile === 'object' ? profile : {};
  const p = { ...DEFAULT_PROFILE, ...source };
  p.version = 1;
  p.earOpenMedian = clamp(p.earOpenMedian, 0.08, 0.55, DEFAULT_PROFILE.earOpenMedian);
  p.earClosedFactor = clamp(p.earClosedFactor, 0.4, 0.9, DEFAULT_PROFILE.earClosedFactor);
  p.naturalMs = Math.round(clamp(p.naturalMs, 60, 400, DEFAULT_PROFILE.naturalMs));
  p.singleMinMs = Math.round(clamp(p.singleMinMs, 120, 1200, DEFAULT_PROFILE.singleMinMs));
  p.singleMaxMs = Math.round(clamp(p.singleMaxMs, p.singleMinMs + 50, 1800, DEFAULT_PROFILE.singleMaxMs));
  p.doubleGapMs = Math.round(clamp(p.doubleGapMs, 200, 1200, DEFAULT_PROFILE.doubleGapMs));
  p.longMs = Math.round(clamp(p.longMs, 800, 4000, DEFAULT_PROFILE.longMs));
  p.cooldownMs = Math.round(clamp(p.cooldownMs, 300, 5000, DEFAULT_PROFILE.cooldownMs));
  p.minConfidence = clamp(p.minConfidence, 0.1, 1, DEFAULT_PROFILE.minConfidence);
  p.calibratedAt = clamp(p.calibratedAt, 0, Number.MAX_SAFE_INTEGER, 0);
  return p;
}

// --- BlinkSampler -----------------------------------------------------------
export class BlinkSampler {
  constructor(earClosedThreshold = 0.2) {
    this.threshold = clamp(earClosedThreshold, 0.01, 0.8, 0.2);
    this.state = 'open';
    this.closeStart = 0;
  }

  setThreshold(threshold) {
    this.threshold = clamp(threshold, 0.01, 0.8, this.threshold);
  }

  isClosed() { return this.state === 'closed'; }

  currentCloseDuration(nowMs) {
    return this.state === 'closed' && Number.isFinite(nowMs)
      ? Math.max(0, nowMs - this.closeStart) : 0;
  }

  /** Feed one EAR sample; returns zero or one {type, durationMs, atMs} event. */
  feed(ear, nowMs) {
    if (!Number.isFinite(nowMs) || !Number.isFinite(ear) || ear < 0) return [];
    const closed = ear < this.threshold;
    if (this.state === 'open' && closed) {
      this.state = 'closed';
      this.closeStart = nowMs;
    } else if (this.state === 'closed' && !closed) {
      const durationMs = nowMs - this.closeStart;
      this.state = 'open';
      this.closeStart = 0;
      if (durationMs >= 0) return [{ type: 'blink', durationMs, atMs: nowMs }];
    }
    return [];
  }
}

// --- Profile ----------------------------------------------------------------
export const DEFAULT_PROFILE = {
  version: 1,
  earOpenMedian: 0.28,
  earClosedFactor: 0.72,
  naturalMs: 130,
  singleMinMs: 220,
  singleMaxMs: 900,
  doubleGapMs: 450,
  longMs: 1400,
  cooldownMs: 1200,
  minConfidence: 0.5,
  calibratedAt: 0,
};

/** Build a bounded personal profile from interview measurements. */
export function profileFromInterview(measurements = {}) {
  const singleMed = median(measurements.singleMs || []);
  const gapMed = median(measurements.doubleGaps || []);
  const longMed = median(measurements.longMs || []);
  return normalizeProfile({
    version: 1,
    earOpenMedian: measurements.earOpenMedian || DEFAULT_PROFILE.earOpenMedian,
    earClosedFactor: 0.72,
    naturalMs: Math.round(measurements.naturalMs || DEFAULT_PROFILE.naturalMs),
    singleMinMs: Math.round(Math.max(180, singleMed * 0.7)),
    singleMaxMs: Math.round(Math.max(950, singleMed * 1.8)),
    doubleGapMs: Math.round(Math.min(900, Math.max(350, gapMed + 200))),
    longMs: Math.round(Math.min(2000, Math.max(1000, longMed * 0.9))),
    cooldownMs: DEFAULT_PROFILE.cooldownMs,
    minConfidence: DEFAULT_PROFILE.minConfidence,
    calibratedAt: Date.now(),
  });
}

// --- BlinkEngine ------------------------------------------------------------
export class BlinkEngine {
  constructor(profile = {}) {
    this.p = normalizeProfile(profile);
    this.sampler = new BlinkSampler(this.p.earOpenMedian * this.p.earClosedFactor);
    this.reset();
  }

  reset() {
    this.sampler.state = 'open';
    this.sampler.closeStart = 0;
    this.pendingSingleAt = 0;
    this.cooldownUntil = 0;
    this.longFired = false;
    this.lowConfidenceFrames = 0;
    this.baselineMs = this.p.naturalMs;
    this.singleMinMs = this.p.singleMinMs;
    this.openEarSamples = [];
    this.framesSinceEarUpdate = 0;
    this.suspended = false;
  }

  /**
   * Feed one frame. Emits single/double/long gesture events.
   * nowMs must be monotonic milliseconds (e.g. performance.now()).
   */
  update(ear, nowMs, confidence = 1) {
    if (!Number.isFinite(nowMs)) return [];
    const safeEar = Number.isFinite(ear) && ear >= 0 ? ear : null;
    const safeConfidence = Number.isFinite(confidence) ? clamp(confidence, 0, 1, 0) : 0;

    // Gate first: an expired pending single must never fire on a lost face,
    // inactive tab, or disabled extension. Discard rather than replay it later.
    // A hard blink or quick head turn can momentarily lose landmarks — hold the
    // sampler state for a few frames instead of discarding an in-progress
    // blink; only suspend after sustained loss.
    if (safeConfidence < this.p.minConfidence) {
      this.lowConfidenceFrames++;
      if (this.lowConfidenceFrames < 6) return [];
      if (!this.suspended) {
        this.suspended = true;
        this.pendingSingleAt = 0;
        this.longFired = false;
        this.sampler.state = 'open';
        this.sampler.closeStart = 0;
      }
      return [];
    }
    this.lowConfidenceFrames = 0;
    this.suspended = false;

    const events = [];
    if (this.pendingSingleAt && nowMs - this.pendingSingleAt >= this.p.doubleGapMs) {
      this.pendingSingleAt = 0;
      events.push({ type: 'single', atMs: nowMs });
      this.cooldownUntil = nowMs + this.p.cooldownMs;
    }

    const inCooldown = nowMs < this.cooldownUntil;

    // Slow lighting/angle adaptation based on confident open-eye frames only.
    if (safeEar != null && this.sampler.state === 'open' && safeEar >= this.sampler.threshold) {
      this.openEarSamples.push(safeEar);
      if (this.openEarSamples.length > 240) this.openEarSamples.shift();
      if (++this.framesSinceEarUpdate >= 60) {
        this.framesSinceEarUpdate = 0;
        const openMedian = median(this.openEarSamples);
        if (openMedian > 0) {
          this.sampler.setThreshold(
            Math.min(0.3, Math.max(0.12, openMedian * this.p.earClosedFactor))
          );
        }
      }
    }

    // Long close fires while shut; it does not need to wait for reopening.
    if (this.sampler.isClosed()) {
      const durationMs = this.sampler.currentCloseDuration(nowMs);
      if (!inCooldown && !this.longFired && durationMs >= this.p.longMs) {
        this.longFired = true;
        this.pendingSingleAt = 0;
        events.push({ type: 'long', durationMs: Math.round(durationMs), atMs: nowMs });
        this.cooldownUntil = nowMs + this.p.cooldownMs;
      }
    }

    for (const event of this.sampler.feed(safeEar, nowMs)) {
      // Clear the long-close suppression on reopening even during cooldown;
      // otherwise the first deliberate blink after a pause gets swallowed.
      if (this.longFired) {
        this.longFired = false;
        continue;
      }
      if (inCooldown) continue;
      const durationMs = event.durationMs;
      if (durationMs < this.singleMinMs) {
        this.adaptBaseline(durationMs);
        continue;
      }
      if (durationMs > this.p.singleMaxMs) continue;

      if (this.pendingSingleAt && event.atMs - this.pendingSingleAt <= this.p.doubleGapMs) {
        this.pendingSingleAt = 0;
        events.push({ type: 'double', atMs: event.atMs });
        this.cooldownUntil = event.atMs + this.p.cooldownMs;
      } else {
        this.pendingSingleAt = event.atMs;
      }
    }
    return events;
  }

  adaptBaseline(durationMs) {
    if (durationMs < 60 || durationMs > 260) return;
    this.baselineMs = 0.92 * this.baselineMs + 0.08 * durationMs;
    this.baselineMs = Math.min(260, Math.max(80, this.baselineMs));
    this.singleMinMs = Math.max(this.p.singleMinMs, this.baselineMs + 80);
  }

  status(nowMs) {
    return {
      eyesClosed: this.sampler.isClosed(),
      suspended: this.suspended,
      coolingDown: Number.isFinite(nowMs) && nowMs < this.cooldownUntil,
      baselineMs: Math.round(this.baselineMs),
      singleMinMs: Math.round(this.singleMinMs),
      earThreshold: +this.sampler.threshold.toFixed(3),
    };
  }
}

// offscreen.js — local webcam + blink classifier. Video frames stay on-device.
import { BlinkEngine } from './src/engine.js';
import { SandboxDetector } from './src/sandbox-client.js';

let detector = null;
let detectorReady = false;
let detectorFailed = null;
let detectorPromise = null;
let stream = null;
let video = null;
let rafId = 0;
let lastVideoTime = -1;
let inFlightGeneration = null;
let cameraStartPromise = null;
let cameraGeneration = 0;
let engine = new BlinkEngine();
let activeTabId = null;
let enabled = true;
let lastGesture = null;
let cameraError = null;

function init() {
  video = document.getElementById('cam');

  // Register before starting MediaPipe; loading the local model can take seconds.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !['SYNC_ACTIVE_FEED', 'PROFILE_UPDATED', 'GET_STATUS'].includes(msg.type)) {
      return false;
    }

    if (msg.type === 'SYNC_ACTIVE_FEED') {
      const nextTabId = Number.isInteger(msg.tabId) ? msg.tabId : null;
      const nextEnabled = msg.enabled !== false;
      const changed = nextTabId !== activeTabId || nextEnabled !== enabled;
      activeTabId = nextEnabled ? nextTabId : null;
      enabled = nextEnabled;
      if (msg.profile) engine = new BlinkEngine(msg.profile);

      if (changed) {
        // Every requested target gets a generation. An older, still-pending
        // getUserMedia request is never allowed to re-arm a tab that is no
        // longer active; its resulting stream is stopped when it resolves.
        // Detach the old promise on invalidation: getUserMedia itself cannot
        // be aborted, and an unanswered prompt must not block the next tab's
        // attempt forever. Old completions cannot clear a newer promise.
        cameraGeneration += 1;
        cameraStartPromise = null;
        engine.reset();
      }

      if (activeTabId === null || !enabled) {
        stopCamera();
        cameraError = null;
        sendResponse({ ok: true });
      } else {
        cameraError = null;
        // Acknowledge receipt immediately; GET_STATUS exposes whether the
        // asynchronous camera startup is still pending or has actually begun.
        const requestedGeneration = cameraGeneration;
        void startCamera(requestedGeneration).catch(err => {
          if (requestedGeneration === cameraGeneration && activeTabId !== null && enabled) {
            cameraError = err?.name || 'CameraError';
            console.warn('[BlinkScroll] camera start failed:', err?.name, err?.message);
          }
        });
        sendResponse({ ok: true });
      }
      return false;
    }

    if (msg.type === 'PROFILE_UPDATED') {
      if (msg.profile) engine = new BlinkEngine(msg.profile);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'GET_STATUS') {
      sendResponse({
        ok: true,
        modelReady: detectorReady && !detectorFailed,
        detectorError: detectorFailed,
        cameraOn: !!stream && stream.getTracks().some(track => track.readyState === 'live'),
        cameraStarting: !!cameraStartPromise,
        cameraError,
        activeTabId,
        armedCount: activeTabId === null ? 0 : 1,
        enabled,
        lastGesture,
        engine: engine.status(performance.now()),
      });
      return false;
    }
    return false;
  });

  detectorPromise = initDetector();
}

async function initDetector() {
  try {
    detector = new SandboxDetector(document.getElementById('detector'));
    await detector.ready;
    detectorFailed = detector.failed;
    detectorReady = !detectorFailed;
    if (detectorFailed) console.error('[BlinkScroll] detector failed:', detectorFailed);
  } catch (err) {
    detectorFailed = String(err?.message || err);
    detectorReady = false;
    console.error('[BlinkScroll] detector initialization failed:', err);
  }
}

async function startCamera(generation) {
  if (generation !== cameraGeneration || !enabled || activeTabId === null) return;
  if (stream && stream.getTracks().some(track => track.readyState === 'live')) return;

  // Coalesce concurrent starts, but after waiting re-check the generation and
  // current stream so a tab switch during getUserMedia cannot strand the new tab.
  while (cameraStartPromise) {
    const pending = cameraStartPromise;
    try { await pending; } catch { /* The caller that started it records the error. */ }
    if (generation !== cameraGeneration || !enabled || activeTabId === null) return;
    if (stream && stream.getTracks().some(track => track.readyState === 'live')) return;
    if (cameraStartPromise === pending) cameraStartPromise = null;
  }

  if (generation !== cameraGeneration || !enabled || activeTabId === null) return;
  const attempt = startCameraForGeneration(generation);
  cameraStartPromise = attempt;
  try {
    await attempt;
  } catch (err) {
    if (generation === cameraGeneration && enabled && activeTabId !== null) {
      cameraError = err?.name || 'CameraError';
    }
    throw err;
  } finally {
    if (cameraStartPromise === attempt) cameraStartPromise = null;
  }
}

async function startCameraForGeneration(generation) {
  await detectorPromise;
  if (generation !== cameraGeneration || !enabled || activeTabId === null) return;
  if (detectorFailed || !detector) {
    const error = new Error(detectorFailed || 'Face detector is unavailable');
    error.name = 'DetectorError';
    throw error;
  }

  const newStream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: 'user' },
    audio: false,
  });

  // The selected feed may have changed while the permission request was open.
  if (generation !== cameraGeneration || !enabled || activeTabId === null) {
    newStream.getTracks().forEach(track => track.stop());
    return;
  }

  stream = newStream;
  try {
    video.srcObject = newStream;
    await video.play();
    // Also guard the await boundary around video.play(). stopCamera() may have
    // run while the play promise was pending.
    if (generation !== cameraGeneration || !enabled || activeTabId === null || stream !== newStream) {
      newStream.getTracks().forEach(track => track.stop());
      if (stream === newStream) stream = null;
      if (video.srcObject === newStream) video.srcObject = null;
      return;
    }
    cameraError = null;
    lastVideoTime = -1;
    loop();
  } catch (err) {
    newStream.getTracks().forEach(track => track.stop());
    if (stream === newStream) stream = null;
    if (video.srcObject === newStream) video.srcObject = null;
    throw err;
  }
}

function stopCamera() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
  }
  stream = null;
  if (video) video.srcObject = null;
  lastVideoTime = -1;
  engine.reset(); // Never replay a half-finished blink after focus/tab changes.
}

function loop() {
  const liveStream = stream && stream.getTracks().some(track => track.readyState === 'live');
  if (!liveStream || !enabled || activeTabId === null) {
    rafId = 0;
    if (stream && !liveStream) {
      stopCamera();
      cameraError = 'NotReadableError';
    }
    return;
  }
  rafId = requestAnimationFrame(loop);
  const generation = cameraGeneration;
  if (!video || video.readyState < 2 || video.currentTime === lastVideoTime || inFlightGeneration === generation) return;
  lastVideoTime = video.currentTime;
  const now = performance.now();

  if (!detector || detectorFailed) return;
  inFlightGeneration = generation;
  createImageBitmap(video, {
    resizeWidth: 480, resizeHeight: 360, resizeQuality: 'pixelated',
  }).then(async bitmap => {
    try {
      const { ear, hasFace } = await detector.detect(bitmap, now);
      // A frame captured for a previous tab/generation cannot emit a gesture
      // after the user has switched tabs or deactivated BlinkScroll.
      if (generation !== cameraGeneration || !stream || !enabled || activeTabId === null) return;
      const confidence = hasFace ? 1 : 0;
      for (const event of engine.update(ear, now, confidence)) {
        lastGesture = { type: event.type, at: Date.now() };
        chrome.runtime.sendMessage({ type: 'GESTURE', gesture: event.type }).catch(() => {});
      }
    } catch {
      // A single dropped frame must not kill the camera loop.
    } finally {
      bitmap.close();
      if (inFlightGeneration === generation) inFlightGeneration = null;
    }
  }, () => {
    if (inFlightGeneration === generation) inFlightGeneration = null;
  });
}

init();

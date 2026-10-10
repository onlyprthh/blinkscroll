// offscreen.js — owns the webcam. Detection WASM lives in the sandboxed
// iframe (the only place MV3 allows it); this document captures frames,
// ships them over, and classifies the returned EAR with BlinkEngine.
// Everything still runs locally; frames never leave the machine.
import { BlinkEngine } from './src/engine.js';
import { SandboxDetector } from './src/sandbox-client.js';

let detector = null;
let detectorReady = false;
let detectorFailed = null;
let stream = null;
let video = null;
let rafId = 0;
let lastVideoTime = -1;
let inFlight = false; // don't pile up frame round-trips
let engine = new BlinkEngine();
let armedTabs = new Set();
let enabled = true;
let lastGesture = null; // {type, at} — surfaced in the popup for diagnostics

function init() {
  video = document.getElementById('cam');

  // Register the message listener SYNCHRONOUSLY — the detector takes ~10s
  // to load WASM, and ARM/GET_STATUS messages arriving during that window
  // must not be lost.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'ARM') {
      armedTabs.add(msg.tabId);
      startCamera().catch((err) => console.warn('[blinkscroll] camera failed:', err));
    } else if (msg.type === 'DISARM') {
      armedTabs.delete(msg.tabId);
      if (armedTabs.size === 0) stopCamera(); // camera light off when not on a feed
    } else if (msg.type === 'ENABLED_CHANGED') {
      enabled = msg.enabled !== false;
      if (!enabled) {
        stopCamera(); // extension off = camera off, immediately. No exceptions.
      } else if (armedTabs.size > 0) {
        // Re-enabled while sitting on a feed: resume watching.
        startCamera().catch((err) => console.warn('[blinkscroll] camera failed:', err));
      }
    } else if (msg.type === 'GET_STATUS') {
      sendResponse({
        modelReady: detectorReady && !detectorFailed,
        detectorError: detectorFailed,
        cameraOn: !!stream,
        armedCount: armedTabs.size,
        enabled,
        lastGesture,
        engine: engine.status(performance.now()),
      });
      return true;
    }
  });

  initAsync().catch((err) => console.error('[blinkscroll] offscreen init failed:', err));
}

async function initAsync() {
  detector = new SandboxDetector(document.getElementById('detector'));
  await detector.ready;
  detectorFailed = detector.failed;
  detectorReady = true;
  if (detectorFailed) {
    console.error('[blinkscroll] detector failed:', detectorFailed);
  }

  const data = await chrome.storage.local.get(['profile', 'enabled']);
  if (data.profile) engine = new BlinkEngine(data.profile);
  enabled = data.enabled !== false;

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.profile?.newValue) engine = new BlinkEngine(changes.profile.newValue);
    if (changes.enabled) enabled = changes.enabled.newValue !== false;
  });
}

async function startCamera() {
  if (stream) return;
  stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: 'user' },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  loop();
}

function stopCamera() {
  cancelAnimationFrame(rafId);
  rafId = 0;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  if (video) video.srcObject = null;
  lastVideoTime = -1;
}

function loop() {
  rafId = requestAnimationFrame(loop);
  if (!video || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  const now = performance.now();

  if (!detector || detectorFailed || inFlight) return; // still loading, broken, or busy
  inFlight = true;
  // Downscale for the detector: blink geometry survives 480x360 easily,
  // and the round-trip stays cheap.
  createImageBitmap(video, {
    resizeWidth: 480, resizeHeight: 360, resizeQuality: 'pixelated',
  }).then(
    (bitmap) => detector.detect(bitmap, now).then(
      ({ ear, hasFace }) => {
        inFlight = false;
        const active = armedTabs.size > 0 && enabled;
        const confidence = hasFace ? 1 : 0;
        for (const e of engine.update(ear, now, active ? confidence : 0)) {
          lastGesture = { type: e.type, at: Date.now() };
          chrome.runtime.sendMessage({ type: 'GESTURE', gesture: e.type });
        }
      },
      () => { inFlight = false; } // detect rejected (model died mid-run)
    ),
    () => { inFlight = false; }
  );
}

init().catch((err) => console.error('[blinkscroll] offscreen init failed:', err));

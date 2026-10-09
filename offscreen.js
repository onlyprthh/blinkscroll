// offscreen.js — owns the webcam + MediaPipe FaceLandmarker + BlinkEngine.
// Everything runs locally. Frames never leave this document, let alone the machine.
import { FaceLandmarker, FilesetResolver } from './vendor/vision_bundle.mjs';
import { BlinkEngine, earFromLandmarks } from './src/engine.js';

let landmarker = null;
let stream = null;
let video = null;
let rafId = 0;
let lastVideoTime = -1;
let engine = new BlinkEngine();
let armedTabs = new Set();
let enabled = true;
let modelReady = false;

async function init() {
  const fileset = await FilesetResolver.forVisionTasks(chrome.runtime.getURL('vendor/wasm'));
  landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: chrome.runtime.getURL('vendor/face_landmarker.task'),
      delegate: 'CPU',
    },
    runningMode: 'VIDEO',
    numFaces: 1, // the closest face wins; strangers in the background are ignored
  });
  modelReady = true;

  const data = await chrome.storage.local.get(['profile', 'enabled']);
  if (data.profile) engine = new BlinkEngine(data.profile);
  enabled = data.enabled !== false;

  chrome.storage.onChanged.addListener(changes => {
    if (changes.profile?.newValue) engine = new BlinkEngine(changes.profile.newValue);
    if (changes.enabled) enabled = changes.enabled.newValue !== false;
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'ARM') {
      armedTabs.add(msg.tabId);
      startCamera().catch(err => console.warn('[blinkscroll] camera failed:', err));
    } else if (msg.type === 'DISARM') {
      armedTabs.delete(msg.tabId);
      if (armedTabs.size === 0) stopCamera(); // camera light off when not on a feed
    } else if (msg.type === 'ENABLED_CHANGED') {
      enabled = msg.enabled !== false;
    } else if (msg.type === 'GET_STATUS') {
      sendResponse({
        modelReady,
        cameraOn: !!stream,
        armedCount: armedTabs.size,
        enabled,
        engine: engine.status(performance.now()),
      });
      return true;
    }
  });

  video = document.getElementById('cam');
}

async function startCamera() {
  if (stream || !modelReady) return;
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
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  if (video) video.srcObject = null;
  lastVideoTime = -1;
}

function loop() {
  rafId = requestAnimationFrame(loop);
  if (!video || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  const now = performance.now();

  let ear = null;
  let confidence = 0;
  try {
    const res = landmarker.detectForVideo(video, now);
    const face = res.faceLandmarks && res.faceLandmarks[0];
    if (face) {
      ear = earFromLandmarks(face);
      // Sanity gate: garbage geometry (extreme EAR) counts as "can't see",
      // never as a blink. This is what keeps dark rooms from misfiring.
      confidence = ear != null && ear > 0.03 && ear < 0.55 ? 1 : 0;
    }
  } catch (err) {
    console.warn('[blinkscroll] detect failed:', err);
  }

  const active = armedTabs.size > 0 && enabled;
  for (const e of engine.update(ear, now, active ? confidence : 0)) {
    chrome.runtime.sendMessage({ type: 'GESTURE', gesture: e.type });
  }
  // Note: the popup reads live status via GET_STATUS (request/response),
  // so there's no fire-and-forget tick here — unanswered ports would leak.
}

init().catch(err => console.error('[blinkscroll] offscreen init failed:', err));

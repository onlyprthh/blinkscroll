// detect.js — runs INSIDE the sandboxed page (unique origin, no chrome.* APIs).
// Owns the MediaPipe WASM runtime. Receives ImageBitmap frames from the parent
// (offscreen document or interview page), returns {ear, hasFace} per frame.
// Pure geometry (EAR) is computed here; gesture classification stays with the
// parent (BlinkEngine / BlinkSampler are plain JS and need no WASM).
import { FaceLandmarker, FilesetResolver } from '../vendor/vision_bundle.mjs';
import { earFromLandmarks } from '../src/engine.js';

let landmarker = null;

async function init() {
  try {
    const base = new URL('../vendor/', import.meta.url).href;
    const fileset = await FilesetResolver.forVisionTasks(base + 'wasm/');
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: base + 'face_landmarker.task',
        delegate: 'CPU',
      },
      runningMode: 'VIDEO',
      numFaces: 1, // closest face wins
    });
    parent.postMessage({ type: 'bs-ready' }, '*');
  } catch (err) {
    parent.postMessage({
      type: 'bs-error',
      fatal: true,
      message: String((err && err.message) || err),
    }, '*');
  }
}

onmessage = async (e) => {
  const m = e.data;
  if (!m || m.type !== 'bs-frame' || !landmarker) return;
  let ear = null;
  let hasFace = false;
  try {
    const res = landmarker.detectForVideo(m.bitmap, m.ts);
    const face = res.faceLandmarks && res.faceLandmarks[0];
    if (face) {
      ear = earFromLandmarks(face);
      // Sanity gate: garbage geometry counts as "can't see", never as a blink.
      // This is what keeps dark rooms from misfiring.
      hasFace = ear != null && ear > 0.03 && ear < 0.55;
      if (!hasFace) ear = null;
    }
  } catch {
    // Per-frame failures must never kill the loop — just report no face.
  } finally {
    try { m.bitmap.close(); } catch { /* already neutered */ }
  }
  parent.postMessage({ type: 'bs-result', id: m.id, ear, hasFace }, '*');
};

init();

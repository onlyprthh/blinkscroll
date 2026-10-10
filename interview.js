// interview.js — first-run calibration interview.
// Measures the user's OWN blink timings per gesture, with Back/Redo on every
// step and nothing saved until the final Save. The camera lives in this tab;
// face detection WASM runs in the sandboxed iframe (the only place MV3
// allows it) — frames go over via postMessage, EAR comes back.
import {
  BlinkSampler, median, profileFromInterview, DEFAULT_PROFILE,
} from './src/engine.js';
import { SandboxDetector } from './src/sandbox-client.js';

const $ = id => document.getElementById(id);
const video = $('cam'), ring = $('ring');

const M = { earOpen: [], natural: [], single: [], gaps: [], long: [] };
let sampler = new BlinkSampler(0.2);
let detector = null, inFlight = false, lastVideoTime = -1;
let cameraStream = null, rafId = 0, saving = false, missingFaceSince = 0;
let stepIndex = 0, stepStart = 0, hintAt = 0;
let count = 0;                 // completed samples this step
let pendingFirstReopen = 0;    // double-blink pairing
let done = false;

function cleanupCamera() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  if (cameraStream) {
    for (const track of cameraStream.getTracks()) track.stop();
  }
  cameraStream = null;
  if (video) video.srcObject = null;
}

window.addEventListener('pagehide', cleanupCamera);

const STEPS = [
  { id: 'face',   label: 'Face check' },
  { id: 'single', label: 'Single blink → next' },
  { id: 'double', label: 'Double blink → previous' },
  { id: 'long',   label: 'Long close → pause' },
  { id: 'review', label: 'Review & save' },
];

function dots() {
  $('dots').innerHTML = STEPS.map((s, i) =>
    `<span class="${i < stepIndex ? 'done' : i === stepIndex ? 'now' : ''}"></span>`).join('');
}

function setBtns(html) { $('btns').innerHTML = html; }
function btnBack() { return `<button class="ghost" id="bBack">← Back</button>`; }
function btnRedo() { return `<button class="ghost" id="bRedo">↻ Redo step</button>`; }
function wireCommon() {
  $('bBack').onclick = () => { if (stepIndex > 0) { stepIndex--; enterStep(); } };
  const r = $('bRedo');
  if (r) r.onclick = () => { clearStepSamples(); enterStep(); };
}
function clearStepSamples() {
  const id = STEPS[stepIndex].id;
  if (id === 'single') M.single = [];
  if (id === 'double') { M.gaps = []; pendingFirstReopen = 0; }
  if (id === 'long') M.long = [];
  count = 0; hintAt = 0;
}

function showHint(text) {
  if (!hintAt) hintAt = performance.now();
  if (performance.now() - hintAt > 15000) {
    $('status').innerHTML = `<span class="warn">${text}</span>`;
    hintAt = performance.now(); // re-arm so it doesn't spam, just persists
  }
}

// --- step screens -----------------------------------------------------------
function enterStep() {
  if (done) return;
  dots();
  count = 0; hintAt = 0; stepStart = performance.now();
  pendingFirstReopen = 0;
  $('bar').style.width = '0%';
  const id = STEPS[stepIndex].id;

  if (id === 'face') {
    $('title').textContent = 'First, let me see you';
    $('lede').textContent = 'Position your face inside the frame. Nothing is recorded or uploaded — the camera never leaves this page.';
    $('instr').innerHTML = 'Just <b>look at the screen naturally</b> for a few seconds, blinking like you normally would.';
    $('status').textContent = 'measuring your natural blink…';
    setBtns(''); $('skip').style.display = '';
  } else if (id === 'single') {
    $('title').textContent = 'Your "next reel" blink';
    $('lede').textContent = 'Everyone blinks differently — I\'m learning yours.';
    $('instr').innerHTML = '<b>Blink 5 times</b> — a clear, deliberate blink, the way you\'d flip to the next reel.';
    $('status').innerHTML = `detected <b>0 / 5</b>`;
    setBtns(btnBack() + btnRedo());
    wireCommon(); $('skip').style.display = 'none';
  } else if (id === 'double') {
    $('title').textContent = 'Your "previous reel" double-blink';
    $('lede').textContent = 'Two quick blinks, one right after the other.';
    $('instr').innerHTML = '<b>Double-blink 3 times.</b> Don\'t rush it — do it the way that feels natural to you.';
    $('status').innerHTML = `pairs detected <b>0 / 3</b>`;
    setBtns(btnBack() + btnRedo());
    wireCommon();
  } else if (id === 'long') {
    $('title').textContent = 'Your pause / resume hold';
    $('lede').textContent = 'This one needs to be clearly longer than a blink, so it never fires by accident.';
    $('instr').innerHTML = '<b>Close your eyes and keep them shut</b> for a moment, then open. Do it <b>twice</b>.';
    $('status').innerHTML = `holds detected <b>0 / 2</b>`;
    setBtns(btnBack() + btnRedo());
    wireCommon();
  } else if (id === 'review') {
    showReview();
  }
}

function showReview() {
  const preview = profileFromInterview({
    earOpenMedian: median(M.earOpen) || 0.28,
    naturalMs: median(M.natural) || 130,
    singleMs: M.single, doubleGaps: M.gaps, longMs: M.long,
  });
  $('title').textContent = 'Here\'s what I learned';
  $('lede').textContent = 'Your personal timings. If anything looks off, go back and redo that step.';
  $('stage').style.display = 'none';
  $('instr').innerHTML = '';
  $('status').innerHTML = '';
  $('bar').style.width = '100%';
  $('skip').style.display = 'none';
  document.querySelector('.review')?.remove();
  const div = document.createElement('div');
  div.className = 'review';
  div.innerHTML =
    `Your natural blink: <b>~${Math.round(median(M.natural) || 130)}ms</b> — anything this quick is ignored<br>` +
    `Your "next" blink: <b>~${Math.round(median(M.single))}ms</b> → next reel<br>` +
    `Your double-blink gap: <b>~${Math.round(median(M.gaps))}ms</b> → previous reel<br>` +
    `Your long close: <b>~${(median(M.long) / 1000).toFixed(1)}s</b> → pause / resume`;
  $('btns').before(div);
  setBtns(btnBack() + `<button class="primary" id="bSave">Save & finish ✓</button>`);
  $('bBack').onclick = () => { stepIndex--; $('stage').style.display = ''; div.remove(); enterStep(); };
  $('bSave').onclick = save;
}

async function save(useDefaults = false) {
  if (done || saving) return;
  saving = true;
  const saveButton = $('bSave');
  if (saveButton) saveButton.disabled = true;

  try {
    const stored = await chrome.storage.local.get('profile');
    const prev = stored.profile || null;
    const profile = useDefaults
      ? { ...DEFAULT_PROFILE, calibratedAt: 0 }
      : profileFromInterview({
          earOpenMedian: median(M.earOpen) || 0.28,
          naturalMs: median(M.natural) || 130,
          singleMs: M.single, doubleGaps: M.gaps, longMs: M.long,
        });

    await chrome.storage.local.set({ profile, prevProfile: prev });
    done = true;
    cleanupCamera();

    // Push the new profile to a running worker. If it is not running, the
    // profile remains stored and is included when the active feed is armed.
    try { await chrome.runtime.sendMessage({ type: 'PROFILE_UPDATED', profile }); }
    catch { /* No offscreen document exists yet. */ }

    const card = document.querySelector('.card');
    card.innerHTML = `
      <div class="done-icon">👁️✓</div>
      <h1 style="text-align:center">You're calibrated</h1>
      <p class="lede" style="text-align:center">
        ${useDefaults ? 'Using defaults — you can calibrate properly anytime from the popup.'
                      : 'BlinkScroll learned your eyes.'}<br><br>
        Open <b>Instagram Reels</b>, <b>TikTok</b>, or <b>YouTube Shorts</b> and blink.<br>
        <span style="color:#6b6b76">single blink → next · double blink → previous · long close → pause</span>
      </p>
      <div class="btns"><button class="primary" id="doneClose">Close this tab</button></div>`;
    $('doneClose').addEventListener('click', () => window.close());
  } catch (error) {
    saving = false;
    if (saveButton) saveButton.disabled = false;
    $('status').textContent = `Could not save calibration: ${error?.message || error}. Please try again.`;
  }
}

// --- detection loop ---------------------------------------------------------
function handleMissingFace(now) {
  // Never allow a period of lost landmarks to count as a blink/long close.
  sampler.state = 'open';
  sampler.closeStart = 0;
  pendingFirstReopen = 0;
  ring.classList.remove('ok');
  if (!missingFaceSince) missingFaceSince = now;

  const id = STEPS[stepIndex]?.id;
  if (id === 'face') {
    const elapsed = (now - stepStart) / 1000;
    $('bar').style.width = Math.min(100, (elapsed / 20) * 100) + '%';
    $('status').textContent = 'No face detected — move into frame or use defaults below.';
  } else if (now - missingFaceSince > 1000 && id !== 'review') {
    $('status').textContent = 'Face tracking paused — move back into the frame.';
  }
}

async function init() {
  detector = new SandboxDetector(document.getElementById('detector'));
  await detector.ready;
  if (done) return;
  if (detector.failed) {
    $('instr').textContent = `Couldn't load the face model: ${detector.failed}`;
    return;
  }

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' }, audio: false,
    });
    if (done) {
      cleanupCamera();
      return;
    }
    video.srcObject = cameraStream;
    await video.play();
    if (done) {
      cleanupCamera();
      return;
    }
  } catch (error) {
    if (!done) {
      $('instr').textContent = `Camera unavailable (${error?.name || 'error'}). Allow camera access, close other apps using it, then reload this tab. Video stays on this device.`;
    }
    cleanupCamera();
    return;
  }

  enterStep();
  rafId = requestAnimationFrame(loop);
}

function loop() {
  if (done || !cameraStream) {
    rafId = 0;
    return;
  }
  rafId = requestAnimationFrame(loop);
  if (inFlight || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  const now = performance.now();
  inFlight = true;
  createImageBitmap(video, {
    resizeWidth: 480, resizeHeight: 360, resizeQuality: 'pixelated',
  }).then(bitmap => detector.detect(bitmap, now).then(
    ({ ear, hasFace }) => {
      inFlight = false;
      if (done) return;
      ring.classList.toggle('ok', hasFace);
      if (ear == null || !hasFace) {
        handleMissingFace(now);
        return;
      }
      missingFaceSince = 0;
      handleEar(ear, now);
    },
    () => {
      inFlight = false;
      if (!done) handleMissingFace(performance.now());
    }
  ), () => {
    inFlight = false;
    if (!done) handleMissingFace(performance.now());
  });
}

// Per-frame EAR consumer: the interview's step state machine (unchanged).
function handleEar(ear, now) {
  const id = STEPS[stepIndex].id;

  if (id === 'face') {
    if (M.earOpen.length < 300) M.earOpen.push(ear);
    for (const b of sampler.feed(ear, now)) {
      if (b.durationMs > 60 && b.durationMs < 400) M.natural.push(b.durationMs);
    }
    const el = (now - stepStart) / 1000;
    $('bar').style.width = Math.min(100, (el / 5) * 100) + '%';
    if (el >= 5 && M.natural.length >= 2) {
      const earMed = median(M.earOpen);
      sampler.setThreshold(Math.min(0.3, Math.max(0.12, earMed * 0.72)));
      stepIndex++; enterStep();
    } else if (el > 20) { // couldn't get clean samples; continue with defaults
      stepIndex++; enterStep();
    }
    return;
  }

  if (id === 'review') return;

  for (const b of sampler.feed(ear, now)) {
    const d = b.durationMs;
    if (id === 'single') {
      if (d >= 120 && d <= 1200) {
        M.single.push(d); count++;
        $('status').innerHTML = `detected <b>${count} / 5</b> <span class="good">✓</span>`;
        $('bar').style.width = (count / 5) * 100 + '%';
        if (count >= 5) { stepIndex++; enterStep(); return; }
      } else if (d < 120) {
        showHint('That was very quick — give me a clear, deliberate blink.');
      }
    } else if (id === 'double') {
      if (d >= 120 && d <= 800) {
        if (pendingFirstReopen && b.atMs - pendingFirstReopen < 900) {
          M.gaps.push(b.atMs - pendingFirstReopen);
          pendingFirstReopen = 0; count++;
          $('status').innerHTML = `pairs detected <b>${count} / 3</b> <span class="good">✓</span>`;
          $('bar').style.width = (count / 3) * 100 + '%';
          if (count >= 3) { stepIndex++; enterStep(); return; }
        } else {
          pendingFirstReopen = b.atMs;
          $('status').innerHTML = `first blink seen — <b>now the second, quick!</b>`;
        }
      }
    } else if (id === 'long') {
      if (d >= 800) {
        M.long.push(d); count++;
        $('status').innerHTML = `holds detected <b>${count} / 2</b> <span class="good">✓ ${(d / 1000).toFixed(1)}s</span>`;
        $('bar').style.width = (count / 2) * 100 + '%';
        if (count >= 2) { stepIndex++; enterStep(); return; }
      } else {
        $('status').innerHTML = `<span class="warn">that was ${(d / 1000).toFixed(1)}s — keep them shut a little longer</span>`;
      }
    }
  }

  // expire stale first-blink while waiting for the double's second half
  if (pendingFirstReopen && now - pendingFirstReopen > 1500) {
    pendingFirstReopen = 0;
    $('status').innerHTML = `pairs detected <b>${count} / 3</b> — too slow, try the two blinks closer together`;
  }

  // live hold progress for the long-close step
  if (id === 'long' && sampler.isClosed()) {
    $('bar').style.width = Math.min(100, (sampler.currentCloseDuration(now) / 2000) * 100) + '%';
  }

  if (id !== 'face') showHint('I\'m not catching it — try a slightly firmer, clearer blink.');
}

$('skip').onclick = () => save(true);

init().catch(error => {
  cleanupCamera();
  if (!done) $('instr').textContent = `Calibration could not start: ${error?.message || error}`;
});

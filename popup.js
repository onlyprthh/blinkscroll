// popup.js — tiny status + controls. No camera here.
const $ = id => document.getElementById(id);

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  $('enabled').checked = state.enabled;
  $('feedState').textContent = state.feedActive ? 'detected ✓' : 'not on a feed';
  $('calibLine').textContent = !state.hasProfile
    ? 'not calibrated yet — run the interview'
    : state.calibratedAt
      ? 'calibrated ' + new Date(state.calibratedAt).toLocaleDateString()
      : 'using default timings — calibrate for best results';

  // Ask the offscreen worker for live camera/face status (may not exist yet).
  try {
    const s = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    const camErrText = {
      NotReadableError: 'busy — close other camera tabs',
      NotAllowedError: 'blocked — allow camera for this site',
      NotFoundError: 'no camera found',
    }[s.cameraError] || (s.cameraError ? 'error' : '');
    $('camDot').className = 'dot' + (s.cameraOn ? ' on' : (s.cameraError ? ' warn' : ''));
    $('camState').textContent = s.cameraOn ? 'on' : (camErrText || 'off');
    $('camState').title = s.cameraError ? `Camera error: ${s.cameraError}` : '';
    // NotAllowedError = the extension's camera permission was denied or never
    // granted (e.g. after reinstalling under a new extension id). The fix is
    // to grant it in a visible tab — the interview requests it on load.
    const needGrant = !s.cameraOn && s.cameraError === 'NotAllowedError';
    $('fixCam').style.display = needGrant ? '' : 'none';
    const faceOk = s.cameraOn && !s.engine.suspended;
    $('faceDot').className = 'dot' + (s.cameraOn ? (faceOk ? ' on' : ' warn') : '');
    $('faceState').textContent = !s.cameraOn ? '–' : faceOk ? 'tracking' : 'low confidence';
    if (s.lastGesture) {
      const ago = Math.max(0, Math.round((Date.now() - s.lastGesture.at) / 1000));
      $('gestureState').textContent = `${s.lastGesture.type} · ${ago}s ago`;
    } else {
      $('gestureState').textContent = 'none yet — blink to test';
    }
  } catch {
    $('camState').textContent = 'off';
    $('faceState').textContent = '–';
    $('gestureState').textContent = '–';
  }
}

$('enabled').addEventListener('change', async e => {
  await chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled: e.target.checked });
  refresh();
});
$('fixCam').addEventListener('click', () => {
  // Opens the interview, which asks for the camera in a visible tab.
  // Granting it there covers the whole extension (same origin).
  chrome.tabs.create({ url: chrome.runtime.getURL('interview.html') });
  window.close();
});
$('testScroll').addEventListener('click', async () => {
  // Bypass blink detection entirely: send a "next" straight to this tab's
  // content script. If the feed scrolls, the scroll path is fine and the
  // problem is gesture detection — if not, the problem is here.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'DO_GESTURE', gesture: 'single' })
      .catch(() => { $('gestureState').textContent = 'no content script on this tab'; });
  }
});
$('recal').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('interview.html') });
  window.close();
});
$('how').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://github.com/onlyprthh/blinkscroll#how-it-works' });
});

refresh();
setInterval(refresh, 2000);

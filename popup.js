// popup.js — tiny status + controls. No camera here.
const $ = id => document.getElementById(id);

let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (!state || state.ok === false) throw new Error(state?.error || 'Extension state unavailable');
    $('enabled').checked = state.enabled !== false;
    $('feedState').textContent = state.feedActive ? 'detected ✓' : 'not on a feed';
    $('activeTabLine').textContent = state.activeUrl
      ? `Active tab: ${state.activeUrl}`
      : 'Active tab URL unavailable';
    $('calibLine').textContent = !state.hasProfile
      ? 'not calibrated yet — run the interview'
      : state.calibratedAt
        ? 'calibrated ' + new Date(state.calibratedAt).toLocaleDateString()
        : 'using default timings — calibrate for best results';

    let status = null;
    try {
      status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
      if (!status || status.ok !== true) status = null;
    } catch { status = null; }

    const camErrText = {
      NotReadableError: 'busy — close other camera apps',
      NotAllowedError: 'permission blocked — use Fix camera access',
      NotFoundError: 'no camera found',
      DetectorError: 'face model failed — check extension files',
      OverconstrainedError: 'camera settings unsupported',
      AbortError: 'camera start interrupted — retry',
      SecurityError: 'blocked by browser policy',
      NotSupportedError: 'camera API unavailable in this browser',
      TypeError: 'camera request invalid — reload extension',
    };

    const cameraOn = status?.cameraOn === true;
    const cameraStarting = status?.cameraStarting === true;
    const cameraError = status?.cameraError || '';
    const targetActive = state.cameraTargetActive === true && state.enabled !== false;
    const shouldOfferRetry = targetActive && !cameraOn && !cameraStarting && cameraError !== 'NotAllowedError';
    $('retryCam').style.display = shouldOfferRetry ? '' : 'none';
    $('fixCam').style.display = targetActive && !cameraOn && cameraError === 'NotAllowedError' ? '' : 'none';

    $('camDot').className = 'dot' + (cameraOn ? ' on' : ((cameraError || cameraStarting) ? ' warn' : ''));
    if (cameraOn) $('camState').textContent = 'on';
    else if (cameraStarting) $('camState').textContent = 'starting…';
    else if (cameraError) $('camState').textContent = camErrText[cameraError] || `error (${cameraError})`;
    else if (state.enabled === false) $('camState').textContent = 'disabled';
    else if (!state.feedActive) $('camState').textContent = 'off — not a feed';
    else if (!state.cameraTargetActive) $('camState').textContent = 'off — select a supported feed';
    else $('camState').textContent = status ? 'off — retry startup' : 'worker unavailable';
    $('camState').title = cameraError ? `Camera error: ${cameraError}` : (status?.detectorError || '');

    const faceOk = cameraOn && status?.engine && !status.engine.suspended;
    $('faceDot').className = 'dot' + (cameraOn ? (faceOk ? ' on' : ' warn') : '');
    $('faceState').textContent = !cameraOn
      ? (cameraStarting ? 'starting' : '–')
      : faceOk ? 'tracking' : 'low confidence';

    if (status?.lastGesture) {
      const ago = Math.max(0, Math.round((Date.now() - status.lastGesture.at) / 1000));
      $('gestureState').textContent = `${status.lastGesture.type} · ${ago}s ago`;
    } else {
      $('gestureState').textContent = 'none yet — blink to test';
    }
  } catch (error) {
    $('calibLine').textContent = `Extension unavailable: ${error?.message || error}`;
    $('feedState').textContent = 'unknown';
    $('camState').textContent = 'state unavailable';
    $('faceState').textContent = '–';
  } finally {
    refreshing = false;
  }
}

$('enabled').addEventListener('change', async e => {
  await chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled: e.target.checked });
  refresh();
});
$('retryCam').addEventListener('click', async () => {
  $('camState').textContent = 'retrying…';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'RETRY_CAMERA' });
    if (result?.ok !== true) throw new Error(result?.error || 'Retry failed');
  } catch (error) {
    $('camState').textContent = `retry failed: ${error?.message || error}`;
  }
  await refresh();
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

void refresh();
setInterval(() => { void refresh(); }, 2000);

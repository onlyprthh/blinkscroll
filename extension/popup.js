// popup.js — tiny status + controls. No camera here.
const $ = id => document.getElementById(id);

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  $('enabled').checked = state.enabled;
  $('calibLine').textContent = state.hasProfile
    ? 'calibrated ' + new Date(state.calibratedAt).toLocaleDateString()
    : 'not calibrated yet — run the interview';

  // Ask the offscreen worker for live camera/face status (may not exist yet).
  try {
    const s = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    $('camDot').className = 'dot' + (s.cameraOn ? ' on' : '');
    $('camState').textContent = s.cameraOn ? 'on' : 'off';
    const faceOk = s.cameraOn && !s.engine.suspended;
    $('faceDot').className = 'dot' + (s.cameraOn ? (faceOk ? ' on' : ' warn') : '');
    $('faceState').textContent = !s.cameraOn ? '–' : faceOk ? 'tracking' : 'low confidence';
  } catch {
    $('camState').textContent = 'off';
    $('faceState').textContent = '–';
  }
}

$('enabled').addEventListener('change', async e => {
  await chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled: e.target.checked });
  refresh();
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

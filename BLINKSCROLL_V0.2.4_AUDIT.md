# BlinkScroll v0.2.4 — Popup-independent camera lifecycle

## User-visible root cause

The v0.2.3 background service worker listened to `chrome.windows.onFocusChanged`. Whenever `windowId === chrome.windows.WINDOW_ID_NONE`, it set `browserFocused = false` and explicitly sent `SYNC_ACTIVE_FEED` with `tabId: null`, which stopped the offscreen camera. Some browser/OS focus transitions around action popups can emit this signal even though the supported feed tab remains selected. This matched the user's report: camera LED turned on while the toolbar popup was open and shut off when the popup closed.

## Fix

- Camera eligibility now follows **BlinkScroll enabled + selected tab URL is a supported feed** only.
- `WINDOW_ID_NONE` no longer changes camera state or sends a stop/disarm command.
- Focus gain may reconcile state, but focus loss does not turn off the camera. Tab activation/navigation and the Enabled switch remain authoritative stop/start triggers.
- Popup is status/control only; it does not own the camera lifetime. Popup copy explicitly says closing it does not stop camera tracking.
- Removed the old “paused — browser focus” status that could misdiagnose popup focus as an ineligible feed.
- Added routing and structural regression tests for the popup-close/focus-loss failure.

## Intended behavior

1. BlinkScroll enabled + select an Instagram Reels, TikTok feed, or YouTube Shorts tab: camera starts without opening the popup.
2. Open or dismiss the toolbar popup: camera remains on while that supported feed remains selected.
3. Select an unsupported tab: camera stops.
4. Turn BlinkScroll off: camera stops.

## Validation

Automated Node regression tests and Python installer tests are run with `npm test`; manifest/resource/syntax checks are run with `npm run check`.

A real webcam/browser session is not available in this environment, so this release does not claim live-camera verification. After installing v0.2.4, verify the exact user workflow in a normal browser profile. If the camera still stops, capture the popup's Camera/Feed/Active tab status and the offscreen page's console so a permission/model failure can be distinguished from lifecycle routing.

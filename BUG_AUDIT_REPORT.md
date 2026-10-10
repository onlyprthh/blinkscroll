# BlinkScroll v0.2.2 — Bug Audit & Loop-Engineering Report

## Issue reproduced from the reported UI state

The screenshot shows **Enabled = ON**, but **Feed = not on a feed** and **Camera = off**. In BlinkScroll's design, the camera is intentionally started only after the active tab is recognized as a supported Reels/Shorts feed. That means the first failure is feed recognition/routing, not the Enabled switch itself.

The source contained a concrete host-matching gap: the manifest and active-tab scanner only matched `www.instagram.com`, not the apex host `instagram.com`. In addition, the background worker did not attempt to recover an already-open active feed if initial content-script injection had been missed, and the content script suppressed retries after a failed initial state report. Those conditions can produce the exact status combination visible in the screenshot. The screenshot's abbreviated address bar alone does not prove which hostname the browser used, so live validation is still needed to distinguish that case from a browser/camera permission issue.

## What was changed

### Feed routing and injection
- Added a single shared URL-routing helper used by the extension service worker and content script.
- Added host patterns for both apex and `www` variants of Instagram, TikTok, and YouTube.
- Ensured the shared route helper is loaded before the content script in both normal manifest injection and recovery injection.
- Added active-tab recovery when the popup asks for state, so an already-open supported feed can be reinjected and armed.
- Added tab URL/update handling to recheck feed routes and stop camera use when navigation leaves a supported feed.
- Made feed-state reporting retry after a failed or unacknowledged first message instead of remaining stuck in an unreported state.

### Previously hardened runtime and gestures
- Offscreen worker initialization and message acknowledgements were corrected.
- Camera and frame-loop cleanup now follows feed, focus, and enabled state.
- Gesture state-machine regression fixes cover pending single blinks, long-close cooldowns, low-confidence tracking, and malformed frames.
- Installer fixes preserve unrelated extension launch flags and avoid matching browser helper processes as the browser itself.

## Verification performed

- `npm test`: 19 JavaScript tests and 7 installer tests pass (26 automated tests total).
- `npm run check`: manifest and host-pattern consistency, local resource references, CSP inline-handler checks, and syntax checks pass (17 JS/MJS files and 2 Python files).
- Test coverage now explicitly verifies Instagram Reels with and without `www`, non-feed Instagram pages, supported TikTok and YouTube Shorts URL variants, unrelated hosts, and malformed URLs.

## Limitation

This environment cannot reliably run a real Chrome extension with webcam access or validate the live Instagram DOM. Therefore, it is accurate to say the routing gap is repaired and automated checks pass, but not that camera activation has been live-verified on the user's browser.

## Verify the updated build

1. Extract the new ZIP to a **new folder** so it does not mix with the old files.
2. Open `chrome://extensions`, find BlinkScroll, and click **Reload** (or remove the old unpacked copy and load this new folder using **Load unpacked**).
3. Reload the Instagram Reels tab. Leave that tab active, then open the BlinkScroll popup.
4. Confirm `Feed` changes to `detected ✓`. If that appears but `Camera` changes to `blocked — allow camera for this site`, use the permission/calibration interview to grant camera access. If it reports `busy`, close other apps/tabs using the webcam.
5. If it still says `not on a feed`, open DevTools on the Instagram tab and check the URL host/path and extension errors; that would indicate the live browser still is not executing the content script or uses a route not covered by the current feed patterns.

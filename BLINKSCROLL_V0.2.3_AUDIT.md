# BlinkScroll v0.2.3 — Active-tab camera lifecycle audit

## Summary

This release addresses the repeated failure where Instagram Reels briefly appeared detected, then the camera status returned to **off** even though BlinkScroll was enabled.

### Root causes addressed

1. **Feed detection was indirectly authorizing camera startup.** The service worker required the active tab ID to be present in an in-memory/session `feedTabs` set that depended on content-script heartbeat messages. A dropped or delayed message, stale status, or route transition could make a real active `/reels/...` page look inactive. Camera eligibility now comes from the currently selected tab's URL through the shared `resolveCameraTarget()` policy; content-script messages are no longer the gate for webcam startup.
2. **The worker cached a requested start as if the camera were already running.** `SYNC_ACTIVE_FEED` was acknowledged before `getUserMedia()` finished. The background worker then skipped subsequent starts when its cached tab/enabled values matched, even if the camera had failed or the offscreen document had restarted. The worker now reconciles its cached state against the offscreen document's actual `cameraOn`, `cameraStarting`, `cameraError`, and `activeTabId` values.
3. **A stale asynchronous camera request could outlive a tab change.** The offscreen camera code now generation-tags start requests and video frames. A late stream is stopped if its target tab is no longer active; stale frames cannot fire gestures for a different tab. An invalidated pending `getUserMedia()` promise is detached from the current start slot, so it cannot block every later tab activation forever.
4. **The popup hid the useful evidence.** It now displays the active tab URL/path, distinguishes starting/off/error/permission-blocked states, and offers an explicit retry. Camera errors are no longer reduced to a generic “off” message while a feed is active.
5. **Navigation cleanup was incomplete.** Leaving a supported feed for an unrelated host now clears that tab's feed state as well.
6. **Video frame resources and async results are guarded.** Generated `ImageBitmap` frames are closed after use, and processing results are rejected when their generation is stale.

## Research used

This was a source-and-architecture review of the official Chrome extension documentation and representative public webcam/gesture extensions, not a claim that one thousand add-ons were individually audited.

- Chrome's [Offscreen API documentation](https://developer.chrome.com/docs/extensions/reference/api/offscreen) explains that Manifest V3 service workers have no DOM, offscreen documents exist for DOM-bound work such as `getUserMedia()`, and offscreen documents have a restricted extension API surface. BlinkScroll keeps camera/detector work in an offscreen document, with the service worker acting as the tab/lifecycle coordinator.
- Chrome's [Tabs API documentation](https://developer.chrome.com/docs/extensions/reference/api/tabs) notes that a tab's URL may not be populated when `tabs.onActivated` fires; activation and URL-update events therefore both need to lead to a consistent reconciliation path.
- Chrome's [service worker documentation](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers) notes that extension service workers are event-driven and can become dormant. Camera state must be reconciled from observable runtime state rather than assuming an in-memory “start requested” flag proves the camera is still running.
- The public [EyeSense blink-control extension](https://github.com/8ernity/EyeSense) illustrates a content-script camera/MediaPipe architecture.
- [Sightline / soda-hacks-final](https://github.com/Bryce-Lim/soda-hacks-final) documents a Manifest V3 split between popup, service worker, offscreen webcam/ML, and content-script actions, which is the closest comparison to BlinkScroll's architecture.
- [Chrome Gesture Control](https://github.com/dana-ross/chrome-gesture-control) illustrates the older per-page webcam/visible-overlay approach and highlights camera-permission UX as a separate concern from gesture detection.

## Changed files

- `src/site-routing.js`: added the shared selected-tab camera eligibility policy.
- `background.js`: URL-authoritative active tab selection; live offscreen-status reconciliation; recovery when the worker/document state is stale; explicit `RETRY_CAMERA`; gesture dispatch no longer depends on heartbeat-set membership; navigation-away cleanup.
- `offscreen.js`: generation-safe camera start/stop; live camera track reporting; stale-frame suppression; late-stream cleanup; closed image bitmaps.
- `popup.html` / `popup.js`: active path diagnostic, true startup/error states, Retry camera button, explicit permission-recovery flow.
- `test/site-routing.test.mjs`: new target-policy tests for feed selection, non-feed navigation, disabled state, unfocused window, and invalid tab data.
- `scripts/check-project.mjs`: validates the lifecycle reconciliation and stale-frame guards.
- `manifest.json`, `package.json`, `README.md`: version 0.2.3 and release notes.

## Verification results

- `npm test`: **23 Node tests passed** (13 gesture-engine tests + 10 routing/target tests).
- Python installer regression tests: **7 passed**.
- `npm run check`: **passed** for manifest version/permissions, referenced local files, content-script order/host patterns, inline-handler/CSP checks, and JavaScript/Python syntax (17 JS/MJS and 2 Python files).
- ZIP integrity: checked after packaging; archive extracted and the tests/checks reran successfully from the extracted project.

## Runtime-test limitation

A real webcam/live-site check could not be performed in this execution environment. Its managed Chromium policy blocks extensions (`ExtensionInstallBlocklist: ["*"]`), blocks video capture (`VideoCaptureAllowed: false`), and blocks URLs (`URLBlocklist: ["*"]`); no `/dev/video*` camera device is exposed. So this release has passed automated routing/lifecycle tests, but live permission prompting and camera hardware must still be smoke-tested on the user's normal browser profile.

## Manual verification after installing v0.2.3

1. Extract the new ZIP to a **new folder**.
2. Open `chrome://extensions`, remove/replace the old unpacked BlinkScroll copy, and load the new folder with **Load unpacked**.
3. Keep BlinkScroll enabled and click the Instagram Reels tab. Open the extension popup and confirm `Feed: detected ✓`, `Active tab: .../reels/...`, and `Camera: starting…` followed by `Camera: on`.
4. If it shows `permission blocked`, use **Fix camera access** to open the visible calibration/interview page and grant camera permission. If it shows `busy`, close other camera apps/tabs. For other startup failures use **Retry camera startup** and note the exact reported error.
5. Switch to a non-feed tab: the camera should stop. Switch back to the Reels tab: it should start again while BlinkScroll remains enabled.

## Known boundaries

- Instagram/TikTok/YouTube can change their internal DOM and navigation behavior; automated URL/lifecycle tests do not prove scroll behavior on every live layout.
- Camera access depends on browser permission, hardware availability, and no other process monopolizing the webcam.

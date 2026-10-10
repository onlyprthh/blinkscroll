# 👁️ BlinkScroll

**Scroll reels & shorts with your blinks.** For lazy people — and for everyone who can't (or doesn't want to) use their hands.

BlinkScroll is a Chrome/Edge/Brave extension that watches your blinks through your webcam and turns them into reel controls on **Instagram Reels**, **Facebook Reels**, **TikTok**, and **YouTube Shorts**. Lie down, put the phone… er, laptop down, and blink.

## The gesture map (v1)

| You do | It does |
|---|---|
| Single deliberate blink | Next reel |
| Double blink (two quick blinks) | Previous reel |
| Eyes closed ~1.3–1.4s | Pause / resume |

Because every human blinks differently, BlinkScroll doesn't ship with fixed timings — it **interviews you** on first run (60 seconds) and learns *your* natural blink, *your* deliberate blink, *your* double-blink gap, and *your* comfortable long-close. It keeps adapting quietly as you use it, and it refuses to fire when it can't see you clearly (dark room, face out of frame) instead of guessing wrong.

## Install

**Option A — automatic (easiest):**
```bash
python3 setup/auto_setup.py
```
Detects your default browser (Brave / Chrome / Edge / Chromium — falls back to your most-used one) and loads the extension into it. If the browser is already running, close it first and re-run (Chromium ignores `--load-extension` on a running instance).

**Option B — manual (1 minute):** watch `setup/manual-setup-guide.mp4` — or follow along here:
1. Unzip the download.
2. Open your browser and go to `chrome://extensions`.
3. Switch on **Developer mode** (top right).
4. Click **Load unpacked**, select the unzipped folder itself. Done.
5. The calibration interview opens automatically — give it 60 seconds
   (or watch `setup/interview-walkthrough.mp4` first to see how it works).

Then open Instagram Reels, Facebook Reels, TikTok, or YouTube Shorts. Blink.

No build step, no server, no account.

## How it works

- **Face/eye tracking:** [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) runs entirely in your browser via WebAssembly. Eye Aspect Ratio (EAR) per frame → open/closed state → a small state machine classifies single / double / long-close.
- **Camera plumbing:** a Manifest V3 *offscreen document* owns `getUserMedia` and the detection loop. Camera eligibility comes directly from the currently selected tab URL (not a delayed content-script heartbeat), and the worker verifies the camera actually started before considering its state synchronized. The camera turns on only while BlinkScroll is enabled and a supported reels/shorts tab is selected. The toolbar popup is a dashboard only; opening or closing it does not stop capture. The OS camera light is your indicator.
- **Scrolling:** the extension fires `ArrowDown`/`ArrowUp` key events (all three players navigate feeds with arrow keys — no brittle DOM selectors), and clicks the video element for pause/resume.
- **Adaptive thresholds:** your involuntary-blink baseline is tracked with a slow-moving average; the "deliberate blink" floor always sits clearly above it, so watering eyes never hijack your feed. The closed-eye EAR threshold drifts slowly with lighting.
- **Privacy:** 100% on-device. Frames never leave the offscreen document, let alone your machine. There is no analytics, no network call, no server. The model + WASM runtime are vendored in `vendor/` so it even works offline.

## Project layout

```
blinkscroll/                   # <- load THIS folder unpacked in chrome://extensions
+-- README.md                  # you are here
+-- LICENSE
+-- manifest.json
+-- background.js              # service worker: routes feed <-> camera worker
+-- offscreen.js/.html         # webcam + MediaPipe + gesture engine
+-- content.js                 # feed detection + scroll/pause execution
+-- popup.html/.js             # toggle, live status, re-calibrate
+-- interview.html/.js         # first-run calibration interview
+-- src/engine.js              # pure gesture state machine (no DOM/chrome APIs)
+-- src/sandbox-client.js      # postMessage bridge to the sandboxed detector
+-- scripts/                   # repeatable project checks and test runner
+-- package.json               # dependency-free test commands
+-- vendor/                    # MediaPipe model + WASM (all local, works offline)
+-- setup/
|   +-- auto_setup.py          # detects your browser, loads the extension
|   +-- manual-setup-guide.mp4 # narrated 1-minute install walkthrough
|   +-- interview-walkthrough.mp4  # animated guide to the calibration interview
+-- test/
    +-- engine.test.mjs        # synthetic-EAR gesture regression tests
    +-- site-routing.test.mjs   # host/path detection regression tests
    +-- test_auto_setup.py     # installer regression tests
```

## Development and regression checks

Requires Node.js 18+ and Python 3; no `npm install` or network access is required because MediaPipe and its WASM/model assets are vendored.

```bash
npm test       # gesture-engine tests + installer regression tests
npm run check  # manifest/resource reference and JS/Python syntax checks
```

The gesture logic in `src/engine.js` is DOM-free and tested with synthetic eye-aspect-ratio streams. Regression coverage includes single/double arbitration, long-close cooldowns, low-confidence suspension, malformed profiles, apex/www URL routing, installer idempotence, and preserving other extensions' launcher flags.

## Status

v0.2.4 — popup-independent camera lifecycle. Camera eligibility now depends on the Enabled setting and selected supported tab URL, never on extension popup focus. Dismissing the toolbar popup no longer tears down the camera.

v0.2.3 — active-tab/camera lifecycle hardening. The selected tab URL is now the source of truth for camera eligibility; failed or lost offscreen starts are reconciled from live status; stale asynchronous camera requests are invalidated when tabs change; and the popup exposes the active URL, camera errors, and a retry action. Automated routing, gesture-engine, installer, and project checks pass. A real webcam and live Instagram/Facebook/TikTok/YouTube layout verification is still needed before calling every site fully verified.

## Roadmap ideas

- Gaze zones (look left/right to navigate, no blinking at all)
- Look-at + blink to click (e.g. stare at ♥ and blink)
- Look-away auto-pause
- Custom gesture → keypress mapping ("a macro pad for your face")
- Firefox support (MV3 + `getUserMedia` in background contexts)

## License

MIT — do whatever you want with it.

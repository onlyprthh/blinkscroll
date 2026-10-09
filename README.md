# 👁️ BlinkScroll

**Scroll reels & shorts with your blinks.** For lazy people — and for everyone who can't (or doesn't want to) use their hands.

BlinkScroll is a Chrome/Edge/Brave extension that watches your blinks through your webcam and turns them into reel controls on **Instagram Reels**, **TikTok**, and **YouTube Shorts**. Lie down, put the phone… er, laptop down, and blink.

## The gesture map (v1)

| You do | It does |
|---|---|
| Single deliberate blink | Next reel |
| Double blink (two quick blinks) | Previous reel |
| Eyes closed ~1.3–1.4s | Pause / resume |

Because every human blinks differently, BlinkScroll doesn't ship with fixed timings — it **interviews you** on first run (60 seconds) and learns *your* natural blink, *your* deliberate blink, *your* double-blink gap, and *your* comfortable long-close. It keeps adapting quietly as you use it, and it refuses to fire when it can't see you clearly (dark room, face out of frame) instead of guessing wrong.

## Install (2 minutes)

1. Clone the repo or download it as a ZIP (`Code` → `Download ZIP` on GitHub), then unzip.
2. Open `chrome://extensions`, enable **Developer mode** (top right).
3. Click **Load unpacked** and select the unzipped folder.
4. The calibration interview opens automatically — follow it (camera permission required).
5. Open Instagram Reels, TikTok, or YouTube Shorts. Blink.

No build step, no server, no account.

## How it works

- **Face/eye tracking:** [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) runs entirely in your browser via WebAssembly. Eye Aspect Ratio (EAR) per frame → open/closed state → a small state machine classifies single / double / long-close.
- **Camera plumbing:** a Manifest V3 *offscreen document* owns `getUserMedia` and the detection loop. The camera turns on only while a reels/shorts tab is active — the OS camera light is your indicator.
- **Scrolling:** the extension fires `ArrowDown`/`ArrowUp` key events (all three players navigate feeds with arrow keys — no brittle DOM selectors), and clicks the video element for pause/resume.
- **Adaptive thresholds:** your involuntary-blink baseline is tracked with a slow-moving average; the "deliberate blink" floor always sits clearly above it, so watering eyes never hijack your feed. The closed-eye EAR threshold drifts slowly with lighting.
- **Privacy:** 100% on-device. Frames never leave the offscreen document, let alone your machine. There is no analytics, no network call, no server. The model + WASM runtime are vendored in `vendor/` so it even works offline.

## Project layout

```
blinkscroll/
├── manifest.json          # MV3 manifest
├── background.js          # service worker: routes feed <-> camera worker
├── offscreen.js/.html     # webcam + MediaPipe + gesture engine
├── content.js             # feed detection + scroll/pause execution
├── popup.html/.js         # toggle, live status, re-calibrate
├── interview.html/.js     # first-run calibration interview
├── src/engine.js          # pure gesture state machine (no DOM/chrome APIs)
├── test/engine.test.mjs   # synthetic-EAR unit tests (11 cases)
└── vendor/                # MediaPipe model + WASM (all local)
```

## Development

```bash
npm install                  # pulls @mediapipe/tasks-vision (to refresh vendor/)
node test/engine.test.mjs    # gesture state machine tests — must stay green
```

The gesture logic in `src/engine.js` is deliberately DOM-free so it can be unit-tested with synthetic eye-aspect-ratio streams: natural blinks never fire, doubles never double-fire as singles, cooldowns swallow machine-gunning, low confidence suspends everything.

## Status

v0.1.0 — working prototype. The gesture engine is unit-tested; live camera + per-site behavior still needs real-world verification (that's you — please open issues with your experience, lighting conditions, and whether you wear glasses).

## Roadmap ideas

- Gaze zones (look left/right to navigate, no blinking at all)
- Look-at + blink to click (e.g. stare at ♥ and blink)
- Look-away auto-pause
- Custom gesture → keypress mapping ("a macro pad for your face")
- Firefox support (MV3 + `getUserMedia` in background contexts)

## License

MIT — do whatever you want with it.

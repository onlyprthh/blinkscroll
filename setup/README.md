# BlinkScroll setup

Three ways to get going — pick whichever suits you.

## 1. Automatic setup (recommended)

```bash
python3 auto_setup.py
```

- Detects your **default browser** (Brave, Chrome, Edge, or Chromium).
  If that fails it falls back to your **most-used** Chromium browser
  (by profile activity), then to whatever Chromium binary is on PATH.
- Loads the extension automatically — the calibration interview opens by itself.
- If the browser is already running, close it completely and re-run
  (Chromium ignores `--load-extension` on a running instance).

> Note: a command-line-loaded extension stays active for that browser session.
> For a permanent install, use the manual steps below (one minute, once).

## 2. Manual setup — video guide

Watch **`manual-setup-guide.mp4`** (narrated, ~1 minute):
unzip → `chrome://extensions` → Developer mode → Load unpacked →
select the `extension/` folder → run the interview.

## 3. Interview walkthrough — video guide

Watch **`interview-walkthrough.mp4`** before (or during) your first calibration:
what each of the 4 interview steps measures, why it matters, and how to redo
any step. You can re-run the interview anytime from the extension popup.

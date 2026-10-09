#!/usr/bin/env python3
"""BlinkScroll automatic setup — cross-platform (Windows / macOS / Linux).

Detects your default browser (falling back to your most-used Chromium
browser) and loads the BlinkScroll extension into it.

Usage:
    python3 auto_setup.py                # detect + launch (this session)
    python3 auto_setup.py --permanent    # patch your launcher: loads on EVERY start
    python3 auto_setup.py --undo         # remove the permanent patch
    python3 auto_setup.py --dry-run      # only report what would happen

How it works:
  1. Detect the default browser (OS-specific). If that fails, pick the
     Chromium browser whose profile folder was modified most recently
     ("most used"). Final fallback: first Chromium binary on PATH.
  2. If that browser is already running, stop and ask you to close it:
     Chromium ignores --load-extension in an already-running instance.
  3. Launch it with --load-extension=<extension dir>.

Note: a command-line-loaded extension is active for that browser session.
For a permanent install, follow the 1-minute manual guide
(setup/manual-setup-guide.mp4).
"""
from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys

# (script lives in setup/ — the extension is the sibling ../extension dir)
EXT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "extension"))

BROWSERS = {
    "brave": {
        "label": "Brave",
        "linux_bins": ["brave-browser", "brave"],
        "mac_bin": "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "win_rel": r"BraveSoftware\Brave-Browser\Application\brave.exe",
        "prog_ids": ["BraveHTML"],
        "bundle_ids": ["com.brave.Browser"],
        "desktop": "brave-browser.desktop",
        "profiles": [
            "~/.config/BraveSoftware/Brave-Browser",
            "~/Library/Application Support/BraveSoftware/Brave-Browser",
            "%LOCALAPPDATA%/BraveSoftware/Brave-Browser/User Data",
        ],
        "procs": ["brave", "brave.exe"],
    },
    "chrome": {
        "label": "Google Chrome",
        "linux_bins": ["google-chrome", "chrome"],
        "mac_bin": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "win_rel": r"Google\Chrome\Application\chrome.exe",
        "prog_ids": ["ChromeHTML"],
        "bundle_ids": ["com.google.Chrome"],
        "desktop": "google-chrome.desktop",
        "profiles": [
            "~/.config/google-chrome",
            "~/Library/Application Support/Google/Chrome",
            "%LOCALAPPDATA%/Google/Chrome/User Data",
        ],
        "procs": ["chrome", "chrome.exe"],
    },
    "edge": {
        "label": "Microsoft Edge",
        "linux_bins": ["microsoft-edge", "edge"],
        "mac_bin": "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "win_rel": r"Microsoft\Edge\Application\msedge.exe",
        "prog_ids": ["MSEdgeHTM"],
        "bundle_ids": ["com.microsoft.edgemac"],
        "desktop": "microsoft-edge.desktop",
        "profiles": [
            "~/.config/microsoft-edge",
            "~/Library/Application Support/Microsoft Edge",
            "%LOCALAPPDATA%/Microsoft/Edge/User Data",
        ],
        "procs": ["msedge", "msedge.exe", "edge"],
    },
    "chromium": {
        "label": "Chromium",
        "linux_bins": ["chromium", "chromium-browser"],
        "mac_bin": "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "win_rel": r"Chromium\Application\chrome.exe",
        "prog_ids": ["ChromiumHTM"],
        "bundle_ids": ["org.chromium.Chromium"],
        "desktop": "chromium.desktop",
        "profiles": [
            "~/.config/chromium",
            "~/Library/Application Support/Chromium",
            "%LOCALAPPDATA%/Chromium/User Data",
        ],
        "procs": ["chromium"],
    },
}

SYSTEM = platform.system()  # Windows | Darwin | Linux


def expand(p: str) -> str:
    return os.path.expandvars(os.path.expanduser(p))


def newest_mtime(path: str) -> float:
    """Most recent mtime under a profile dir (0 if missing)."""
    try:
        best = 0.0
        base_depth = path.rstrip(os.sep).count(os.sep)
        for dirpath, dirnames, filenames in os.walk(path):
            for fn in filenames:
                try:
                    m = os.path.getmtime(os.path.join(dirpath, fn))
                    if m > best:
                        best = m
                except OSError:
                    pass
            # don't descend forever — top levels are enough signal
            if dirpath.count(os.sep) - base_depth > 2:
                dirnames[:] = []
        return best
    except OSError:
        return 0.0


def default_browser_key() -> str | None:
    """OS-specific default-browser detection. Returns a BROWSERS key."""
    try:
        if SYSTEM == "Linux":
            out = subprocess.run(
                ["xdg-settings", "get", "default-web-browser"],
                capture_output=True, text=True, timeout=10,
            ).stdout.strip()
            for key, b in BROWSERS.items():
                if b["desktop"] and out == b["desktop"]:
                    return key
        elif SYSTEM == "Darwin":
            out = subprocess.run(
                ["defaults", "read",
                 "com.apple.LaunchServices/com.apple.launchservices.secure",
                 "LSHandlers"],
                capture_output=True, text=True, timeout=10,
            ).stdout
            # find the handler for http/https
            bundle = None
            for line in out.splitlines():
                if "LSHandlerRoleAll" in line:
                    # next LSHandlerURLScheme line tells us the scheme; simpler:
                    pass
            import re
            pairs = re.findall(
                r"LSHandlerURLScheme = (\w+);\s*LSHandlerRoleAll = ([\w.]+);", out)
            for scheme, bid in pairs:
                if scheme in ("http", "https"):
                    bundle = bid
                    break
            if bundle:
                for key, b in BROWSERS.items():
                    if bundle in b["bundle_ids"]:
                        return key
        elif SYSTEM == "Windows":
            import winreg
            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice",
            ) as k:
                prog_id = winreg.QueryValueEx(k, "ProgId")[0]
            for key, b in BROWSERS.items():
                if prog_id in b["prog_ids"]:
                    return key
    except Exception:
        pass
    return None


def most_used_browser_key() -> str | None:
    best, best_key = 0.0, None
    for key, b in BROWSERS.items():
        for p in b["profiles"]:
            m = newest_mtime(expand(p))
            if m > best:
                best, best_key = m, key
    return best_key


def find_binary(key: str) -> str | None:
    b = BROWSERS[key]
    if SYSTEM == "Linux":
        for name in b["linux_bins"]:
            path = shutil.which(name)
            if path:
                return path
    elif SYSTEM == "Darwin":
        if os.path.exists(b["mac_bin"]):
            return b["mac_bin"]
    elif SYSTEM == "Windows":
        for base in (os.environ.get("PROGRAMFILES", ""),
                     os.environ.get("PROGRAMFILES(X86)", ""),
                     os.environ.get("LOCALAPPDATA", "")):
            cand = os.path.join(base, b["win_rel"])
            if os.path.exists(cand):
                return cand
    return None


def is_running(key: str) -> bool:
    procs = BROWSERS[key]["procs"]
    try:
        if SYSTEM == "Windows":
            out = subprocess.run(["tasklist"], capture_output=True,
                                 text=True, timeout=10).stdout.lower()
        else:
            out = subprocess.run(["ps", "-A", "-o", "comm="], capture_output=True,
                                 text=True, timeout=10).stdout.lower()
        return any(p.lower() in out for p in procs)
    except Exception:
        return False


# --- permanent setup: patch the browser launcher ---------------------------
# A fully silent permanent install is impossible by design (Chromium treats
# it as malware behavior). The sanctioned permanent route is the Chrome Web
# Store. Until then, this patches your launcher so EVERY browser start loads
# the extension — one script run, permanent effect, trivially reversible.

def set_permanent(key: str, enable: bool) -> bool:
    if SYSTEM == "Linux":
        return set_permanent_linux(key, enable)
    if SYSTEM == "Windows":
        return set_permanent_windows(key, enable)
    print("macOS: patching the app launcher would break its code signature,")
    print("so automatic permanent setup isn't offered there.")
    print("Manual alternative: add the extension once via")
    print("setup/manual-setup-guide.mp4 — it stays installed.")
    return False


def set_permanent_linux(key: str, enable: bool) -> bool:
    import re
    desktop_name = BROWSERS[key]["desktop"]
    src = None
    for d in ("/usr/share/applications",
              os.path.expanduser("~/.local/share/applications")):
        cand = os.path.join(d, desktop_name)
        if os.path.exists(cand):
            src = cand
            break
    if not src:
        print(f"Could not find {desktop_name} — is {BROWSERS[key]['label']} "
              f"installed via the system package manager / official repo?")
        return False
    dst_dir = os.path.expanduser("~/.local/share/applications")
    os.makedirs(dst_dir, exist_ok=True)
    dst = os.path.join(dst_dir, desktop_name)
    with open(src) as f:
        content = f.read()
    # strip any previous flag first (idempotent)
    content = re.sub(r"\s*--load-extension=\S+", "", content)
    if enable:
        flag = f"--load-extension={EXT_DIR}"
        # insert right after the binary, before %U/%F field codes
        content, n = re.subn(r"^(Exec=\S+)(.*)$", r"\1 " + flag + r"\2",
                             content, flags=re.M)
        if n == 0:
            print("Could not parse the Exec line in the launcher file.")
            return False
    with open(dst, "w") as f:
        f.write(content)
    try:  # best effort; harmless if the tool is missing
        subprocess.run(["update-desktop-database", dst_dir],
                       capture_output=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        pass
    action = "installed permanently into" if enable else "removed from"
    print(f"Launcher patched: {dst}")
    print(f"BlinkScroll {action} your {BROWSERS[key]['label']} launcher" +
          (" — it will load on every start." if enable
           else " — back to a stock launcher."))
    return True


def set_permanent_windows(key: str, enable: bool) -> bool:
    # Rewrites the Arguments of every Brave/Chrome/Edge shortcut on the
    # Desktop and Start Menu via PowerShell (WScript.Shell COM).
    exe = os.path.basename(find_binary(key) or "")
    if not exe:
        return False
    flag = f"--load-extension={EXT_DIR}"
    ps = r"""
$flag = $args[0]; $exe = $args[1]; $enable = $args[2] -eq '1'
$dirs = @("$env:USERPROFILE\Desktop",
          "$env:APPDATA\Microsoft\Windows\Start Menu\Programs")
$fixed = 0
foreach ($dir in $dirs) {
  if (-not (Test-Path $dir)) { continue }
  Get-ChildItem $dir -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    $sh = New-Object -ComObject WScript.Shell
    $lnk = $sh.CreateShortcut($_.FullName)
    if ($lnk.TargetPath -like "*$exe") {
      $a = $lnk.Arguments -replace '\s*--load-extension=\S+', ''
      if ($enable) { $a = ($a + ' ' + $flag).Trim() }
      $lnk.Arguments = $a; $lnk.Save(); $fixed++
    }
  }
}
Write-Output "patched $fixed shortcut(s)"
"""
    r = subprocess.run(
        ["powershell", "-NoProfile", "-Command", ps, "--", flag, exe,
         "1" if enable else "0"],
        capture_output=True, text=True, timeout=60)
    print(r.stdout.strip() or r.stderr.strip()[-300:])
    ok = r.returncode == 0
    if ok:
        action = "installed permanently into" if enable else "removed from"
        suffix = (" — it will load on every start." if enable
                  else " — back to stock shortcuts.")
        print(f"BlinkScroll {action} your {BROWSERS[key]['label']} shortcuts{suffix}")
    else:
        print("Windows permanent setup is UNVERIFIED on a real machine — "
              "if it failed, use the manual guide.")
    return ok


def main() -> int:
    dry = "--dry-run" in sys.argv
    permanent = "--permanent" in sys.argv
    undo = "--undo" in sys.argv
    print("BlinkScroll automatic setup")
    print("===========================")

    if not os.path.isdir(EXT_DIR) or not os.path.exists(
            os.path.join(EXT_DIR, "manifest.json")):
        print(f"ERROR: extension folder not found at {EXT_DIR}")
        print("Keep auto_setup.py inside setup/ next to the extension/ folder.")
        return 1

    key = default_browser_key()
    how = "default browser"
    if not key:
        key = most_used_browser_key()
        how = "most recently used browser"
    if not key:
        for k in BROWSERS:  # last resort: whatever is installed
            if find_binary(k):
                key, how = k, "first Chromium browser found"
                break
    if not key:
        print("ERROR: no Chromium browser (Brave/Chrome/Edge/Chromium) found.")
        print("Install one, then re-run — or follow setup/manual-setup-guide.mp4.")
        return 1

    binary = find_binary(key)
    if not binary:
        print(f"Detected {BROWSERS[key]['label']} as your {how}, but couldn't "
              f"locate its executable.")
        return 1

    print(f"Browser : {BROWSERS[key]['label']} ({how})")
    print(f"Binary  : {binary}")
    print(f"Extension: {EXT_DIR}")

    if permanent or undo:
        # Patch the launcher so the extension loads on EVERY start.
        # No need to close the browser — this takes effect next launch.
        ok = set_permanent(key, enable=permanent)
        if ok and permanent:
            print()
            print("Note: on first launch Brave may show a small “developer mode")
            print("extensions” notice — just dismiss it. (That notice disappears")
            print("entirely once BlinkScroll is published to the Web Store.)")
        return 0 if ok else 1

    if is_running(key):
        print()
        print(f"{BROWSERS[key]['label']} is currently running.")
        print("Chromium ignores --load-extension on a running instance, so:")
        print(f"  1. Close {BROWSERS[key]['label']} completely, then")
        print("  2. Re-run:  python3 auto_setup.py")
        return 2

    cmd = [binary, f"--load-extension={EXT_DIR}"]
    if dry:
        print("dry-run: would launch:")
        print("  " + " ".join(f'"{c}"' if " " in c else c for c in cmd))
        return 0

    print("Launching with the extension loaded...")
    subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)
    print()
    print("Done. The calibration interview should open automatically.")
    print("Note: this loads BlinkScroll for this browser session. For a")
    print("permanent install, see setup/manual-setup-guide.mp4 (1 minute).")
    return 0


if __name__ == "__main__":
    sys.exit(main())

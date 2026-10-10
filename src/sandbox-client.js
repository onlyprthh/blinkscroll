// sandbox-client.js — runs in extension pages (offscreen doc, interview page).
// Drives the sandboxed WASM detector iframe via postMessage.
// Usage:
//   const det = new SandboxDetector(document.getElementById('detector'));
//   await det.ready;                       // model loaded (or det.failed set)
//   const { ear, hasFace } = await det.detect(bitmap, performance.now());
export class SandboxDetector {
  constructor(iframe) {
    this.iframe = iframe;
    this._seq = 0;
    this._pending = new Map();
    this._failed = null;
    this._readyDone = false;
    this._readyResolve = null;
    this.ready = new Promise((r) => { this._readyResolve = r; });
    window.addEventListener('message', (e) => this._onMessage(e));
    // If the sandbox never answers (blocked iframe, crashed WASM), fail
    // loudly after 30s instead of hanging callers forever.
    setTimeout(() => {
      if (!this._readyDone) {
        this._failed = 'Face detector did not start. Reload the page — if it persists, your browser may be blocking the extension sandbox.';
        this._readyDone = true;
        this._readyResolve();
      }
    }, 30000);
  }

  _onMessage(e) {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'bs-ready') {
      this._readyDone = true;
      this._readyResolve();
    } else if (m.type === 'bs-error' && m.fatal) {
      this._failed = m.message;
      this._readyDone = true;
      this._readyResolve();
    } else if (m.type === 'bs-result') {
      const p = this._pending.get(m.id);
      if (p) {
        this._pending.delete(m.id);
        p(m);
      }
    }
  }

  get failed() { return this._failed; }

  detect(bitmap, ts) {
    return this.ready.then(() => {
      if (this._failed) throw new Error(this._failed);
      const id = ++this._seq;
      return new Promise((resolve) => {
        // A frame that never comes back (sandbox crashed mid-frame) must
        // not wedge the pipeline: time out and keep the loop alive.
        const timer = setTimeout(() => {
          this._pending.delete(id);
          try { bitmap.close(); } catch { /* transferred or already closed */ }
          resolve({ ear: null, hasFace: false, timedOut: true });
        }, 5000);
        this._pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
        // Transfer the bitmap (zero-copy); the sandbox closes it when done.
        this.iframe.contentWindow.postMessage(
          { type: 'bs-frame', id, ts, bitmap }, '*', [bitmap]);
      });
    });
  }
}

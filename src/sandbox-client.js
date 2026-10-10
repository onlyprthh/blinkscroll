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
    this._readyResolve = null;
    this.ready = new Promise((r) => { this._readyResolve = r; });
    window.addEventListener('message', (e) => this._onMessage(e));
  }

  _onMessage(e) {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'bs-ready') {
      this._readyResolve();
    } else if (m.type === 'bs-error' && m.fatal) {
      this._failed = m.message;
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
        this._pending.set(id, resolve);
        // Transfer the bitmap (zero-copy); the sandbox closes it when done.
        this.iframe.contentWindow.postMessage(
          { type: 'bs-frame', id, ts, bitmap }, '*', [bitmap]);
      });
    });
  }
}

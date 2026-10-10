// Bridge between extension pages and the opaque-origin sandboxed detector iframe.
export class SandboxDetector {
  constructor(iframe) {
    if (!iframe || !iframe.contentWindow) {
      throw new Error('Face detector iframe is missing');
    }
    this.iframe = iframe;
    this._seq = 0;
    this._pending = new Map();
    this._failed = null;
    this._readyDone = false;
    this._readyResolve = null;
    this._readyTimer = null;
    this.ready = new Promise(resolve => { this._readyResolve = resolve; });
    this._onMessageBound = event => this._onMessage(event);
    window.addEventListener('message', this._onMessageBound);

    // Fail visibly if the iframe never signals that MediaPipe finished loading.
    this._readyTimer = setTimeout(() => {
      if (this._readyDone) return;
      this._failed = 'Face detector did not start. Reload the page; the browser may be blocking the extension sandbox.';
      this._finishReady();
    }, 30000);
  }

  _finishReady() {
    if (this._readyDone) return;
    this._readyDone = true;
    if (this._readyTimer) clearTimeout(this._readyTimer);
    this._readyTimer = null;
    this._readyResolve();
  }

  _onMessage(event) {
    // Sandboxed frames have an opaque origin. Validate the source window instead.
    if (event.source !== this.iframe.contentWindow) return;
    const message = event.data;
    if (!message || typeof message !== 'object') return;

    if (message.type === 'bs-ready') {
      this._finishReady();
    } else if (message.type === 'bs-error' && message.fatal) {
      this._failed = String(message.message || 'Face detector failed to initialize');
      this._finishReady();
    } else if (message.type === 'bs-result' && Number.isInteger(message.id)) {
      const resolve = this._pending.get(message.id);
      if (resolve) {
        this._pending.delete(message.id);
        resolve({
          ear: Number.isFinite(message.ear) ? message.ear : null,
          hasFace: message.hasFace === true,
        });
      }
    }
  }

  get failed() { return this._failed; }

  async detect(bitmap, timestampMs) {
    await this.ready;
    if (this._failed) {
      try { bitmap?.close(); } catch { /* already transferred/closed */ }
      throw new Error(this._failed);
    }
    if (!bitmap || !Number.isFinite(timestampMs)) {
      try { bitmap?.close(); } catch { /* no-op */ }
      return { ear: null, hasFace: false, invalidFrame: true };
    }

    const id = ++this._seq;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        try { bitmap.close(); } catch { /* transferred or already closed */ }
        resolve({ ear: null, hasFace: false, timedOut: true });
      }, 5000);

      this._pending.set(id, result => {
        clearTimeout(timer);
        resolve(result);
      });

      try {
        // Transfer rather than clone to avoid copying every video frame.
        this.iframe.contentWindow.postMessage(
          { type: 'bs-frame', id, ts: timestampMs, bitmap }, '*', [bitmap]);
      } catch (error) {
        clearTimeout(timer);
        this._pending.delete(id);
        try { bitmap.close(); } catch { /* no-op */ }
        resolve({ ear: null, hasFace: false, error: String(error?.message || error) });
      }
    });
  }
}

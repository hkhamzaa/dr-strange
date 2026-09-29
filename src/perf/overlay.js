// ?perf=1 only. Frame time (avg/p95), draw calls, triangles, GPU time (EXT_disjoint_timer_query_webgl2
// when present), detection ms, JS heap (Chrome only), and the current quality tier. Reads what
// app.js hands it — same "no second source of truth" rule as the debug HUD.
export class PerfOverlay {
  constructor(renderer) {
    this.gl = renderer.getContext();
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.pendingQuery = null;
    this.gpuMs = 0;
    this.samples = [];

    this.panel = document.createElement('div');
    Object.assign(this.panel.style, {
      position: 'fixed', bottom: '12px', right: '12px', zIndex: 52, font: '12px/1.5 ui-monospace, monospace',
      color: '#c8ffea', background: 'rgba(4, 12, 10, 0.75)', border: '1px solid rgba(120, 255, 210, 0.3)',
      borderRadius: '8px', padding: '8px 10px', whiteSpace: 'pre', pointerEvents: 'none',
    });
    document.body.appendChild(this.panel);
  }

  beginGpuQuery() {
    if (!this.ext || this.pendingQuery) return;
    this.pendingQuery = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.pendingQuery);
  }
  endGpuQuery() {
    if (!this.ext || !this.pendingQuery) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
  }
  _pollGpuQuery() {
    if (!this.ext || !this.pendingQuery) return;
    const gl = this.gl, q = this.pendingQuery;
    if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
      this.gpuMs = ns / 1e6;
      gl.deleteQuery(q);
      this.pendingQuery = null;
    }
  }

  sample(frameMs) {
    this.samples.push(frameMs);
    if (this.samples.length > 120) this.samples.shift();
    this._pollGpuQuery();
  }

  update({ renderer, detectMs, tier, sessionCount, renderFps = 0, detectFps = 0, latencyMs = 0 }) {
    const s = [...this.samples].sort((a, b) => a - b);
    const avg = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
    const p95 = s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : 0;
    const info = renderer.info;
    const heap = performance.memory ? `${(performance.memory.usedJSHeapSize / 1048576).toFixed(1)}MB` : 'n/a';
    this.panel.textContent =
      `render ${renderFps.toFixed(0)}fps  detect ${detectFps.toFixed(0)}fps  latency ${latencyMs.toFixed(0)}ms\n` +
      `frame: ${avg.toFixed(2)}ms avg  ${p95.toFixed(2)}ms p95  (${(1000 / Math.max(avg, 0.01)).toFixed(0)}fps of CPU headroom)\n` +
      `gpu: ${this.ext ? this.gpuMs.toFixed(2) + 'ms' : 'n/a (no timer-query ext)'}\n` +
      `draws: ${info.render.calls}  tris: ${info.render.triangles}\n` +
      `detect: ${detectMs.toFixed(1)}ms  heap: ${heap}\n` +
      `quality: ${tier}  sigils: ${sessionCount}`;
  }

  dispose() { this.panel.remove(); }
}

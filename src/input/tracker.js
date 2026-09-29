// Webcam + MediaPipe HandLandmarker. Detection runs in a Web Worker (detectWorker.js), paced by the
// video element's own frame callback — never by the render loop, and never on its thread. One
// frame is in flight at a time: a camera frame that arrives while the worker is still busy is
// dropped, not queued, so results are always about the newest frame the worker could take.
// Browsers that can't run the worker fall back to detecting on the main thread (same pacing).
import { CFG } from '../config.js';

// Third-party code and the model live under vendor/ (not node_modules/: some hosts strip folders with
// that name from static output). scripts/dev-server.mjs aliases vendor/ to node_modules in dev; build.mjs copies it.
const VISION = new URL('vendor/mediapipe/vision_bundle.mjs', location.href).href;
const WASM = new URL('vendor/mediapipe/wasm', location.href).href;
const MODEL = new URL('vendor/models/hand_landmarker.task', location.href).href;

const pts = () => Array.from({ length: 21 }, () => [0, 0]);

/** Fetch each asset the tracker needs and report what's wrong with any that isn't right: status,
 *  MIME type, and size (a truncated file or an HTML error page served with 200 both show up as
 *  "too small"). Only ever run after a failed/slow load, to name the URL responsible. */
export async function diagnoseAssets(budgetMs = 10000) {
  const checks = [
    [VISION, /javascript/, 50e3],
    [`${WASM}/vision_wasm_internal.js`, /javascript/, 50e3],
    [`${WASM}/vision_wasm_internal.wasm`, /application\/wasm/, 5e6],
    [MODEL, null, 5e6],
  ];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), budgetMs);
  try {
    return await Promise.all(checks.map(async ([url, type, minBytes]) => {
      try {
        const r = await fetch(url, { cache: 'no-store', signal: ctl.signal });
        const bytes = (await r.arrayBuffer()).byteLength, ct = r.headers.get('content-type') || '';
        const problem = !r.ok ? `HTTP ${r.status}` : type && !type.test(ct) ? `wrong content-type "${ct}"`
          : bytes < minBytes ? `only ${bytes} bytes (truncated, or an error page served as 200)` : null;
        return { url, status: r.status, type: ct, bytes, problem };
      } catch (e) {
        return { url, problem: e.name === 'AbortError' ? `no complete response within ${budgetMs} ms` : `network error: ${e.message}` };
      }
    }));
  } finally { clearTimeout(timer); }
}

export class HandCamera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.running = false;
    this.paused = false;         // tab hidden
    this.mode = null;            // 'worker' | 'main'
    this.delegate = null;
    this.onHands = null;         // (hands, tSeconds) => void
    this.onPreview = null;       // () => void — camera is playing (before the tracker has loaded)
    this.onEnded = null;         // () => void — the camera track ended (unplugged, taken by another app)
    this._stopped = false;
    this.minInterval = 0;        // seconds; the app raises this to probe slowly while nobody's there
    this.lastTs = 0;
    this.lastMediaTime = -1;
    this.lastDetectT = -1e9;
    this.frames = 0;             // detections completed
    this.fps = 0;                // detections per second
    this.detectMs = 0;
    this.latencyMs = 0;          // camera capture -> landmarks ready
    this._n = 0; this._t = performance.now();
    this.newFrame = false;       // a new video frame arrived since the renderer last looked
    this.worker = null; this.landmarker = null;
    this._busy = false;
    this._flat = new Float32Array(84);      // 2 hands x 21 x (x, y), ping-ponged with the worker
    this._buf = [pts(), pts()];
    this._out = [];
    this._pending = false;
    this._lastVfcAt = -1e9;
    this._captureAt = 0;
  }

  async start(onStatus = () => {}) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot access a camera (getUserMedia missing — use https or localhost).');
    onStatus('Requesting camera…');
    const c = CFG.tracker;
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: c.width }, height: { ideal: c.height }, frameRate: { ideal: c.fps, max: c.fps }, facingMode: 'user' },
      audio: false,
    });
    // watched from the moment the camera opens: a camera unplugged (or grabbed by another app)
    // during the tracker's multi-second load must surface, not leave a silently frozen feed
    const track = this.stream.getVideoTracks()[0];
    track?.addEventListener('ended', () => { if (!this._stopped) this.onEnded?.(); });
    this.video.srcObject = this.stream;
    this.video.muted = true; this.video.playsInline = true;
    await this.video.play();
    this.onPreview?.();          // the live picture can show now, while the tracker is still loading
    onStatus('Loading hand tracker…');
    const ended = () => Object.assign(new Error('The camera stopped while the hand tracker was loading.'), { name: 'NotReadableError' });
    const load = async () => {
      try { await this._startWorker(); this.mode = 'worker'; }
      catch (e) {
        if (this._stopped) throw ended();
        console.warn('worker detection unavailable, detecting on the main thread instead', e);
        await this._startMain(); this.mode = 'main';
      }
    };
    // never hang on "Loading hand tracker…": past the limit (or on a load error) find out which asset
    // is at fault, log its URL, and fail with a message the start screen can show next to a Retry
    let timer;
    const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { timedOut: true })), c.loadTimeoutS * 1000); });
    try { await Promise.race([load(), limit]); }
    catch (e) {
      if (this._stopped) throw ended();
      const report = await diagnoseAssets();
      const bad = report.find((r) => r.problem);
      console.error('[sigil] hand tracker failed to load', e, '\nasset check:', report);
      if (bad) console.error(`[sigil] failing URL: ${bad.url} — ${bad.problem}`);
      this.stop();
      const why = e.timedOut ? `didn't load within ${c.loadTimeoutS} s` : `failed to load (${String(e.message).split(String.fromCharCode(10))[0].slice(0, 120)})`;
      throw Object.assign(new Error(`The hand tracker ${why}. ${bad ? `Problem: ${bad.url} — ${bad.problem}.` : 'All its files fetched fine, so it may just be a slow connection or device.'}`), { name: 'TrackerLoadError', url: bad?.url });
    } finally { clearTimeout(timer); }
    if (this._stopped || track?.readyState === 'ended') { this.stop(); throw ended(); }
    this.running = true;
    onStatus('');
    this._schedule();
  }

  _startWorker() {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./detectWorker.js', import.meta.url), { type: 'module' });
      this.worker = w;
      const fail = (err) => { this._abortInit = null; w.terminate(); if (this.worker === w) this.worker = null; reject(err); };
      this._abortInit = () => fail(new Error('stopped during init'));
      w.onerror = (e) => { e.preventDefault?.(); fail(new Error(e.message || 'detection worker failed to load')); };
      w.onmessage = ({ data }) => {
        if (data.type === 'ready') {
          this._abortInit = null;
          this.delegate = data.delegate;
          w.onmessage = ({ data: d }) => this._onWorker(d);
          w.onerror = (e) => this._workerDied(e.message);
          resolve();
        } else if (data.type === 'error') fail(new Error(data.message));
      };
      w.postMessage({ type: 'init', vision: VISION, wasm: WASM, model: MODEL });
    });
  }

  async _startMain() {
    const { FilesetResolver, HandLandmarker } = await import(VISION);
    const fileset = await FilesetResolver.forVisionTasks(WASM);
    const make = (delegate) => HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: 'VIDEO', numHands: 2,
      minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    try { this.landmarker = await make('GPU'); this.delegate = 'GPU'; }
    catch (e) { console.warn('GPU delegate failed, falling back to CPU', e); this.landmarker = await make('CPU'); this.delegate = 'CPU'; }
    if (this._stopped) { this.landmarker.close?.(); this.landmarker = null; return; }    // the load timed out while we were still building
    this.landmarker.detectForVideo(this.video, this._nextTs());     // warm-up (GPU program compile) behind the loading message
  }

  _schedule() {
    if (!this.running || this._pending || !this.video.requestVideoFrameCallback) return;
    this._pending = true;
    this.video.requestVideoFrameCallback((now, meta) => { this._pending = false; this._lastVfcAt = now; this._onFrame(now, meta); });
  }

  /** Called by the render loop every frame; O(1) unless there's a new frame to hand off. The
   *  video-frame callback only fires for frames the browser actually presents, and it may skip
   *  presenting a hidden <video> — so if it's gone quiet (or doesn't exist), poll currentTime. */
  pump(nowMs) {
    if (!this.running || nowMs - (this._lastVfcAt || -1e9) < 250) return;
    this._onFrame(nowMs, null);
  }

  _nextTs() { this.lastTs = Math.max(Math.round(performance.now()), this.lastTs + 1); return this.lastTs; }   // must strictly increase

  _onFrame(now, meta) {
    if (!this.running) return;
    const v = this.video;
    const mediaTime = meta ? meta.mediaTime : v.currentTime;
    if (mediaTime !== this.lastMediaTime) {
      this.lastMediaTime = mediaTime;
      this.newFrame = true;
      if (!this.paused && !this._busy && v.readyState >= 2 && now / 1000 - this.lastDetectT >= this.minInterval) {
        this.lastDetectT = now / 1000;
        this._captureAt = meta?.captureTime || now;
        if (this.mode === 'worker') this._sendToWorker(now / 1000);
        else if (this.mode === 'main') { this._busy = true; setTimeout(() => { this._busy = false; if (this.running) this._detectHere(now / 1000); }, 0); }   // its own task, never inside a render frame
      }
    }
    if (meta) this._schedule();
  }

  _sendToWorker(t) {
    this._busy = true;
    this._detectCopy().then((bitmap) => {
      if (!this.running || !this.worker) { bitmap.close(); this._busy = false; return; }
      this.worker.postMessage({ type: 'frame', bitmap, ts: this._nextTs(), buf: this._flat, t }, [bitmap, this._flat.buffer]);
    }, () => { this._busy = false; });
  }

  /** The frame detection sees: a downscaled copy (aspect kept), so the visible feed can be 720p
   *  without detection paying for it. Landmarks are normalized, so the scale never matters downstream. */
  _detectCopy() {
    const v = this.video, dw = CFG.tracker.detectWidth;
    if (v.videoWidth > dw && this._resizeOk !== false) {
      return createImageBitmap(v, { resizeWidth: dw, resizeHeight: Math.round((dw * v.videoHeight) / v.videoWidth), resizeQuality: 'low' })
        .catch(() => { this._resizeOk = false; return createImageBitmap(v); });   // a browser without resize options: full frame
    }
    return createImageBitmap(v);
  }

  _workerDied(why) {
    console.error(`hand-detection worker stopped (${why || 'unknown error'}); continuing on the main thread`);
    this.worker?.terminate(); this.worker = null;
    this.mode = 'starting';
    this._startMain().then(() => { this.mode = 'main'; this._busy = false; }, (e) => console.error('main-thread detection failed too', e));
  }

  _onWorker(d) {
    if (d.type === 'fatal') { this._workerDied(d.message); return; }
    if (d.type !== 'hands') return;
    this._flat = d.buf;
    this._busy = false;
    this.detectMs = d.detectMs;
    const out = this._out;
    out.length = 0;
    for (let h = 0; h < d.n; h++) {
      const dst = this._buf[h], o = h * 42;
      for (let i = 0; i < 21; i++) { dst[i][0] = 1 - d.buf[o + i * 2]; dst[i][1] = d.buf[o + i * 2 + 1]; }   // mirror x: selfie view
      out.push(dst);
    }
    this._delivered(d.t);
  }

  _detectHere(t) {
    const t0 = performance.now();
    const found = this.landmarker.detectForVideo(this.video, this._nextTs()).landmarks || [];
    this.detectMs = performance.now() - t0;
    const out = this._out;
    out.length = 0;
    for (let h = 0; h < found.length && h < 2; h++) {
      const src = found[h], dst = this._buf[h];
      for (let i = 0; i < 21; i++) { dst[i][0] = 1 - src[i].x; dst[i][1] = src[i].y; }
      out.push(dst);
    }
    this._delivered(t);
  }

  _delivered(t) {
    const now = performance.now();
    this.latencyMs = now - this._captureAt;
    this.frames++; this._n++;
    if (now - this._t > 1000) { this.fps = (this._n * 1000) / (now - this._t); this._n = 0; this._t = now; }
    this.onHands?.(this._out, t);
  }

  stop() {
    this._stopped = true;
    this.running = false;
    this._abortInit?.();
    this.stream?.getTracks().forEach((tr) => tr.stop());
    this.stream = null;
    this.worker?.terminate(); this.worker = null;
    this.landmarker?.close?.(); this.landmarker = null;
  }
}

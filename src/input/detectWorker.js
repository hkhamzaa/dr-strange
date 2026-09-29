// MediaPipe HandLandmarker off the main thread. The page posts one camera frame at a time (as a
// transferred ImageBitmap) and gets flat landmarks back in a transferred Float32Array that ping-
// pongs between the two sides, so the render loop never shares a thread with detection.
//
// tasks-vision loads its wasm glue with importScripts(), which throws in a module worker; it then
// falls back to a `self.import` hook if one exists. The glue declares a plain `var ModuleFactory`
// (module-scoped under a real import()), so this hook evaluates it and hands the factory back.
self.import = async (url) => {
  const src = await (await fetch(url)).text();
  self.ModuleFactory = new Function(`${src}\nreturn ModuleFactory;`)();
};

let landmarker = null;
let failures = 0;

async function init({ vision, wasm, model }) {
  const { FilesetResolver, HandLandmarker } = await import(vision);
  const fileset = await FilesetResolver.forVisionTasks(wasm);
  const make = (delegate) => HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: model, delegate },
    runningMode: 'VIDEO', numHands: 2,
    minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  let delegate = 'GPU';
  try { landmarker = await make('GPU'); } catch (e) { delegate = 'CPU'; landmarker = await make('CPU'); }
  // the first detection compiles GPU programs and can take seconds — pay for it here, behind the
  // loading message, not on the first real frame
  const warm = new OffscreenCanvas(64, 64);
  warm.getContext('2d').fillRect(0, 0, 64, 64);
  landmarker.detectForVideo(warm.transferToImageBitmap(), 1);
  return delegate;
}

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try { self.postMessage({ type: 'ready', delegate: await init(data) }); }
    catch (e) { self.postMessage({ type: 'error', message: String(e?.message || e) }); }
    return;
  }
  if (data.type === 'frame') {
    const { bitmap, ts, buf, t } = data;
    const t0 = performance.now();
    let n = 0;
    try {
      const found = landmarker.detectForVideo(bitmap, ts).landmarks || [];
      for (; n < found.length && n < 2; n++) {
        const src = found[n], o = n * 42;
        for (let i = 0; i < 21; i++) { buf[o + i * 2] = src[i].x; buf[o + i * 2 + 1] = src[i].y; }
      }
      failures = 0;
    } catch (e) {
      n = 0;
      // one bad frame is survivable; a detector that keeps throwing is not — tell the page
      if (++failures >= 5) { self.postMessage({ type: 'fatal', message: String(e?.message || e) }); return; }
    } finally { bitmap.close(); }
    self.postMessage({ type: 'hands', buf, n, t, detectMs: performance.now() - t0 }, [buf.buffer]);   // always hand the buffer back
  }
};

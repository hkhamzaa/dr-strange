// Perspective camera + renderer. Pixel ratio is clamped from config so integrated GPUs stay at 60fps.
import { CFG } from '../config.js';

/** WebGL2 is required (the shaders lean on it implicitly via three's renderer path); surfaced so
 *  app.js can show a friendly message instead of a blank canvas + console wall. */
export function hasWebGL2() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('experimental-webgl2'));
  } catch { return false; }
}

export function makeScene(THREE, canvas) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CFG.camera.fov, innerWidth / innerHeight, CFG.camera.near, CFG.camera.far);
  camera.position.set(0, 0, CFG.camera.dist);

  // antialias:false — the SDF shaders already do their own edge AA, and a multisampled default
  // framebuffer can't be read back with gl.readPixels. preserveDrawingBuffer so the test harness's
  // centerPixel()/screenshot readback sees the frame that was actually drawn, not a cleared one.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
  // EffectComposer calls renderer.render() once per pass, and info auto-resets on every one of
  // those — left on, draws/triangles would only ever reflect the composer's LAST internal pass.
  // app.js resets manually, once per real frame, so the perf overlay sees an honest per-frame total.
  renderer.info.autoReset = false;
  let dprClamp = CFG.dpr.clamp;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprClamp));
  renderer.setSize(innerWidth, innerHeight, false);
  // AR: the sigil scene renders on black and is laid over the camera by the composite pass
  renderer.setClearColor(CFG.background.mode === 'ar' ? new THREE.Color(0, 0, 0) : new THREE.Color(...CFG.color.background), 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // The sigil is many additive-blended layers stacked in a small radius — without tone mapping
  // their sum clips straight to white. OutputPass (the last composer pass) applies this at the end,
  // after bloom has extracted glow from the still-linear HDR render.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;

  // dynamic viewport height (dvh-equivalent, via visualViewport when a mobile browser's UI chrome
  // is showing/hiding) — falls back to innerHeight everywhere visualViewport isn't available.
  function viewportSize() {
    const vv = window.visualViewport;
    return vv ? [vv.width, vv.height] : [innerWidth, innerHeight];
  }

  function resize() {
    const [w, h] = viewportSize();
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  function setDprClamp(clamp) { dprClamp = clamp; renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprClamp)); }

  return { scene, camera, renderer, resize, setDprClamp, viewportSize };
}

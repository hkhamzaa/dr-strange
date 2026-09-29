// Perspective camera + renderer. Pixel ratio is clamped from config so integrated GPUs stay at 60fps.
import { CFG } from '../config.js';

export function makeScene(THREE, canvas) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CFG.camera.fov, innerWidth / innerHeight, CFG.camera.near, CFG.camera.far);
  camera.position.set(0, 0, CFG.camera.dist);

  // antialias:false — the SDF shaders already do their own edge AA, and a multisampled default
  // framebuffer can't be read back with gl.readPixels. preserveDrawingBuffer so the test harness's
  // centerPixel()/screenshot readback sees the frame that was actually drawn, not a cleared one.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CFG.dpr.clamp));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.setClearColor(new THREE.Color(...CFG.color.background), 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // The sigil is many additive-blended layers stacked in a small radius — without tone mapping
  // their sum clips straight to white. OutputPass (the last composer pass) applies this at the end,
  // after bloom has extracted glow from the still-linear HDR render.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;

  function resize() {
    const w = innerWidth, h = innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }

  return { scene, camera, renderer, resize };
}

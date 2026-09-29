// EffectComposer + UnrealBloomPass, strength/radius/threshold from config.
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CFG } from '../config.js';

/** `finalPass`: the composer's last pass — the stock OutputPass (void) or the AR composite. */
export function makeBloom(THREE, renderer, scene, camera, finalPass = new OutputPass()) {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bc = CFG.background.mode === 'ar' ? CFG.ar.bloom : CFG.bloom;
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), bc.strength, bc.radius, bc.threshold);
  composer.addPass(bloom);
  composer.addPass(finalPass);

  let scale = 1;
  const size = new THREE.Vector2();
  function resize() {
    renderer.getSize(size);                     // the renderer's (dynamic-viewport) size, set by scene.js just before
    composer.setSize(size.x, size.y);
    bloom.setSize(Math.round(size.x * scale), Math.round(size.y * scale));
  }
  // The quality governor's lever: UnrealBloomPass's own internal mip chain renders at whatever
  // resolution setSize() was last called with, independent of the composer's own (full-res) size
  // — a cheaper blur at low tiers without touching the final image's resolution. The library's mip
  // COUNT itself is fixed internally (not exposed for runtime reconfiguration), so "mip count" per
  // tier is approximated by resolution scale alone; see README "Performance findings".
  function setScale(s) { scale = s; resize(); }

  return { composer, bloom, resize, setScale };
}

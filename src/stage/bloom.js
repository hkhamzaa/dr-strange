// EffectComposer + UnrealBloomPass, strength/radius/threshold from config.
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CFG } from '../config.js';

export function makeBloom(THREE, renderer, scene, camera) {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), CFG.bloom.strength, CFG.bloom.radius, CFG.bloom.threshold);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  let scale = 1;
  function resize() {
    composer.setSize(innerWidth, innerHeight);
    bloom.setSize(Math.round(innerWidth * scale), Math.round(innerHeight * scale));
  }
  // The quality governor's lever: UnrealBloomPass's own internal mip chain renders at whatever
  // resolution setSize() was last called with, independent of the composer's own (full-res) size
  // — a cheaper blur at low tiers without touching the final image's resolution. The library's mip
  // COUNT itself is fixed internally (not exposed for runtime reconfiguration), so "mip count" per
  // tier is approximated by resolution scale alone; see README "Performance findings".
  function setScale(s) { scale = s; resize(); }

  return { composer, bloom, resize, setScale };
}

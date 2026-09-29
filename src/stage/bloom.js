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

  function resize() { composer.setSize(innerWidth, innerHeight); }
  return { composer, bloom, resize };
}

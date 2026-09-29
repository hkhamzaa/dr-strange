// One layer = one flat quad + one SDF ShaderMaterial. Layers know their own angular velocity and
// z-offset (for parallax under tilt); everything else about their animation state (reveal,
// intensity, shatter, dissolve) is pushed down from the owning Component/Sigil each frame.
import { CFG } from '../config.js';
import { ringMaterial, polygramMaterial, tickMaterial, glowDiscMaterial, runeBandMaterial } from './shaders.js';

// `colorRamp` lets a second sigil (Phase 3) use a different core/mid/outer without touching CFG.
const rampUniforms = (colorRamp, effectSeed) => ({
  core: colorRamp?.core ?? CFG.color.core,
  mid: colorRamp?.mid ?? CFG.color.mid,
  outer: colorRamp?.outer ?? CFG.color.outer,
  flickerAmp: CFG.stroke.flicker,
  flickerHz: CFG.stroke.flickerHz,
  glow: CFG.stroke.glow,
  aa: Math.max(0.0015, CFG.stroke.width * 0.35),
  edgeBoost: CFG.reveal.edgeBoost,
  maxR: 1.05,
  effectSeed,
});

export class Layer {
  constructor(THREE, cfg, atlasTexture, seed, colorRamp) {
    this.cfg = cfg;
    const geo = new THREE.PlaneGeometry(1, 1);
    let mat;
    const uni = rampUniforms(colorRamp, seed * 0.371 + 4.2);
    if (cfg.type === 'ring') mat = ringMaterial(THREE, { ...cfg, thickness: CFG.stroke.width + cfg.thickness }, uni);
    else if (cfg.type === 'star' || cfg.type === 'polygon') mat = polygramMaterial(THREE, { ...cfg, thickness: CFG.stroke.width + cfg.thickness }, uni);
    else if (cfg.type === 'tick') mat = tickMaterial(THREE, { ...cfg, thickness: CFG.stroke.width + cfg.thickness }, uni);
    else if (cfg.type === 'glowDisc') mat = glowDiscMaterial(THREE, cfg, uni);
    else if (cfg.type === 'runeBand') mat = runeBandMaterial(THREE, cfg, uni, atlasTexture, seed);
    else throw new Error(`unknown layer type: ${cfg.type}`);
    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.z = cfg.z;
    this.mesh.frustumCulled = false;
  }

  /** angle in radians accumulated so far, driven by the owning component's spin multiplier. */
  spin(dt, spinMul) {
    this.mesh.rotation.z += this.cfg.spinny * spinMul * dt;
  }

  setTime(t) { this.material.uniforms.uTime.value = t; }
  setReveal(v) { this.material.uniforms.uReveal.value = v; }
  setIntensity(v) { this.material.uniforms.uIntensity.value = v; }
  setShatter(v) { this.material.uniforms.uShatter.value = v; }
  setDissolve(v) { this.material.uniforms.uDissolve.value = v; }
  setShatterCells(angular, radial) { this.material.uniforms.uCellsAngular.value = angular; this.material.uniforms.uCellsRadial.value = radial; }

  /** Geometry + material are this layer's own (the shared rune atlas texture is disposed once, by
   *  Sigil, not per-layer) — releases the GPU-side buffers when a sigil goes away for good. */
  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

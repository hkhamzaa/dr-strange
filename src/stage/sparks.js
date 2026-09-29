// Small additive ember particles drifting upward around the sigil. Positions and per-particle
// phase are precomputed once; update() just advances a shader uniform, no per-frame allocation.
import { CFG } from '../config.js';
import { makeRng } from '../lib/rng.js';

const VERT = /* glsl */ `
attribute float aPhase;
attribute float aScale;
uniform float uTime;
uniform float uSpeed;
uniform float uSpread;
varying float vFade;
void main() {
  vec3 p = position;
  float life = fract(uTime * uSpeed * 0.15 + aPhase);
  p.y += life * uSpread;
  float wob = sin((uTime + aPhase * 40.0) * 1.3) * 0.05;
  p.x += wob; p.z += wob * 0.6;
  vFade = sin(life * 3.14159265359);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aScale * (3.2 / -mv.z);
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying float vFade;
uniform vec3 uColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a = smoothstep(0.5, 0.0, d) * vFade;
  gl_FragColor = vec4(uColor, a);
}
`;

export function makeSparks(THREE) {
  // Always allocate the full (high-tier) count once; the quality governor scales visible count via
  // setDrawRange() — no reallocation, no per-tier-change garbage.
  const n = CFG.sparks.count;
  const rng = makeRng(CFG.seed + 4242);
  const pos = new Float32Array(n * 3), phase = new Float32Array(n), scale = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = rng.random() * Math.PI * 2, r = 0.3 + rng.random() * CFG.sparks.spread;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = CFG.floor.y + rng.random() * 0.3;
    pos[i * 3 + 2] = Math.sin(a) * r;
    phase[i] = rng.random();
    scale[i] = CFG.sparks.size * (0.5 + rng.random());
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  geo.setAttribute('aScale', new THREE.BufferAttribute(scale, 1));
  geo.setDrawRange(0, n);
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG,
    uniforms: { uTime: { value: 0 }, uSpeed: { value: CFG.sparks.riseSpeed * 40 }, uSpread: { value: 1.4 }, uColor: { value: CFG.color.mid } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return {
    points,
    update: (t) => { mat.uniforms.uTime.value = t; },
    setCount: (count) => geo.setDrawRange(0, Math.min(n, Math.max(0, Math.round(count)))),
    dispose: () => { geo.dispose(); mat.dispose(); },
  };
}

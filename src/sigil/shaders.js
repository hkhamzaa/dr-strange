// Signed-distance-field line art for the sigil. Every layer is a flat quad; the fragment shader
// decides, per pixel, how far it sits from the nearest stroke and shades it with a soft glow and
// the orange-to-gold ramp. Shape constants (n, k, radius…) are baked as GLSL literals per layer at
// material-build time — only animation state (time, reveal, intensity, color) is uniform.
//
// Phase 3's shatter effect is fragment-shader-only, no geometry changes: shatterDisplace() splits
// the quad into an angular x radial cell grid and, per cell, samples the shape at a position pulled
// back from a random outward direction — so what lands on screen looks like that cell flew outward,
// without ever touching the mesh. Dissolve is a per-pixel noise threshold gated by the same
// progress value. Both fade through effectFade() and share one ignite flash at t=0.
import { CFG } from '../config.js';

const VERT = /* glsl */ `
varying vec2 vP;
uniform float uExtent;
void main() {
  vP = position.xy * uExtent;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy * uExtent, position.z, 1.0);
}
`;

// Shared across every fragment shader: segment distance, the emissive ramp, the reveal sweep, and
// the shatter/dissolve dismissal effects. `${...}` cell counts are baked in from config at module
// load, same spirit as every other shape constant in this file.
const FRAG_HEAD = /* glsl */ `
precision highp float;
varying vec2 vP;
uniform float uTime;
uniform float uIntensity;
uniform float uReveal;
uniform vec3 uColorCore;
uniform vec3 uColorMid;
uniform vec3 uColorOuter;
uniform float uFlickerAmp;
uniform float uFlickerHz;
uniform float uGlow;
uniform float uAA;
uniform float uEdgeBoost;
uniform float uMaxR;
uniform float uShatter;
uniform float uDissolve;
uniform float uEffectSeed;
uniform float uCellsAngular;
uniform float uCellsRadial;

float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0);
  return t < 0.5 ? mix(uColorCore, uColorMid, t * 2.0) : mix(uColorMid, uColorOuter, (t - 0.5) * 2.0);
}

float hash1(float n) { return fract(sin(n) * 43758.5453123); }

// Splits the quad into an angular x radial cell grid; each cell gets a random outward direction
// and speed. Sampling the shape at p MINUS that (eased) offset makes the pixel show whatever would
// be at the pulled-back spot — which reads on screen as that cell having flown outward by +offset.
vec2 shatterDisplace(vec2 p) {
  if (uShatter <= 0.0005) return p;
  float ang = atan(p.y, p.x);
  float rad = length(p);
  float angCell = floor((ang + 3.14159265359) / 6.28318530718 * uCellsAngular);
  float radCell = floor(clamp(rad / uMaxR, 0.0, 0.999) * uCellsRadial);
  float h = hash1(angCell * 13.7 + radCell * 91.3 + uEffectSeed);
  float h2 = hash1(angCell * 31.1 + radCell * 7.9 + uEffectSeed + 17.0);
  float dirAng = ang + (h - 0.5) * 1.6;
  vec2 dir = vec2(cos(dirAng), sin(dirAng));
  float speed = 0.5 + h2 * 1.3;
  float eased = uShatter * uShatter;
  return p - dir * eased * speed;
}

// Ember-erosion: a coarse per-pixel noise cell drops out once uDissolve passes its threshold, so
// the shape appears to erode away unevenly rather than fade as one flat sheet.
float dissolveMask(vec2 p) {
  if (uDissolve <= 0.0005) return 1.0;
  float n = hash1(floor(p.x * 37.0) * 91.7 + floor(p.y * 37.0) * 13.1 + uEffectSeed * 3.0);
  return step(uDissolve, n);
}

float effectFade(vec2 p) {
  float sFade = uShatter <= 0.0005 ? 1.0 : clamp(1.0 - uShatter * 1.1, 0.0, 1.0);
  return sFade * dissolveMask(p);
}

// A quick over-bright pop right as uShatter leaves 0 — "bloom peak on ignition".
float igniteBoost() { return 1.0 + exp(-uShatter * 9.0) * 2.2 * step(0.0005, uShatter); }

// d: signed distance to the stroke boundary (negative = inside). Returns premultiplied glow color.
// The glow is a halo AROUND the stroke, not a bonus on top of it — it's gated by (1 - core) so a
// pixel deep inside the line doesn't get core AND full glow stacked (that alone was enough to push
// every stroke past 1.0 and wash the whole sigil out to white once bloom and tone mapping saw it).
vec4 shade(float d, vec2 p) {
  float core = 1.0 - smoothstep(-uAA, uAA, d);
  float glowD = max(d, 0.0);
  float glow = exp(-glowD / max(uGlow, 1e-4)) * (1.0 - core);
  float breathe = 1.0 + uFlickerAmp * sin(uTime * uFlickerHz * 6.28318530718);
  float ang = (atan(p.y, p.x) + 3.14159265359) / 6.28318530718;
  float revealed = step(ang, uReveal);
  float edgeFront = revealed * exp(-clamp(uReveal - ang, 0.0, 1.0) * 26.0) * uEdgeBoost;
  vec3 col = ramp(length(p) / uMaxR) * (core + glow * 0.6) * uIntensity * breathe * (1.0 + edgeFront) * igniteBoost();
  float alpha = clamp(core + glow * 0.5, 0.0, 1.0) * revealed * effectFade(p);
  return vec4(col, alpha);
}
`;

// The uniforms rewritten every frame get their own class: a plain { value } literal shares its
// hidden class with the texture and color-array uniforms, so V8 keeps `value` as a tagged field and
// every float written to it allocates a fresh heap number. A float-only class stays unboxed.
class FloatUniform { constructor(v) { this.value = 0.5; this.value = v; } }   // seeded with a non-integer so the field starts as a double

function makeMaterial(THREE, fragBody, uniforms, extent) {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG_HEAD + fragBody,
    uniforms: {
      uExtent: { value: extent },
      uTime: new FloatUniform(0),
      uIntensity: new FloatUniform(1),
      uReveal: new FloatUniform(0),
      uColorCore: { value: uniforms.core },
      uColorMid: { value: uniforms.mid },
      uColorOuter: { value: uniforms.outer },
      uFlickerAmp: { value: uniforms.flickerAmp },
      uFlickerHz: { value: uniforms.flickerHz },
      uGlow: { value: uniforms.glow },
      uAA: { value: uniforms.aa },
      uEdgeBoost: { value: uniforms.edgeBoost },
      uMaxR: { value: uniforms.maxR },
      uShatter: new FloatUniform(0),
      uDissolve: new FloatUniform(0),
      uEffectSeed: { value: uniforms.effectSeed ?? 0 },
      uCellsAngular: { value: CFG.dismiss.shatter.cellsAngular },
      uCellsRadial: { value: CFG.dismiss.shatter.cellsRadial },
    },
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
}

function polygramEdges(n, k, r) {
  const edges = [];
  for (let i = 0; i < n; i++) {
    const a0 = (Math.PI * 2 * i) / n, a1 = (Math.PI * 2 * ((i + k) % n)) / n;
    edges.push([[Math.cos(a0) * r, Math.sin(a0) * r], [Math.cos(a1) * r, Math.sin(a1) * r]]);
  }
  return edges;
}

// Assumes `vec2 p` is already in scope; leaves a `float d` (distance to the nearest edge) declared.
function segChain(edges, thickness) {
  const calls = edges.map(([[ax, ay], [bx, by]]) =>
    `best = min(best, sdSegment(p, vec2(${ax.toFixed(6)}, ${ay.toFixed(6)}), vec2(${bx.toFixed(6)}, ${by.toFixed(6)})));`);
  return `
  float best = 1e9;
  ${calls.join('\n  ')}
  float d = best - ${thickness.toFixed(6)} * 0.5;
`;
}

export function ringMaterial(THREE, cfg, ramp) {
  const body = cfg.double
    ? `
void main() {
  vec2 sp = shatterDisplace(vP);
  float p = length(sp);
  float rOuter = ${(cfg.r + cfg.gap / 2).toFixed(6)};
  float rInner = ${(cfg.r - cfg.gap / 2).toFixed(6)};
  float dOuter = abs(p - rOuter) - ${cfg.thickness.toFixed(6)} * 0.5;
  float dInner = abs(p - rInner) - ${cfg.thickness.toFixed(6)} * 0.5;
  float d = min(dOuter, dInner);
  gl_FragColor = shade(d, sp);
}
`
    : `
void main() {
  vec2 sp = shatterDisplace(vP);
  float p = length(sp);
  float d = abs(p - ${cfg.r.toFixed(6)}) - ${cfg.thickness.toFixed(6)} * 0.5;
  gl_FragColor = shade(d, sp);
}
`;
  return makeMaterial(THREE, body, ramp, extentFor(cfg));
}

export function polygramMaterial(THREE, cfg, ramp) {
  const edges = polygramEdges(cfg.n, cfg.k ?? 1, cfg.r);
  const rotated = cfg.rotate
    ? edges.map(([[ax, ay], [bx, by]]) => {
        const c = Math.cos(cfg.rotate), s = Math.sin(cfg.rotate);
        return [[ax * c - ay * s, ax * s + ay * c], [bx * c - by * s, bx * s + by * c]];
      })
    : edges;
  const body = `
void main() {
  vec2 p = shatterDisplace(vP);
  ${segChain(rotated, cfg.thickness)}
  gl_FragColor = shade(d, p);
}
`;
  return makeMaterial(THREE, body, ramp, extentFor(cfg));
}

export function tickMaterial(THREE, cfg, ramp) {
  const body = `
void main() {
  vec2 p = shatterDisplace(vP);
  float rad = length(p);
  float ang = atan(p.y, p.x);
  float sector = 6.28318530718 / ${cfg.ticks.toFixed(1)};
  float a = mod(ang + 3.14159265359, sector) - sector * 0.5;
  float tangential = a * ${cfg.r.toFixed(6)};
  vec2 lp = vec2(rad - ${cfg.r.toFixed(6)}, tangential);
  float d = sdSegment(lp, vec2(-${(cfg.length / 2).toFixed(6)}, 0.0), vec2(${(cfg.length / 2).toFixed(6)}, 0.0)) - ${cfg.thickness.toFixed(6)} * 0.5;
  gl_FragColor = shade(d, p);
}
`;
  return makeMaterial(THREE, body, ramp, extentFor(cfg));
}

export function glowDiscMaterial(THREE, cfg, ramp) {
  // "a faint radial glow disc behind everything" — peak brightness is deliberately well below the
  // strokes' own core, it just grounds the heart component with a soft backdrop, it isn't a second sun.
  const body = `
void main() {
  vec2 sp = shatterDisplace(vP);
  float t = length(sp) / ${cfg.r.toFixed(6)};
  float glow = exp(-t * t * 3.2);
  float breathe = 1.0 + uFlickerAmp * sin(uTime * uFlickerHz * 6.28318530718);
  float revealed = uReveal > 0.001 ? 1.0 : 0.0;
  vec3 col = mix(uColorMid, uColorCore, glow) * glow * uIntensity * breathe * 0.35 * igniteBoost();
  gl_FragColor = vec4(col, glow * 0.4 * revealed * effectFade(sp));
}
`;
  return makeMaterial(THREE, body, ramp, extentFor(cfg));
}

export function runeBandMaterial(THREE, cfg, ramp, atlasTexture, seed) {
  const inner = cfg.r - cfg.band / 2, outer = cfg.r + cfg.band / 2;
  const body = `
uniform sampler2D uAtlas;
void main() {
  vec2 p = shatterDisplace(vP);
  float rad = length(p);
  float radialLocal = (rad - ${inner.toFixed(6)}) / ${cfg.band.toFixed(6)};
  if (radialLocal < -0.1 || radialLocal > 1.1) { discard; }
  float ang = atan(p.y, p.x);
  float angN = mod(ang / 6.28318530718 + 1.0, 1.0);
  float slotF = angN * ${cfg.glyphs.toFixed(1)};
  float slot = floor(slotF);
  float local = fract(slotF);
  float atlasIdx = floor(hash1(slot * 12.9898 + ${seed.toFixed(3)}) * 64.0);
  float col = mod(atlasIdx, 8.0);
  float row = floor(atlasIdx / 8.0);
  vec2 uv = vec2((col + local) / 8.0, (row + clamp(radialLocal, 0.0, 1.0)) / 8.0);
  vec4 tex = texture2D(uAtlas, uv);
  float radFade = smoothstep(0.0, 0.1, radialLocal) * smoothstep(1.0, 0.9, radialLocal);
  float breathe = 1.0 + uFlickerAmp * sin(uTime * uFlickerHz * 6.28318530718);
  float angFull = (ang + 3.14159265359) / 6.28318530718;
  float revealed = step(angFull, uReveal);
  float edgeFront = revealed * exp(-clamp(uReveal - angFull, 0.0, 1.0) * 26.0) * uEdgeBoost;
  float glowG = tex.g * (1.0 - tex.r);
  vec3 col3 = ramp(rad / uMaxR) * (tex.r + glowG * 0.6) * uIntensity * breathe * (1.0 + edgeFront) * igniteBoost();
  float alpha = clamp(tex.r + glowG * 0.5, 0.0, 1.0) * radFade * revealed * effectFade(p);
  gl_FragColor = vec4(col3, alpha);
}
`;
  const mat = makeMaterial(THREE, body, ramp, extentFor({ r: outer }));
  mat.uniforms.uAtlas = { value: atlasTexture };
  return mat;
}

function extentFor(cfg) {
  const r = cfg.r ?? 1;
  const pad = (cfg.thickness ?? 0) + (cfg.band ?? 0) + (cfg.length ?? 0) + 0.06;
  return (r + pad) * 2.2;
}

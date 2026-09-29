// Signed-distance-field line art for the sigil. Every layer is a flat quad; the fragment shader
// decides, per pixel, how far it sits from the nearest stroke and shades it with a soft glow and
// the orange-to-gold ramp. Shape constants (n, k, radius…) are baked as GLSL literals per layer at
// material-build time — only animation state (time, reveal, intensity, color) is uniform.

const VERT = /* glsl */ `
varying vec2 vP;
uniform float uExtent;
void main() {
  vP = position.xy * uExtent;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy * uExtent, position.z, 1.0);
}
`;

// Shared across every fragment shader: segment distance, the emissive ramp, and the reveal sweep.
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

float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0);
  return t < 0.5 ? mix(uColorCore, uColorMid, t * 2.0) : mix(uColorMid, uColorOuter, (t - 0.5) * 2.0);
}

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
  vec3 col = ramp(length(p) / uMaxR) * (core + glow * 0.6) * uIntensity * breathe * (1.0 + edgeFront);
  float alpha = clamp(core + glow * 0.5, 0.0, 1.0) * revealed;
  return vec4(col, alpha);
}
`;

function makeMaterial(THREE, fragBody, uniforms, extent) {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG_HEAD + fragBody,
    uniforms: {
      uExtent: { value: extent },
      uTime: { value: 0 },
      uIntensity: { value: 1 },
      uReveal: { value: 0 },
      uColorCore: { value: uniforms.core },
      uColorMid: { value: uniforms.mid },
      uColorOuter: { value: uniforms.outer },
      uFlickerAmp: { value: uniforms.flickerAmp },
      uFlickerHz: { value: uniforms.flickerHz },
      uGlow: { value: uniforms.glow },
      uAA: { value: uniforms.aa },
      uEdgeBoost: { value: uniforms.edgeBoost },
      uMaxR: { value: uniforms.maxR },
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
  float p = length(vP);
  float rOuter = ${(cfg.r + cfg.gap / 2).toFixed(6)};
  float rInner = ${(cfg.r - cfg.gap / 2).toFixed(6)};
  float dOuter = abs(p - rOuter) - ${cfg.thickness.toFixed(6)} * 0.5;
  float dInner = abs(p - rInner) - ${cfg.thickness.toFixed(6)} * 0.5;
  float d = min(dOuter, dInner);
  gl_FragColor = shade(d, vP);
}
`
    : `
void main() {
  float p = length(vP);
  float d = abs(p - ${cfg.r.toFixed(6)}) - ${cfg.thickness.toFixed(6)} * 0.5;
  gl_FragColor = shade(d, vP);
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
  vec2 p = vP;
  ${segChain(rotated, cfg.thickness)}
  gl_FragColor = shade(d, vP);
}
`;
  return makeMaterial(THREE, body, ramp, extentFor(cfg));
}

export function tickMaterial(THREE, cfg, ramp) {
  const body = `
void main() {
  vec2 p = vP;
  float rad = length(p);
  float ang = atan(p.y, p.x);
  float sector = 6.28318530718 / ${cfg.ticks.toFixed(1)};
  float a = mod(ang + 3.14159265359, sector) - sector * 0.5;
  float tangential = a * ${cfg.r.toFixed(6)};
  vec2 lp = vec2(rad - ${cfg.r.toFixed(6)}, tangential);
  float d = sdSegment(lp, vec2(-${(cfg.length / 2).toFixed(6)}, 0.0), vec2(${(cfg.length / 2).toFixed(6)}, 0.0)) - ${cfg.thickness.toFixed(6)} * 0.5;
  gl_FragColor = shade(d, vP);
}
`;
  return makeMaterial(THREE, body, ramp, extentFor(cfg));
}

export function glowDiscMaterial(THREE, cfg, ramp) {
  // "a faint radial glow disc behind everything" — peak brightness is deliberately well below the
  // strokes' own core, it just grounds the heart component with a soft backdrop, it isn't a second sun.
  const body = `
void main() {
  float t = length(vP) / ${cfg.r.toFixed(6)};
  float glow = exp(-t * t * 3.2);
  float breathe = 1.0 + uFlickerAmp * sin(uTime * uFlickerHz * 6.28318530718);
  float revealed = uReveal > 0.001 ? 1.0 : 0.0;
  vec3 col = mix(uColorMid, uColorCore, glow) * glow * uIntensity * breathe * 0.35;
  gl_FragColor = vec4(col, glow * 0.4 * revealed);
}
`;
  return makeMaterial(THREE, body, ramp, extentFor(cfg));
}

export function runeBandMaterial(THREE, cfg, ramp, atlasTexture, seed) {
  const inner = cfg.r - cfg.band / 2, outer = cfg.r + cfg.band / 2;
  const body = `
uniform sampler2D uAtlas;
float hash1(float n) { return fract(sin(n) * 43758.5453123); }
void main() {
  vec2 p = vP;
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
  vec3 col3 = ramp(rad / uMaxR) * (tex.r + glowG * 0.6) * uIntensity * breathe * (1.0 + edgeFront);
  float alpha = clamp(tex.r + glowG * 0.5, 0.0, 1.0) * radFade * revealed;
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

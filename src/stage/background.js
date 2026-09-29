// Two background modes, picked in config (and ?bg=): the live camera ('ar', the default) or a
// near-black vignette ('void', dev override).
//
// AR is not a quad in the scene: the sigil scene (plus bloom) renders on black into the composer,
// and this file's composite pass lays it over the mirrored video as the composer's last pass. That
// keeps the camera picture out of tone mapping and bloom entirely — natural colour, full
// brightness — while the sigil still gets its ACES curve and glow. The composite also does the
// two readability jobs (auto-exposure + dark halo on a bright wall), the warm light spill, and the
// optional finger occlusion. Void mode keeps the old scene quad and the stock OutputPass.
import { CFG } from '../config.js';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

const VOID_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec3 uBgColor;
uniform float uAspect;
void main() {
  vec2 c = (vUv - 0.5) * vec2(uAspect, 1.0);
  float vig = smoothstep(0.95, 0.15, length(c));
  gl_FragColor = vec4(uBgColor * (0.4 + 0.6 * vig), 1.0);
}
`;

const AR_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;      // the sigil scene + bloom, linear HDR, on black
uniform sampler2D tVideo;        // raw sRGB texels of the camera (no colour-space decode: we work in display space)
uniform sampler2D tMask;         // finger silhouette in mirrored-image space
uniform float uHasVideo;
uniform float uAspect;
uniform float uVideoAspect;
uniform float uDim;
uniform float uExposure;
uniform float uOcclusion;        // 0 = off
uniform vec3 uBgColor;
uniform vec2 uBright;            // luma range that counts as a bright wall
uniform float uGlowBoost;
uniform float uHalo;
uniform vec3 uSpillColor;
uniform float uSpillAmount;
uniform vec4 uSigil[2];          // xy = centre (uv, y up), z = outer radius (screen heights), w = how much of it is drawn

// "background-size: cover" — the same transform as src/stage/cover.js.
vec2 coverUV(vec2 uv) {
  if (uAspect > uVideoAspect) return vec2(uv.x, (uv.y - 0.5) * (uVideoAspect / uAspect) + 0.5);
  return vec2((uv.x - 0.5) * (uAspect / uVideoAspect) + 0.5, uv.y);
}

const vec3 LUMA = vec3(0.299, 0.587, 0.114);

// three's ACESFilmic (Stephen Hill fit), applied to the sigil alone
vec3 aces(vec3 c) {
  const mat3 IN = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 OUT = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  c *= uExposure / 0.6;
  c = IN * c;
  c = (c * (c + 0.0245786) - 0.000090537) / (c * (0.983729 * c + 0.4329510) + 0.238081);
  return clamp(OUT * c, 0.0, 1.0);
}
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(max(c, 1e-5), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

void main() {
  vec2 cuv = coverUV(vUv);
  vec3 base;
  float wall = 0.0;
  if (uHasVideo > 0.5) {
    vec2 vuv = vec2(1.0 - cuv.x, cuv.y);                 // mirrored, selfie view
    base = texture2D(tVideo, vuv).rgb;
    // how bright is the wall behind this pixel: a cross of wide taps, so texture doesn't shimmer
    float l = dot(base, LUMA);
    l += dot(texture2D(tVideo, vuv + vec2(0.03, 0.0)).rgb, LUMA) + dot(texture2D(tVideo, vuv - vec2(0.03, 0.0)).rgb, LUMA);
    l += dot(texture2D(tVideo, vuv + vec2(0.0, 0.03)).rgb, LUMA) + dot(texture2D(tVideo, vuv - vec2(0.0, 0.03)).rgb, LUMA);
    wall = smoothstep(uBright.x, uBright.y, l * 0.2);
    base *= uDim;
  } else {
    vec2 c = (vUv - 0.5) * vec2(uAspect, 1.0);
    base = uBgColor * (0.4 + 0.6 * smoothstep(0.95, 0.15, length(c)));
  }

  vec3 s = texture2D(tDiffuse, vUv).rgb;
  if (uOcclusion > 0.0) s *= 1.0 - uOcclusion * texture2D(tMask, cuv).r;   // fingers in front of the sigil
  float energy = dot(s, LUMA);                                              // strokes + their bloom: doubles as a soft halo mask

  // light spill: the sigil lights the picture around it — a radial gradient, not real lighting
  float spill = 0.0;
  for (int i = 0; i < 2; i++) {
    vec4 sg = uSigil[i];
    float d = length((vUv - sg.xy) * vec2(uAspect, 1.0)) / max(sg.z, 1e-3);
    spill += sg.w * exp(-d * d * 1.1);
  }
  base += uSpillColor * spill * uSpillAmount * (0.12 + 0.5 * base) * (1.0 - 0.5 * dot(base, LUMA));

  // readability on a bright wall: darken softly behind the strokes and push the glow harder
  base *= 1.0 - clamp(energy * 4.0, 0.0, 1.0) * uHalo * wall;
  s *= 1.0 + uGlowBoost * wall;

  gl_FragColor = vec4(clamp(base + toSrgb(aces(s)), 0.0, 1.0), 1.0);
}
`;

export function makeBackground(THREE, videoEl) {
  const ar = CFG.background.mode === 'ar';

  // ---- void: the old scene quad
  const voidMat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: VOID_FRAG, depthWrite: false, depthTest: false,
    uniforms: { uBgColor: { value: CFG.color.background }, uAspect: { value: innerWidth / innerHeight } },
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), voidMat);
  mesh.renderOrder = -1000;
  mesh.visible = !ar;

  // ---- ar: the composite pass's material
  let source = videoEl;
  // three's own VideoTexture re-arms its own requestVideoFrameCallback and re-uploads on every one;
  // here the app decides when a new frame exists (VideoFeed) and calls uploadFrame(). So: a plain
  // Texture flagged as a video texture (which makes three upload an HTMLVideoElement via texImage2D
  // instead of texStorage2D with the element's 0x0 width/height attributes), with its per-render
  // update() switched off.
  const makeTex = (el) => {
    const t = new THREE.Texture(el);
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    if (el instanceof HTMLVideoElement) { t.isVideoTexture = true; t.update = () => {}; }
    return t;
  };
  let videoTex = makeTex(videoEl);
  const emptyMask = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  emptyMask.needsUpdate = true;
  const ex = CFG.ar.exposure;
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: AR_FRAG, depthWrite: false, depthTest: false,
    uniforms: {
      tDiffuse: { value: null }, tVideo: { value: emptyMask }, tMask: { value: emptyMask },
      uHasVideo: { value: 0 }, uAspect: { value: innerWidth / innerHeight }, uVideoAspect: { value: 16 / 9 },
      uDim: { value: CFG.background.arDim }, uExposure: { value: CFG.ar.toneExposure }, uOcclusion: { value: 0 },
      uBgColor: { value: CFG.color.background },
      uBright: { value: new THREE.Vector2(ex.lo, ex.hi) }, uGlowBoost: { value: ex.glowBoost }, uHalo: { value: ex.halo },
      uSpillColor: { value: new THREE.Vector3(...CFG.ar.spill.color) }, uSpillAmount: { value: CFG.ar.spill.amount },
      uSigil: { value: [new THREE.Vector4(0.5, 0.5, 0.5, 0), new THREE.Vector4(0.5, 0.5, 0.5, 0)] },
    },
  });
  let hasVideo = false;

  const dims = () => (source instanceof HTMLVideoElement ? [source.videoWidth, source.videoHeight] : [source.width, source.height]);

  function fit(camera, z) {
    const dist = camera.position.z - z;
    const h = 2 * dist * Math.tan((camera.fov * Math.PI) / 360);
    mesh.scale.set(h * camera.aspect, h, 1);
    mesh.position.z = z;
    voidMat.uniforms.uAspect.value = material.uniforms.uAspect.value = camera.aspect;
  }

  return {
    ar, mesh, material,
    /** Point the AR backdrop at another image source (a canvas, in the tests) instead of the camera. */
    setSource(el) { source = el; videoTex = makeTex(el); if (hasVideo) material.uniforms.tVideo.value = videoTex; },
    setHasVideo(has) {
      hasVideo = has;
      material.uniforms.uHasVideo.value = has ? 1 : 0;
      this.refreshAspect();
    },
    refreshAspect() {
      const [w, h] = dims();
      if (hasVideo && w && h) material.uniforms.uVideoAspect.value = w / h;
    },
    get hasVideo() { return hasVideo; },
    /** Width / height of what's on screen, or null before there is a picture. */
    get videoAspect() { return hasVideo ? material.uniforms.uVideoAspect.value : null; },
    /** A new source frame is ready: upload it. Called only when one actually arrived. */
    uploadFrame() {
      const [w, h] = dims();
      if (!w || !h) return;
      videoTex.needsUpdate = true;
      material.uniforms.tVideo.value = videoTex;   // (a texture with no data yet is never bound: it isn't swapped in until here)
      if (!hasVideo) this.setHasVideo(true); else this.refreshAspect();
    },
    /** [Vector4 x2]: xy = sigil centre in uv (y up), z = light-spill radius in screen heights, w = how much of it is drawn. Written in place, every frame. */
    sigilUniforms: material.uniforms.uSigil.value,
    setMask(tex, strength) { material.uniforms.tMask.value = tex || emptyMask; material.uniforms.uOcclusion.value = tex ? strength : 0; },
    resize(camera) { fit(camera, -6); },
  };
}

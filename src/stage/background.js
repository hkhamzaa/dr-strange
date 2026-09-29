// Two background modes, picked in config (and the ?bg= URL flag): a near-black void with a
// vignette, or the mirrored webcam feed, dimmed and desaturated, sitting behind the sigil.
import { CFG } from '../config.js';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uVideo;
uniform float uHasVideo;
uniform float uMode;   // 0 = void, 1 = ar
uniform float uDim;
uniform float uDesat;
uniform vec3 uBgColor;
uniform float uAspect;
uniform float uVideoAspect;

// "background-size: cover" — fills the screen without stretching, cropping whichever axis the
// video has spare on, instead of squashing it to the screen's own aspect ratio.
vec2 coverUV(vec2 uv) {
  if (uAspect > uVideoAspect) return vec2(uv.x, (uv.y - 0.5) * (uVideoAspect / uAspect) + 0.5);
  return vec2((uv.x - 0.5) * (uAspect / uVideoAspect) + 0.5, uv.y);
}

void main() {
  vec3 col;
  if (uMode > 0.5 && uHasVideo > 0.5) {
    vec2 uv = coverUV(vUv);
    uv.x = 1.0 - uv.x;   // mirrored, selfie view
    vec3 v = texture2D(uVideo, uv).rgb;
    float g = dot(v, vec3(0.299, 0.587, 0.114));
    v = mix(v, vec3(g), uDesat);
    col = v * uDim;
  } else {
    vec2 c = (vUv - 0.5) * vec2(uAspect, 1.0);
    float d = length(c);
    float vig = smoothstep(0.95, 0.15, d);
    col = uBgColor * (0.4 + 0.6 * vig);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export function makeBackground(THREE, videoEl) {
  const geo = new THREE.PlaneGeometry(1, 1);
  const videoTex = new THREE.VideoTexture(videoEl);
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, depthWrite: false, depthTest: false,
    uniforms: {
      uVideo: { value: videoTex }, uHasVideo: { value: 0 },
      uMode: { value: CFG.background.mode === 'ar' ? 1 : 0 },
      uDim: { value: CFG.background.arDim }, uDesat: { value: CFG.background.arDesaturate },
      uBgColor: { value: CFG.color.background }, uAspect: { value: innerWidth / innerHeight },
      uVideoAspect: { value: 16 / 9 },   // updated once real video dimensions are known
    },
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -1000;

  function fit(camera, z) {
    const dist = camera.position.z - z;
    const h = 2 * dist * Math.tan((camera.fov * Math.PI) / 360);
    const w = h * camera.aspect;
    mesh.scale.set(w, h, 1);
    mesh.position.z = z;
    mat.uniforms.uAspect.value = camera.aspect;
  }

  return {
    mesh,
    setMode(mode) { mat.uniforms.uMode.value = mode === 'ar' ? 1 : 0; },
    setHasVideo(has) {
      mat.uniforms.uHasVideo.value = has ? 1 : 0;
      if (has && videoEl.videoWidth) mat.uniforms.uVideoAspect.value = videoEl.videoWidth / videoEl.videoHeight;
    },
    resize(camera) { fit(camera, -6); },
  };
}

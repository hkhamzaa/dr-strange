// Every tunable for the sigil lives here: colors, the layer composition, component membership,
// bloom, camera, anchoring and size presets. Nothing outside this file hardcodes a magic number
// that a designer might want to nudge later.

export const qs = new URLSearchParams(location.search);

export const CFG = {
  seed: 1337,                                   // deterministic glyph + noise seed

  dpr: {
    clamp: 1.5,                                 // hard cap on devicePixelRatio, even on retina/4k screens
  },

  camera: {
    fov: 38,
    near: 0.05,
    far: 30,
    dist: 3.1,                                  // camera sits this far back on +z looking at the origin
  },

  bloom: {
    strength: 1.1,
    radius: 0.45,
    threshold: 0.35,
  },

  color: {
    // orange-gold emissive ramp: core (brightest, near-white gold) -> mid -> outer edge (deep ember orange)
    core: [1.0, 0.95, 0.78],
    mid: [1.0, 0.66, 0.22],
    outer: [0.92, 0.34, 0.06],
    background: [0.02, 0.014, 0.01],
  },

  stroke: {
    width: 0.006,                               // base SDF line thickness, in sigil-radius units
    glow: 0.03,                                 // soft falloff distance added around each stroke
    flicker: 0.06,                              // breathing-flicker amplitude on the intensity uniform
    flickerHz: 0.6,
  },

  reveal: {
    castS: 1.2,                                 // total time for cast() to sweep outer -> inner
    staggerFrac: 0.55,                          // fraction of castS given to inter-component stagger vs each component's own sweep
    edgeBoost: 2.2,                             // brightness multiplier at the sweeping edge
  },

  explode: {
    depthSpread: 0.9,                           // world units components fly apart along z at explode(1)
    outSpread: 0.35,                            // world units components fly apart radially at explode(1)
  },

  sizePresets: {
    smol: 0.62,
    mid: 1.0,
    full: 1.4,
  },
  sizeTransitionS: 0.7,

  anchor: {
    mode: qs.get('anchor') || 'hand',           // 'hand' | 'stage'
    followTau: 0.09,                            // exponential-smoothing time constant for palm -> world position
    rollTau: 0.12,
    releaseAfterS: 0.4,                         // no visible hand for this long -> ease back to stage centre
    releaseTau: 0.5,
    followGain: 1.15,                           // how far the sigil drifts across the frame vs. the palm's travel
    tiltGain: 0.6,                              // hand roll -> sigil z-rotation
  },

  background: {
    mode: qs.get('bg') || 'void',               // 'void' | 'ar'
    arDim: 0.35,
    arDesaturate: 0.6,
  },

  floor: {
    y: -0.85,
    puddleRadius: 1.6,
    reflectionOpacity: 0.16,
  },

  sparks: {
    count: 140,
    riseSpeed: 0.09,
    spread: 1.3,
    size: 3.2,
  },

  hud: {
    intentLogLen: 5,
  },
};

// ---------------------------------------------------------------------------------------------
// Phase 2: the gesture -> intent table. One row per gesture, naming the intent(s) it emits and
// every tunable that shapes it — dwell/arm time before a continuous gesture is trusted, release
// time before it lets go, and cooldowns on one-shot triggers. The mapper (src/input/mapper.js)
// reads this table; it holds no thresholds of its own.
export const GESTURE_MAP = {
  snap: { intent: 'summon | dismiss', note: 'reuses gestures.js SnapDetector, which has its own 0.8s cooldown' },
  openHold: { intent: 'summon', holdS: 0.5, chargeGlow: 0.22, note: 'DORMANT-only fallback for when a snap is missed' },
  resize: { intent: 'resize', tau: 0.16, note: 'openness -> size, suspended while pinching so it does not fight explode' },
  explode: { intent: 'explode', scaleRange: 0.4, dirSign: -1, releaseEaseS: 0.6, armS: 0.05, releaseS: 0.15 },
  soloCycle: { intent: 'solo | regroup', cooldownS: 0.7, armS: 0.08, releaseS: 0.2 },
  spin: { intent: 'spin', gain: 2.6, min: 0.15, max: 4, easeBackS: 1.5, armS: 0.08, releaseS: 0.2 },
  tilt: { intent: 'tilt', tau: 0.22, clampRad: 0.32 },
};

CFG.gestures = {
  handLost: { freezeAfterS: 0.4, idleAfterS: 6.0 },   // no hand: freeze continuous values, then ease spin/tilt to rest
  pulse: { amount: 0.9, flashTau: 0.22 },              // brightness surge on every recognized gesture
  hysteresis: { poseArmS: 0.08, poseReleaseS: 0.2 },   // shared default arm/release for pose-gated continuous gestures
};

// ---------------------------------------------------------------------------------------------
// Layer composition, outer to inner. Every layer belongs to exactly one component (below).
// `spinny` is angular velocity in rad/s (sign sets direction; neighbours alternate sign).
// `z` is the tiny per-layer depth offset (parallax under tilt), most-outer nearest the camera.
export const LAYERS = [
  { id: 'outerRing', type: 'ring', r: 1.00, thickness: 0.022, double: true, gap: 0.028, spinny: 0.050, z: 0.000 },
  { id: 'outerRune', type: 'runeBand', r: 0.90, band: 0.085, glyphs: 32, spinny: -0.085, z: -0.004 },
  { id: 'ring', type: 'ring', r: 0.82, thickness: 0.012, double: false, spinny: 0.070, z: -0.008 },
  { id: 'tickRing', type: 'tick', r: 0.74, ticks: 60, length: 0.032, thickness: 0.006, spinny: -0.150, z: -0.012 },
  { id: 'star9_4', type: 'star', r: 0.64, n: 9, k: 4, thickness: 0.007, spinny: 0.110, z: -0.016 },
  { id: 'squareA', type: 'polygon', r: 0.50, n: 4, rotate: 0, thickness: 0.007, spinny: -0.060, z: -0.020 },
  { id: 'squareB', type: 'polygon', r: 0.50, n: 4, rotate: Math.PI / 4, thickness: 0.007, spinny: 0.060, z: -0.022 },
  { id: 'star7_2', type: 'star', r: 0.40, n: 7, k: 2, thickness: 0.0065, spinny: -0.130, z: -0.026 },
  { id: 'midRing', type: 'ring', r: 0.30, thickness: 0.010, double: false, spinny: 0.100, z: -0.030 },
  { id: 'innerRune', type: 'runeBand', r: 0.24, band: 0.045, glyphs: 20, spinny: -0.180, z: -0.034 },
  { id: 'star12_5', type: 'star', r: 0.16, n: 12, k: 5, thickness: 0.006, spinny: 0.220, z: -0.038 },
  { id: 'coreRing', type: 'ring', r: 0.10, thickness: 0.008, double: false, spinny: -0.120, z: -0.042 },
  { id: 'glowDisc', type: 'glowDisc', r: 0.55, spinny: 0.020, z: -0.050 },
];

// Component membership + default (assembled) local transform. explodeOut/explodeZ scale how far
// this component drifts, relative to CFG.explode.*, so the outer ring barely moves and the core
// components fly apart the most, like an exploded-view diagram.
export const COMPONENTS = [
  { id: 'outerSeal', layers: ['outerRing', 'ring', 'outerRune'], explodeOut: 0.25, explodeZ: 0.15 },
  { id: 'tickRing', layers: ['tickRing'], explodeOut: 0.45, explodeZ: 0.35 },
  { id: 'starCore', layers: ['star9_4', 'squareA', 'squareB', 'star7_2'], explodeOut: 0.7, explodeZ: 0.6 },
  { id: 'innerSeal', layers: ['midRing', 'innerRune'], explodeOut: 0.9, explodeZ: 0.85 },
  { id: 'heart', layers: ['star12_5', 'coreRing', 'glowDisc'], explodeOut: 1.15, explodeZ: 1.1 },
];

// Outer-to-inner cast order (index drives the reveal stagger).
export const CAST_ORDER = COMPONENTS.map((c) => c.id);

// URL-flag overrides, applied last so tests can dial things in deterministically.
if (qs.get('dpr')) CFG.dpr.clamp = parseFloat(qs.get('dpr'));
export const FLAGS = {
  manual: qs.get('manual') === '1',     // deterministic clock: frames only advance via sigilApp.advance()
  autostart: qs.get('autostart') === '1',
  nocam: qs.get('nocam') === '1',
  dev: qs.get('dev') === '1',
  debug: qs.get('debug') === '1',
};

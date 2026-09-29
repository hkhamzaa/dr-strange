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
    castS: 0.9,                                 // total time for cast() to sweep outer -> inner
    uncastS: 0.4,                               // the fast fade once the hand is gone
    staggerFrac: 0.55,                          // fraction of castS given to inter-component stagger vs each component's own sweep
    edgeBoost: 2.2,                             // brightness multiplier at the sweeping edge
  },

  sizePresets: {
    smol: 0.62,
    mid: 1.0,
    full: 1.4,
  },
  sizeTransitionS: 0.1,                         // time constant the whole-sigil scale chases its target with

  // Render-side chase. Detection already delivers One-Euro-filtered targets at camera rate; these
  // short exponential time constants just interpolate between those updates at display rate.
  anchor: {
    mode: qs.get('anchor') || 'hand',           // 'hand' | 'stage'
    followTau: 0.07,
    rollTau: 0.07,
    tiltTau: 0.22,
    followGain: 1.0,                            // 1 = the sigil sits exactly on the palm
    rollGain: 1.0,                              // hand roll -> sigil rotation, one to one
  },

  // One-Euro parameters per signal (Casiez et al.): minCutoff Hz = smoothing when still, beta =
  // how fast the cutoff opens up with speed. Units differ per signal, hence separate rows.
  filter: {
    landmark: { minCutoff: 2.0, beta: 6.0, dCutoff: 1.0 },
    palm: { minCutoff: 1.2, beta: 5.0, dCutoff: 1.0 },
    roll: { minCutoff: 1.0, beta: 0.6, dCutoff: 1.0 },
    openness: { minCutoff: 1.5, beta: 1.5, dCutoff: 1.0 },
    scale: { minCutoff: 1.0, beta: 1.0, dCutoff: 1.0 },
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
// The gesture -> intent table. Presence and pose only: every hand drives its own sigil through
// these same rows. The mapper (src/input/mapper.js) and the split-pose gate in controller.js read
// this table; neither holds thresholds of its own.
export const GESTURE_MAP = {
  presence: { intent: 'summon | dismiss', confirmFrames: 2, graceS: 0.5, note: 'hand appears -> cast; gone past the grace -> fast uncast' },
  size: { intent: 'resize', note: 'normalized openness -> size, fist = smol .. open = full; frozen while the split pose is arming or held' },
  roll: { intent: '(follow rule)', note: 'hand roll -> sigil rotation one to one; layers keep their own counter-spin' },
  split: { intent: 'explode', armS: 0.15, releaseS: 0.12, freezeLookbackS: 0.3, note: 'thumb + index + middle out, ring + pinky curled' },
};

CFG.gestures = {
  pulse: { amount: 0.9, flashTau: 0.22 },              // brightness surge on a recognized gesture
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
// this component drifts at explode(1), so the outer ring barely moves and the core components fly
// apart the most, like an exploded-view diagram.
export const COMPONENTS = [
  { id: 'outerSeal', layers: ['outerRing', 'ring', 'outerRune'], explodeOut: 0.25, explodeZ: 0.15 },
  { id: 'tickRing', layers: ['tickRing'], explodeOut: 0.45, explodeZ: 0.35 },
  { id: 'starCore', layers: ['star9_4', 'squareA', 'squareB', 'star7_2'], explodeOut: 0.7, explodeZ: 0.6 },
  { id: 'innerSeal', layers: ['midRing', 'innerRune'], explodeOut: 0.9, explodeZ: 0.85 },
  { id: 'heart', layers: ['star12_5', 'coreRing', 'glowDisc'], explodeOut: 1.15, explodeZ: 1.1 },
];

// Outer-to-inner cast order (index drives the reveal stagger).
export const CAST_ORDER = COMPONENTS.map((c) => c.id);

// Sigil B (the second hand's sigil) differs only in seed, ramp and spin direction — everything
// else (layer composition, component membership, bloom) is shared.
CFG.sigilB = {
  seedOffset: 7919,
  spinFlip: -1,
  color: {
    core: [1.0, 0.92, 0.85],
    mid: [1.0, 0.45, 0.62],
    outer: [0.75, 0.12, 0.35],
  },
};

CFG.audio = {
  muted: false,
  masterGain: 0.6,
  limiterThresholdDb: -6,
  maxPolyphony: 12,
  humBaseHz: [55, 58.5],     // two detuned oscillators
  humNoiseGain: 0.018,
};

// What "hand gone" looks like: the fast uncast sweep by default. Shatter/dissolve stay available
// as renderer effects (and via ?dismiss=) but no gesture triggers them directly any more.
CFG.dismiss = {
  style: 'uncast',           // 'uncast' | 'dissolve' | 'shatter'
  shatter: { durationS: 0.9, cellsAngular: 10, cellsRadial: 3, reassembleS: 0.7 },
  dissolve: { durationS: 1.1, noiseScale: 6.0 },
};

// ---------------------------------------------------------------------------------------------
// Phase 4: quality tiers, calibration, and the performance governor's own thresholds. The tier
// table is the single source both the governor (auto) and ?quality= (manual override) read —
// nothing outside QUALITY_TIERS hardcodes a per-tier number.
export const QUALITY_TIERS = {
  high: { dprClamp: 1.5, bloomScale: 1.0, bloomMips: 5, sparkCount: 140, shatterCellsAngular: 10, shatterCellsRadial: 3, sigilBLayerFrac: 1.0, reflection: true },
  mid: { dprClamp: 1.15, bloomScale: 0.75, bloomMips: 4, sparkCount: 80, shatterCellsAngular: 8, shatterCellsRadial: 2, sigilBLayerFrac: 0.85, reflection: true },
  low: { dprClamp: 0.9, bloomScale: 0.5, bloomMips: 3, sparkCount: 36, shatterCellsAngular: 6, shatterCellsRadial: 2, sigilBLayerFrac: 0.6, reflection: false },
};

CFG.perf = {
  windowFrames: 90,           // rolling frame-time window the governor judges against
  stepDownFps: 50, stepDownHoldS: 2.0,     // sustained miss -> drop a tier
  stepUpFps: 56, stepUpHoldS: 8.0,         // sustained comfort -> allowed back up (hysteresis: needs to clear the down threshold by a margin AND hold much longer)
};

// Sane defaults the app starts with; src/calib/ silently adapts them from a rolling window of what
// the user's hands actually do (and persists that), so openness -> size spans the full range for
// this particular hand and camera without any setup step.
CFG.calib = {
  openness: { fist: 0.05, open: 0.95 },
  scaleRef: 0.14,              // wrist -> middle-knuckle distance, aspect-corrected image units
  adapt: {
    windowS: 30, binS: 0.1,    // rolling min/max over this long, in bins this wide
    warmupS: 3,                // need this much hand time in the window before adapting at all
    tau: 2.0,                  // adapted bounds chase the window's min/max with this time constant
    margin: 0.03,
    fistMax: 0.35, openMin: 0.55,    // hard limits, so a window with no fist (or no open hand) can't collapse the range
    saveEveryS: 5,
  },
};

CFG.tracker = {
  width: 640, height: 480, fps: 30,
  dormantIdleS: 5.0,           // no hand seen this long -> drop detection rate
  dormantProbeHz: 15,          // ...down to this probe rate (worst case ~67ms extra before a new hand casts)
};

CFG.hint = { afterS: 1.2 };    // camera running, no hand this long -> "Show your hand to the camera"

// URL-flag overrides, applied last so tests can dial things in deterministically.
if (qs.get('dpr')) CFG.dpr.clamp = parseFloat(qs.get('dpr'));
if (qs.get('dismiss')) CFG.dismiss.style = qs.get('dismiss');
if (qs.get('mute') === '1') CFG.audio.muted = true;
export const FLAGS = {
  manual: qs.get('manual') === '1',     // deterministic clock: frames only advance via sigilApp.advance()
  autostart: qs.get('autostart') === '1',
  nocam: qs.get('nocam') === '1',
  dev: qs.get('dev') === '1',
  debug: qs.get('debug') === '1',
  perf: qs.get('perf') === '1',
  record: qs.get('record') === '1',
  quality: qs.get('quality'),           // 'high' | 'mid' | 'low' | null — a value here disables the governor
  recalibrate: qs.get('recalibrate') === '1',
};

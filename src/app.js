// SIGIL — a glowing magic circle driven purely by hand presence and pose. A hand appears: its
// sigil casts in on the palm and follows it. Openness sizes it, roll turns it, the three-finger
// pose splits it apart. Hand gone: it uncasts. Two hands: two sigils, one each.
//
// Detection and rendering are decoupled. The camera's own frame callback runs MediaPipe and feeds
// the Controller (One-Euro-filtered targets); the render loop runs at display rate, runs each
// sigil's mapper over those targets, and every visual value chases its target with frame-rate-
// independent exponential smoothing. Each session's mapper.update() runs inside bus.withTag(id),
// so the intents it emits route to its own sigil.
import * as THREE from 'three';
import { CFG, FLAGS, COMPONENTS, QUALITY_TIERS } from './config.js';
import { emit, on, withTag, INTENTS } from './bus/bus.js';
import { Controller } from './input/controller.js';
import { HandCamera } from './input/tracker.js';
import { hand as synthHand } from './input/synth.js';
import { SigilStateMachine, ACTIVE, DORMANT } from './input/stateMachine.js';
import { GestureMapper } from './input/mapper.js';
import { Sigil } from './sigil/sigil.js';
import { makeScene, hasWebGL2 } from './stage/scene.js';
import { makeBloom } from './stage/bloom.js';
import { makeFloor } from './stage/floor.js';
import { makeSparks } from './stage/sparks.js';
import { makeBackground } from './stage/background.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { VideoFeed } from './stage/videoFeed.js';
import { makeHandMask } from './stage/occlusion.js';
import { coverScale, videoToScreen } from './stage/cover.js';
import { Hud } from './hud/hud.js';
import { AudioEngine } from './audio/engine.js';
import { QualityGovernor } from './perf/governor.js';
import { PerfOverlay } from './perf/overlay.js';
import { AutoCalib, loadCalibration, applyProfile } from './calib/calibrate.js';
import { RecordControl } from './record/record.js';

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// One hand slot's sigil: the Sigil, its state machine, its mapper, and the bus wiring that turns
// its intents into Sigil calls. `mine(payload)` treats an untagged payload as sigil A's.
class SigilSession {
  constructor(scene, id, hand, sigilOpts, app) {
    this.id = id;
    this.hand = hand;
    this.app = app;
    this.audio = app.audio;
    this.sigil = new Sigil(THREE, sigilOpts);
    this.sigil.root.visible = false;
    scene.add(this.sigil.root);
    this.stateMachine = new SigilStateMachine(id);
    this.mapper = new GestureMapper(hand, this.stateMachine);
    this.wasExploded = false;
    this._t = 0; this._dt = 0;
    this._tick = () => this.mapper.update(this._t, this._dt);   // bound once: withTag() needs a callback every frame
    this._xy = [0, 0];
    this._wire();
  }

  mine(p) { return (p?.sigil ?? 'A') === this.id; }

  _wire() {
    on('summon', (p) => {
      if (!this.mine(p)) return;
      this.sigil.root.visible = true;
      if (p.from !== 'dismissing' && CFG.anchor.mode === 'hand') {
        // fresh cast: appear right on the palm, at the hand's size and roll, rather than easing in from wherever the last session ended
        this.app.palmTarget(this.hand, this._xy);
        this.sigil.snapTo(this._xy[0], this._xy[1], 0, -this.hand.roll * CFG.anchor.rollGain);
        this.sigil.setSizeT(this.hand.openness);
        this.sigil.scale = this.sigil.scaleTarget;
        this.app.applyBase(this.hand, this.sigil, true);
      }
      this.sigil.cast();
      this.audio?.summon();
    });
    on('dismiss', (p) => {
      if (p.sigil !== this.id && p.sigil !== 'both') return;
      if (p.style === 'shatter') { this.sigil.shatter(); this.audio?.shatter(); }
      else if (p.style === 'dissolve') { this.sigil.dissolve(); this.audio?.dismiss(); }
      else { this.sigil.uncast(CFG.reveal.uncastS); this.audio?.dismiss(); }
    });
    on('resize', (p) => { if (this.mine(p)) this.sigil.setSizeT(p.t); });
    on('scale', (p) => { if (this.mine(p)) this.sigil.setScale(p.mul); });
    on('explode', (p) => {
      if (!this.mine(p)) return;
      this.sigil.explode(p.amount);
      const now = p.amount > 0.5;
      if (now && !this.wasExploded) this.audio?.explode();
      if (!now && this.wasExploded) this.audio?.regroup();
      this.wasExploded = now;
    });
    on('solo', (p) => {
      if (!this.mine(p)) return;
      this.sigil.solo(p.name);
      this.audio?.chime(Math.max(0, COMPONENTS.findIndex((c) => c.id === p.name)));
    });
    on('regroup', (p) => { if (this.mine(p)) { this.sigil.regroup(); this.audio?.regroup(); } });
    on('spin', (p) => { if (this.mine(p)) this.sigil.setSpinMul(p.mul); });
    on('tilt', (p) => { if (this.mine(p)) { this.sigil.setTilt(p.x); this.sigil.setLeanY(p.y); } });
    on('move', (p) => { if (this.mine(p) && p.component) { const part = this.sigil.part(p.component); part.setPosition(p.x, p.y, part.posTarget[2]); } });
    on('pulse', (p) => { if (this.mine(p)) this.sigil.pulse(p?.component); });
  }

  /** Palm position, size and roll follow, while shown and the hand is actually in view. */
  applyFollow(t) {
    if (CFG.anchor.mode !== 'hand' || !this.stateMachine.shown || !this.hand.handVisible(t)) return;
    this.app.palmTarget(this.hand, this._xy);
    this.sigil.setPosition(this._xy[0], this._xy[1], 0);
    this.app.applyBase(this.hand, this.sigil, false);
    this.sigil.setRoll(-this.hand.roll * CFG.anchor.rollGain);   // image roll is clockwise-positive; three.js z is counter-clockwise
  }

  step(t, dt) {
    this._t = t; this._dt = dt;
    withTag(this.id, this._tick);
    this.applyFollow(t);
    this.sigil.update(dt);
    if (this.stateMachine.state === DORMANT && !this.sigil._cast) this.sigil.root.visible = false;
  }

  /** 0..1, how much of this sigil is drawn — the ambient hum follows it. */
  get shownLevel() { return this.sigil.root.visible ? this.sigil._castComps[0].reveal : 0; }

  status() {
    return { id: this.id, state: this.stateMachine.state, sigil: this.sigil.status(), gesture: this.mapper.status(this.stateMachine._clock) };
  }
}

class App {
  constructor() {
    this.canvas = $('stage');
    this.video = $('cam');

    const s = makeScene(THREE, this.canvas);
    this.scene = s.scene; this.camera = s.camera; this.renderer = s.renderer; this._resizeScene = s.resize; this._setDprClamp = s.setDprClamp;
    this.background = makeBackground(THREE, this.video);
    this.ar = this.background.ar;
    // AR: the composite pass (camera + sigil) replaces the stock OutputPass as the last pass
    const b = makeBloom(THREE, this.renderer, this.scene, this.camera, this.ar ? new ShaderPass(this.background.material) : undefined);
    this.composer = b.composer; this._resizeBloom = b.resize; this._bloomSetScale = b.setScale;
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); console.warn('WebGL context lost'); });
    this.canvas.addEventListener('webglcontextrestored', () => {
      // rebuilding every GPU resource in place is a lot of surface for a rare event; a reload picks
      // straight back up (the adapted calibration and mute state persist)
      console.warn('WebGL context restored — reloading to rebuild all GPU resources');
      location.reload();
    });

    this.floor = makeFloor(THREE); this.scene.add(this.floor);
    // void: one ember field over the floor. AR: one small cloud per sigil, riding on it
    this.sparkList = this.ar ? [makeSparks(THREE, { ar: true }), makeSparks(THREE, { ar: true, seed: 4243 })] : [makeSparks(THREE)];
    for (const sp of this.sparkList) { this.scene.add(sp.points); if (this.ar) sp.points.visible = false; }
    this.sparks = this.sparkList[0];
    if (!this.ar) this.scene.add(this.background.mesh);
    this.background.resize(this.camera);
    this.feed = new VideoFeed(this.video);
    this.mask = this.ar && CFG.ar.occlusion.enabled ? makeHandMask(THREE) : null;
    if (this.mask) this.background.setMask(this.mask.texture, CFG.ar.occlusion.strength);
    this._maskHands = [];
    this._sc = [0, 0];

    this.ctl = new Controller();
    this.calib = new AutoCalib();
    this.cam = null;
    this.handSource = null; this.lastSynthT = -1;
    this.audio = new AudioEngine();

    this.t = 0; this.last = null; this.frames = 0; this.fps = 0; this._fpsN = 0; this._fpsT = 0;
    this.lastEverHandSeenT = 0;
    this.paused = false;
    this._hintShown = false;
    this._dbgT = 0;

    // governor first: its constructor applies the starting tier synchronously, which sets the
    // layer fraction sigil B is built with
    this.sessions = new Map();
    this.sessionList = [];
    this.governor = new QualityGovernor((tier, tierCfg) => this._applyTier(tier, tierCfg));

    this._addSession(new SigilSession(this.scene, 'A', this.ctl.tracks[0], {}, this));
    // sigil B is built up front and kept hidden while dormant, so a second hand appearing never
    // pays for building a sigil (atlas bake, GPU upload) mid-interaction
    this._addSession(new SigilSession(this.scene, 'B', this.ctl.tracks[1], {
      seed: CFG.seed + CFG.sigilB.seedOffset, spinFlip: CFG.sigilB.spinFlip, colorRamp: CFG.sigilB.color, layerFrac: this._sigilBLayerFrac,
    }, this));
    this._applyTier(this.governor.tier, QUALITY_TIERS[this.governor.tier]);
    this._prewarm();

    this.hud = FLAGS.debug ? new Hud() : null;
    if (this.hud) {
      // handState fires every frame — logging it would drown out everything else in the HUD's log
      for (const name of INTENTS.filter((n) => n !== 'handState')) on(name, (payload) => this.hud.logIntent(name, payload));
      for (const sess of this.sessionList) sess.stateMachine.onChange = (state, prev) => this.hud.logIntent('state', { from: prev, to: state, sigil: sess.id });
    }

    this.perf = FLAGS.perf ? new PerfOverlay(this.renderer) : null;
    this.record = FLAGS.record && FLAGS.debug ? new RecordControl(this.canvas, this.audio) : null;
    this.hint = $('hint');

    document.addEventListener('visibilitychange', () => this._onVisibility());
    addEventListener('pagehide', () => this.calib.save(this.t));

    this.resize();
    addEventListener('resize', () => this.resize());
    window.visualViewport?.addEventListener('resize', () => this.resize());
    addEventListener('orientationchange', () => this.resize());
  }

  _addSession(sess) { this.sessions.set(sess.id, sess); this.sessionList.push(sess); }

  /** One throwaway render with both (fully unrevealed, so invisible) sigils switched on: three.js
   *  compiles programs and uploads geometry/textures on first draw, and that should happen here at
   *  boot — not mid-interaction, the first time a hand shows up. */
  _prewarm() {
    for (const sess of this.sessionList) sess.sigil.root.visible = true;
    for (const sp of this.sparkList) sp.points.visible = true;
    this.composer.render();                     // every pass, so the bloom and composite programs compile here too
    for (const sess of this.sessionList) sess.sigil.root.visible = false;
    if (this.ar) for (const sp of this.sparkList) sp.points.visible = false;
  }

  /** Quality governor callback — every lever a tier controls, applied in one place. */
  _applyTier(tier, tierCfg) {
    this._setDprClamp(tierCfg.dprClamp);
    this._bloomSetScale(tierCfg.bloomScale);
    for (const sp of this.sparkList) sp.setCount(tierCfg.sparkCount / this.sparkList.length);
    this.floor.visible = tierCfg.reflection && !this.ar;   // the floor and its reflection look wrong over a real room
    for (const sess of this.sessionList) sess.sigil.setShatterCellDensity(tierCfg.shatterCellsAngular, tierCfg.shatterCellsRadial);
    this._sigilBLayerFrac = tierCfg.sigilBLayerFrac;
    this.resize();
  }

  _onVisibility() {
    this.paused = document.hidden;
    if (this.cam) this.cam.paused = document.hidden;
    if (document.hidden) { this.audio.ctx?.suspend(); this.calib.save(this.t); }
    else { this.audio.ctx?.resume().catch(() => {}); this.last = null; }   // null: don't count the hidden gap as one huge dt
  }

  resize() {
    this._resizeScene();
    this._resizeBloom();
    this.background.resize(this.camera);
  }

  /** Half the visible height of the z = 0 sigil plane, in world units. */
  get halfH() { return CFG.camera.dist * Math.tan((this.camera.fov * Math.PI) / 360); }

  /** Aspect of the picture the screen is showing (the screen's own when there isn't one, so the
   *  whole camera frame maps onto the whole screen). */
  get videoAspect() { return this.ar ? (this.background.videoAspect ?? this.camera.aspect) : this.camera.aspect; }

  /** Mirrored image coords -> normalized screen coords (y down), with the same cover-fit transform
   *  as the video, so a video pixel and the sigil on it land on the same screen pixel at any window size. */
  palmToScreen(x, y, out) { return videoToScreen(x, y, this.camera.aspect, this.videoAspect, out); }

  /** Mirrored image coords -> world position on the sigil plane (z = 0). */
  palmToWorld(x, y, out) {
    const sc = this.palmToScreen(x, y, this._sc);
    const halfH = this.halfH * CFG.anchor.followGain;
    out[0] = (sc[0] - 0.5) * 2 * halfH * this.camera.aspect;
    out[1] = -(sc[1] - 0.5) * 2 * halfH;
    return out;
  }

  /** Where the sigil should be drawn for a hand: its palm, led forward by its velocity. The
   *  landmarks describe a frame that is (capture + detection + the wait for the next one) old by the
   *  time a display frame shows it, and the exponential chase adds a little more, so the palm is
   *  extrapolated by that much — lightly, and not at all for a hand that is basically still. */
  palmTarget(track, out) {
    const t = this.t;
    let x = track.handX, y = track.handY;
    const p = CFG.ar.predict;
    if (this.ar && this.background.hasVideo) {
      const speed = Math.hypot(track.vx, track.vy);
      const w = Math.min(1, Math.max(0, (speed - p.minSpeed) / p.minSpeed));      // ramp in, so a jitter-level speed leads by nothing
      const lead = Math.min(p.maxLeadS, Math.max(0, t - track.lastHandT) + CFG.anchor.followTau) * p.gain * w;
      x += track.vx * lead; y += track.vy * lead;
    }
    return this.palmToWorld(x, y, out);
  }

  /** AR: the sigil's base size follows the hand's size in frame (closer hand -> bigger sigil), on
   *  top of the openness-driven size. Leaves it at 1 when not in AR. (Writes the sigil directly
   *  rather than returning a number: this runs every frame and must not allocate.) */
  applyBase(track, sigil, snap) {
    if (!this.ar || CFG.anchor.mode !== 'hand' || !track.scale) return;
    const a = CFG.ar;
    const f = Math.min(a.scaleMax, Math.max(a.scaleMin, track.scale / a.refScale)) ** a.scaleExp;
    sigil.baseTarget = a.baseAtRef * f * coverScale(this.camera.aspect, this.videoAspect);
    if (snap) sigil.base = sigil.baseTarget;
  }

  async startCamera(onStatus = () => {}, onEnded = () => {}) {
    this.cam?.stop();
    this.feed.stop();
    const cam = this.cam = new HandCamera(this.video);
    cam.onHands = (hands, t) => this._onDetect(hands, t);
    cam.onPreview = () => this.feed.start();
    cam.onEnded = () => { cam.stop(); this.feed.stop(); if (this.cam === cam) this.cam = null; onEnded(); };
    await cam.start(onStatus);
    this.lastEverHandSeenT = this.t;
  }

  /** One detection's worth of hands (camera or synthetic) — updates targets, nothing else. */
  _onDetect(hands, t) {
    if (this.cam?.running && this.video.videoWidth) this.ctl.aspect = this.video.videoWidth / this.video.videoHeight;
    this.ctl.onHands(hands, t);
    if (hands.length) this.lastEverHandSeenT = t;
    for (let i = 0; i < 2; i++) { const tr = this.ctl.tracks[i]; if (tr.present) this.calib.sample(tr.rawOpenness, tr.scale, t); }
    if (this.mask) {
      const list = this._maskHands; list.length = 0;
      for (const tr of this.ctl.tracks) if (tr.present) list.push({ lm: tr.lm, scale: tr.scale });
      this.mask.update(list, this.background.videoAspect ?? this.ctl.aspect);
    }
  }

  /** AR per-frame layer: feeds the composite pass and the ember clouds from each sigil's live state. */
  _updateAr() {
    const sa = this.camera.aspect, h2 = this.halfH * 2, spillR = CFG.ar.spill.radius, su = this.background.sigilUniforms;
    for (let i = 0; i < this.sessionList.length; i++) {
      // plain field writes, no calls taking doubles: this runs every frame and must not allocate
      const sg = this.sessionList[i].sigil, level = this.sessionList[i].shownLevel, u = su[i], pt = this.sparkList[i].points;
      u.x = 0.5 + sg.pos[0] / (h2 * sa); u.y = 0.5 + sg.pos[1] / h2; u.z = (sg.radius / h2) * spillR; u.w = level;
      pt.visible = level > 0.02;
      pt.position.x = sg.pos[0]; pt.position.y = sg.pos[1];
      pt.scale.x = pt.scale.y = pt.scale.z = sg.radius;
    }
  }

  // ---------------------------------------------------------------- frame
  frame(t) {
    const wallT0 = performance.now();
    this.renderer.info.reset();
    const dt = this.last === null ? 1 / 60 : clamp(t - this.last, 0, 1 / 20);
    this.last = t; this.t = t;

    if (this.handSource && t - this.lastSynthT >= 1 / 30 - 1e-6) {
      this.lastSynthT = t;
      const h = this.handSource(t);
      // a single hand IS an array too (21 [x, y] pairs) — only treat h as "an array of hands" when
      // its own first element is itself an array of points, not a bare [x, y] pair.
      const isHandsArray = Array.isArray(h) && Array.isArray(h[0]) && Array.isArray(h[0][0]);
      this._onDetect(isHandsArray ? h.filter(Boolean) : h ? [h] : [], t);
    }

    const anyShown = this.sessionList[0].stateMachine.shown || this.sessionList[1].stateMachine.shown;
    if (this.cam?.running) {
      // nobody here for a while: probe at a lower detection rate until a hand shows up again
      this.cam.minInterval = !anyShown && t - this.lastEverHandSeenT >= CFG.tracker.dormantIdleS ? 1 / CFG.tracker.dormantProbeHz : 0;
      this.cam.pump(t * 1000);
    }
    // one texture upload per NEW camera frame, not per display frame (and never on the detection path)
    if (this.feed.consume(t * 1000)) this.background.uploadFrame();

    this.calib.update(t, dt);
    emit('handState', this.ctl.snapshot(t));
    for (let i = 0; i < this.sessionList.length; i++) this.sessionList[i].step(t, dt);

    if (this.ar) this._updateAr();
    for (let i = 0; i < this.sparkList.length; i++) this.sparkList[i].update(t);
    const a = this.sessionList[0], b = this.sessionList[1];
    this.audio.setHum?.(Math.max(a.shownLevel, b.shownLevel) * a.sigil.intensity, a.sigil.spinMul);
    this.perf?.beginGpuQuery();
    this.composer.render();
    this.perf?.endGpuQuery();

    this._updateHint(t);
    if (this.hud) this._updateHud(t);
    this._afterRender(t, wallT0);
  }

  _updateHint(t) {
    const want = !!this.cam?.running && t - this.lastEverHandSeenT > CFG.hint.afterS;
    if (want === this._hintShown || !this.hint) return;
    this._hintShown = want;
    this.hint.classList.toggle('show', want);
  }

  _updateHud(t) {
    this.hud.update({
      ctl: this.ctl, fps: this.fps, detectMs: this.cam?.detectMs || 0, camDelegate: this.cam?.delegate,
      sigilStatus: this.sessionList[0].sigil.status(), anchorMode: CFG.anchor.mode, bgMode: CFG.background.mode,
      gesture: this.sessionList[0].mapper.status(t), sessions: this.sessionList.map((sx) => sx.status()),
      calib: this.calib.status(), audioMuted: this.audio.muted,
    });
    if (t - this._dbgT >= 1) {
      this._dbgT = t;
      for (const [i, tr] of this.ctl.tracks.entries()) {
        if (tr.present) console.debug(`[sigil] hand ${i}: raw pose ${tr.rawPose}, stable ${tr.pose}, openness raw ${tr.rawOpenness.toFixed(3)} -> ${tr.openness.toFixed(3)}, split ${tr.three}`);
      }
    }
  }

  _afterRender(t, wallT0) {
    this.frames++; this._fpsN++;
    if (t - this._fpsT >= 1) { this.fps = this._fpsN / (t - this._fpsT); this._fpsN = 0; this._fpsT = t; }
    const wallMs = performance.now() - wallT0;
    this.governor.sample(wallMs / 1000, t);
    if (this.perf) {
      this.perf.sample(wallMs);
      this.perf.update({
        renderer: this.renderer, detectMs: this.cam?.detectMs || 0, tier: this.governor.tier,
        sessionCount: this.sessionList.filter((sx) => sx.stateMachine.state !== DORMANT).length,
        renderFps: this.fps, detectFps: this.cam?.fps || 0, latencyMs: this.cam?.latencyMs || 0,
      });
    }
  }

  // ---------------------------------------------------------------- deterministic stepping (tests)
  setHand(h) { this.handSource = h === null || h === undefined ? null : typeof h === 'function' ? h : () => h; this.lastSynthT = -1; }
  advance(seconds, hand) {
    if (hand !== undefined) this.setHand(hand);
    const steps = Math.max(1, Math.round(seconds * 60));
    for (let i = 0; i < steps; i++) this.frame(this.t + 1 / 60);
  }

  centerPixel() {
    const gl = this.renderer.getContext();
    const w = this.renderer.domElement.width, h = this.renderer.domElement.height;
    const px = new Uint8Array(4);
    gl.readPixels(Math.floor(w / 2), Math.floor(h / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return [px[0], px[1], px[2], px[3]];
  }
}

// ---------------------------------------------------------------- dev harness (?dev=1 only)
// Keys drive synthetic hands through app.handSource -> Controller.onHands() -> the mappers,
// exactly the path a real detection takes.
function bindDevHarness(app) {
  const held = new Set();
  const h1 = { on: true, cx: 0.5, cy: 0.55, angle: 0, f: 1 };
  const h2 = { on: false, cx: 0.75, cy: 0.5, angle: 0, f: 1 };

  addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (!held.has(k)) {
      if (k === '1') h1.on = !h1.on;
      if (k === '2') h2.on = !h2.on;
      if (k === 'm') app.audio.setMuted(!app.audio.muted);
    }
    held.add(k);
  });
  addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()));

  const pose = (h, fistKey, threeKey) => held.has(threeKey) ? { pose: 'three' } : held.has(fistKey) ? { pose: 'fist' } : { pose: 'partial', f: h.f };
  app.setHand(() => {
    const step = 0.012;
    if (held.has('arrowleft')) h1.cx -= step;
    if (held.has('arrowright')) h1.cx += step;
    if (held.has('arrowup')) h1.cy -= step;
    if (held.has('arrowdown')) h1.cy += step;
    h1.cx = clamp(h1.cx, 0.08, 0.92); h1.cy = clamp(h1.cy, 0.1, 0.9);
    if (held.has('a')) h1.angle -= 0.04;
    if (held.has('d')) h1.angle += 0.04;
    if (held.has('[')) h1.f = clamp(h1.f - 0.02, 0, 1);
    if (held.has(']')) h1.f = clamp(h1.f + 0.02, 0, 1);
    if (held.has('j')) h2.angle -= 0.04;
    if (held.has('l')) h2.angle += 0.04;
    if (held.has('-')) h2.f = clamp(h2.f - 0.02, 0, 1);
    if (held.has('=')) h2.f = clamp(h2.f + 0.02, 0, 1);
    const out = [];
    if (h1.on) out.push(synthHand({ cx: h1.cx, cy: h1.cy, angle: h1.angle, ...pose(h1, 'f', 't') }));
    if (h2.on) out.push(synthHand({ cx: h2.cx, cy: h2.cy, angle: h2.angle, ...pose(h2, 'v', 'g') }));
    return out.length ? out : null;
  });
}

// ---------------------------------------------------------------- friendly failure messages
function showFallback(message, { retry, showIdle } = {}) {
  const msg = $('startMsg');
  if (msg) msg.textContent = message;
  let retryBtn = $('bRetryCam');
  if (retry) {
    if (!retryBtn) {
      retryBtn = document.createElement('button');
      retryBtn.id = 'bRetryCam';
      retryBtn.className = 'primary';
      retryBtn.textContent = 'Retry camera';
      retryBtn.style.marginTop = '8px';
      msg?.insertAdjacentElement('afterend', retryBtn);
    }
    retryBtn.onclick = retry;
  } else retryBtn?.remove();
  if (showIdle) { const s = $('start'); if (s) s.hidden = false; }
}

function cameraErrorMessage(e) {
  if (e?.name === 'NotAllowedError') return 'Camera permission was denied. The sigil below is idle without a camera — allow the camera and retry.';
  if (e?.name === 'NotFoundError') return 'No camera was found on this device. Showing an idle sigil instead.';
  if (e?.name === 'NotReadableError') return 'The camera is in use by another app, or the connection was lost. Showing an idle sigil instead.';
  return `Camera error: ${e?.message || e}. Showing an idle sigil instead.`;
}

// ---------------------------------------------------------------- boot
function boot() {
  if (!hasWebGL2()) {
    const msg = $('startMsg');
    if (msg) msg.textContent = 'This browser or device does not support WebGL2, which SIGIL needs to draw. Try a recent Chrome, Edge, Firefox or Safari.';
    $('bEnableCam')?.setAttribute('disabled', 'true');
    return;
  }

  const saved = loadCalibration();        // ?recalibrate=1 clears it and returns null
  if (saved) applyProfile(saved);

  const app = new App();
  const sessionA = app.sessions.get('A');

  const start = $('start');
  const hideStart = () => { start.hidden = true; };

  function idleShow() {
    // camera unusable: show an idle sigil rather than a blank canvas, and don't let the
    // no-hand rule dismiss it
    sessionA.mapper.keepAlive = true;
    sessionA.stateMachine.forceState(ACTIVE);
    sessionA.sigil.root.visible = true;
    sessionA.sigil.cast();
  }

  const lost = () => {
    console.warn('camera track ended');
    showFallback('The camera connection was lost. You can retry below.', { retry: enableCamera, showIdle: true });
  };

  async function enableCamera() {
    app.audio.unlock();
    const btn = $('bEnableCam');
    btn.disabled = true;
    try {
      await app.startCamera((s) => { const msg = $('startMsg'); if (msg) msg.textContent = s; }, lost);
    } catch (e) {
      console.error(e);
      btn.disabled = false;
      showFallback(cameraErrorMessage(e), { retry: enableCamera, showIdle: true });
      idleShow();
      return;
    }
    sessionA.mapper.keepAlive = false;     // (after an earlier failure's idle display) back to presence-driven
    showFallback('');
    btn.disabled = false;
    hideStart();
    document.documentElement.requestFullscreen?.().catch(() => {});
  }
  $('bEnableCam').onclick = enableCamera;

  if (FLAGS.dev) bindDevHarness(app);

  if (FLAGS.nocam) {
    hideStart();
    idleShow();
  } else if (FLAGS.autostart) {
    hideStart();
    enableCamera();
  } else if (FLAGS.manual) {
    // deterministic tests drive hands synthetically via advance()/setHand() — starting the real
    // camera too would race its async frames against the manual clock
    hideStart();
  }

  const sessB = () => app.sessions.get('B');
  window.sigilApp = {
    app, THREE, CFG, synth: synthHand,
    advance: (seconds, hand) => app.advance(seconds, hand),
    setHand: (h) => app.setHand(h),
    status: () => ({
      pose: app.ctl.pose, rawPose: app.ctl.rawPose, pinch: app.ctl.pinch, openness: app.ctl.openness, rawOpenness: app.ctl.rawOpenness,
      three: app.ctl.three, roll: app.ctl.roll, palm: { x: app.ctl.handX, y: app.ctl.handY }, handVisible: app.ctl.handVisible(app.t),
      secondPose: app.ctl.secondPose, secondPinch: app.ctl.secondPinch, secondVisible: app.ctl.secondVisible(app.t),
      t: app.t, fps: app.fps, frames: app.frames,
      sigil: sessionA.sigil.status(),
      sigilPos: sessionA.sigil.pos.slice(), sigilRoll: sessionA.sigil.roll, sigilScale: sessionA.sigil.scale,
      camera: app.cam ? { running: app.cam.running, fps: app.cam.fps, delegate: app.cam.delegate, frames: app.cam.frames, latencyMs: app.cam.latencyMs } : null,
      anchorMode: CFG.anchor.mode, bgMode: CFG.background.mode,
      state: sessionA.stateMachine.state, gesture: sessionA.mapper.status(app.t),
      hasSigilB: sessB().stateMachine.state !== DORMANT, sigilB: sessB().status(),
      sigilBPos: sessB().sigil.pos.slice(), sigilBScale: sessB().sigil.scale,
      audioMuted: app.audio.muted, quality: app.governor.status(), calib: app.calib.status(), paused: app.paused,
      hint: app._hintShown,
    }),
    centerPixel: () => app.centerPixel(),
    /** Normalized screen position (y down) that a mirrored image point is drawn at. */
    palmToScreen: (x, y) => app.palmToScreen(x, y, [0, 0]),
    /** Test hook: show a canvas as the AR backdrop, exactly as the camera frame would be. */
    setBackdrop: (canvas) => { app.background.setSource(canvas); app.background.uploadFrame(); },
    cast: () => sessionA.sigil.cast(),
    uncast: () => sessionA.sigil.uncast(),
    explode: (v) => sessionA.sigil.explode(v),
    solo: (name) => sessionA.sigil.solo(name),
    regroup: () => sessionA.sigil.regroup(),
    setSize: (p) => sessionA.sigil.setSize(p),
    part: (name) => sessionA.sigil.part(name),
    /** Test/dev-only: jumps straight to ACTIVE with no animation. The no-hand rule still applies. */
    forceActive: () => { sessionA.stateMachine.forceState(ACTIVE); sessionA.sigil.root.visible = true; sessionA.sigil.cast(); },
    sessionB: () => sessB(),
    unlockAudio: () => app.audio.unlock(),
    setCalibration: (profile) => applyProfile(profile),
    clearCalibration: () => app.calib.reset(),
  };

  if (!FLAGS.manual) {
    const loop = (ms) => { if (!app.paused) app.frame(ms / 1000); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
}
boot();

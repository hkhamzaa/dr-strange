// SIGIL — a glowing magic circle controlled only by webcam hand gestures. Phase 1 built the
// tracking -> intent bus -> renderer skeleton with one hardcoded rule (follow the palm). Phase 2
// adds the real gesture engine: a DORMANT/CASTING/ACTIVE/DISMISSING state machine and a mapper
// that turns Controller output into intents — summon, dismiss, resize, explode, solo, spin, tilt,
// pulse. The mapper never touches the sigil; every visual reaction here is a bus listener reading
// an intent payload, same as Phase 1's follow rule already was.
import * as THREE from 'three';
import { CFG, FLAGS, GESTURE_MAP } from './config.js';
import { emit, on } from './bus/bus.js';
import { Controller } from './input/controller.js';
import { HandCamera } from './input/tracker.js';
import { hand as synthHand } from './input/synth.js';
import { SigilStateMachine, ACTIVE } from './input/stateMachine.js';
import { GestureMapper } from './input/mapper.js';
import { Sigil } from './sigil/sigil.js';
import { makeScene } from './stage/scene.js';
import { makeBloom } from './stage/bloom.js';
import { makeFloor } from './stage/floor.js';
import { makeSparks } from './stage/sparks.js';
import { makeBackground } from './stage/background.js';
import { Hud } from './hud/hud.js';

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

class App {
  constructor() {
    this.canvas = $('stage');
    this.video = $('cam');

    const s = makeScene(THREE, this.canvas);
    this.scene = s.scene; this.camera = s.camera; this.renderer = s.renderer; this._resizeScene = s.resize;
    const b = makeBloom(THREE, this.renderer, this.scene, this.camera);
    this.composer = b.composer; this._resizeBloom = b.resize;

    this.floor = makeFloor(THREE); this.scene.add(this.floor);
    this.sparks = makeSparks(THREE); this.scene.add(this.sparks.points);
    this.background = makeBackground(THREE, this.video); this.scene.add(this.background.mesh);
    this.background.resize(this.camera);

    this.sigil = new Sigil(THREE);
    this.scene.add(this.sigil.root);

    this.ctl = new Controller();
    this.cam = null;
    this.handSource = null; this.lastSynthT = -1;
    this.lastHandSeenT = -1e9;

    this.stateMachine = new SigilStateMachine();
    this.mapper = new GestureMapper(this.ctl, this.stateMachine);

    this.hud = FLAGS.debug ? new Hud() : null;
    if (this.hud) {
      for (const name of ['summon', 'dismiss', 'spin', 'scale', 'resize', 'move', 'tilt', 'pulse', 'explode', 'solo', 'regroup'])
        on(name, (payload) => this.hud.logIntent(name, payload));
      this.stateMachine.onChange = (state, prev) => this.hud.logIntent('state', { from: prev, to: state });
    }

    this._wireFollowRule();
    this._wireGestureIntents();
    this._wireCastLifecycle();

    this.t = 0; this.last = null; this.frames = 0; this.fps = 0; this._fpsN = 0; this._fpsT = 0;

    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    this._resizeScene();
    this._resizeBloom();
    this.background.resize(this.camera);
  }

  /** The Phase-1 follow rule: in anchor "hand" mode, the sigil follows the primary palm and twists
   *  with hand roll. Phase 2 gates it to ACTIVE — while CASTING/DISMISSING the summon ritual plays
   *  undisturbed, and DORMANT has nothing visible to move anyway. Only ever reads intent payloads. */
  _wireFollowRule() {
    on('handState', (hs) => {
      if (CFG.anchor.mode !== 'hand' || this.stateMachine.state !== ACTIVE) return;
      if (hs.visible) {
        this.lastHandSeenT = hs.t;
        this.sigil.setPosTau(CFG.anchor.followTau);
        const nx = (hs.palm.x - 0.5) * 2 * CFG.anchor.followGain;
        const ny = (0.5 - hs.palm.y) * 2 * CFG.anchor.followGain;
        this.sigil.setPosition(nx, ny, 0);
        this.sigil.setRoll(hs.roll * CFG.anchor.tiltGain);
      } else if (hs.t - this.lastHandSeenT > CFG.anchor.releaseAfterS) {
        this.sigil.setPosTau(CFG.anchor.releaseTau);
        this.sigil.setPosition(0, 0, 0);
        this.sigil.setRoll(0);
      }
    });
  }

  /** Every other Phase-2 intent -> the matching Sigil call. Pure translation, no gesture logic. */
  _wireGestureIntents() {
    on('resize', (p) => this.sigil.setSizeT(p.t));
    on('explode', (p) => this.sigil.explode(p.amount));
    on('solo', (p) => this.sigil.solo(p.name));
    on('regroup', () => this.sigil.regroup());
    on('spin', (p) => this.sigil.setSpinMul(p.mul));
    on('tilt', (p) => { this.sigil.setTilt(p.x); this.sigil.setLeanY(p.y); });
    on('pulse', (p) => {
      if (p?.charging) { this.sigil.part(p.component).setReveal(p.progress * GESTURE_MAP.openHold.chargeGlow); return; }
      this.sigil.pulse(p?.component);
    });
  }

  /** summon/dismiss (from the state machine, via a snap or an open-palm hold) drive cast()/uncast(). */
  _wireCastLifecycle() {
    on('summon', () => this.sigil.cast());
    on('dismiss', () => this.sigil.uncast());
  }

  async startCamera(onStatus = () => {}) {
    this.cam = this.cam || new HandCamera(this.video);
    await this.cam.start(onStatus);
  }

  // ---------------------------------------------------------------- frame
  frame(t) {
    const dt = this.last === null ? 1 / 60 : clamp(t - this.last, 0, 1 / 30);
    this.last = t; this.t = t;

    this.ctl.aspect = this.cam?.running && this.video.videoWidth ? this.video.videoWidth / this.video.videoHeight : 1;
    if (this.cam?.running) {
      const hands = this.cam.poll();
      if (hands !== undefined) this.ctl.onHands(hands, t);
      if (this.cam.newFrame) { this.background.setHasVideo(true); this.cam.newFrame = false; }
    }
    if (this.handSource && t - this.lastSynthT >= 1 / 30 - 1e-6) {
      this.lastSynthT = t;
      const h = this.handSource(t);
      this.ctl.onHands(h ? [h] : [], t);
    }

    emit('handState', this.ctl.snapshot(t));
    this.mapper.update(t, dt);

    this.sigil.update(dt);
    this.sparks.update(t);
    this.composer.render();

    if (this.hud) {
      this.hud.update({
        ctl: this.ctl, fps: this.fps, detectMs: this.cam?.detectMs || 0, camDelegate: this.cam?.delegate,
        sigilStatus: this.sigil.status(), anchorMode: CFG.anchor.mode, bgMode: CFG.background.mode,
        gesture: this.mapper.status(t),
      });
    }

    this.frames++; this._fpsN++;
    if (t - this._fpsT >= 1) { this.fps = this._fpsN / (t - this._fpsT); this._fpsN = 0; this._fpsT = t; }
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
// Keys drive a synthetic hand through app.handSource, the exact same path a real camera frame
// takes into Controller.onHands() -> GestureMapper -> intents. No sigil method is called directly,
// so this exercises the real state machine and thresholds with no camera in the room.
function bindDevHarness(app) {
  const held = new Set();
  const dev = { cx: 0.5, cy: 0.5, angle: 0, dist: 1 };
  let snap = null;    // { t0 } while the momentary snap pose sequence is playing

  addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    held.add(k);
    if (k === 's' && !snap) snap = { t0: app.t };
  });
  addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()));

  app.setHand((t) => {
    const nudge = 0.014;
    if (held.has('arrowleft') && !held.has('i')) dev.cx -= nudge;
    if (held.has('arrowright') && !held.has('i')) dev.cx += nudge;
    if (held.has('arrowup') && !held.has('p')) dev.cy -= nudge;
    if (held.has('arrowdown') && !held.has('p')) dev.cy += nudge;
    dev.cx = clamp(dev.cx, 0.1, 0.9); dev.cy = clamp(dev.cy, 0.1, 0.9);

    if (snap) {
      const el = t - snap.t0;
      if (el < 0.13) return synthHand({ cx: dev.cx, cy: dev.cy, pose: 'snap_pressed' });
      if (el < 0.43) return synthHand({ cx: dev.cx, cy: dev.cy, pose: 'snap_released' });
      snap = null;
    }
    if (held.has('p')) {          // pinch -> explode; down shrinks the hand (explode out), up grows it back
      if (held.has('arrowup')) dev.dist = Math.min(2, dev.dist + 0.02);
      if (held.has('arrowdown')) dev.dist = Math.max(0.3, dev.dist - 0.02);
      return synthHand({ cx: dev.cx, cy: dev.cy, s: 0.085 * dev.dist, pose: 'pinch' });
    }
    if (held.has('i')) {                                              // point -> spin; left/right = roll
      if (held.has('arrowleft')) dev.angle -= 0.035;
      if (held.has('arrowright')) dev.angle += 0.035;
      return synthHand({ cx: dev.cx, cy: dev.cy, pose: 'point', angle: dev.angle });
    }
    if (held.has('v')) return synthHand({ cx: dev.cx, cy: dev.cy, pose: 'peace' });
    if (held.has('o')) return synthHand({ cx: dev.cx, cy: dev.cy, pose: 'open' });
    if (held.has('f')) return synthHand({ cx: dev.cx, cy: dev.cy, pose: 'fist' });
    return null;
  });
}

// ---------------------------------------------------------------- boot
function boot() {
  const app = new App();

  const start = $('start');
  const hideStart = () => { start.hidden = true; };
  const msg = $('startMsg');
  $('bEnableCam').onclick = async () => {
    try { await app.startCamera((s) => { if (msg) msg.textContent = s; }); }
    catch (e) { console.error(e); if (msg) msg.textContent = `Camera error: ${e.message}`; return; }
    hideStart();
    // no auto-cast: the sigil starts DORMANT and waits for a snap or an open-palm hold, same as
    // every other session — enabling the camera only clears the permission gate.
  };

  if (FLAGS.dev) bindDevHarness(app);

  if (FLAGS.nocam) {
    // visual tuning only: skip the tracker and the gesture engine entirely, show the fully-cast
    // sigil straight away. Matches the state machine to ACTIVE so the HUD doesn't read DORMANT
    // under a lit sigil.
    hideStart();
    app.stateMachine.forceState(ACTIVE);
    app.sigil.cast();
  } else if (FLAGS.autostart || FLAGS.manual) {
    hideStart();
    app.startCamera().catch((e) => console.error(e));
  }

  window.sigilApp = {
    app, THREE, CFG, synth: synthHand,
    advance: (seconds, hand) => app.advance(seconds, hand),
    setHand: (h) => app.setHand(h),
    status: () => ({
      pose: app.ctl.pose, rawPose: app.ctl.rawPose, pinch: app.ctl.pinch, openness: app.ctl.openness,
      roll: app.ctl.roll, palm: { x: app.ctl.handX, y: app.ctl.handY }, handVisible: app.ctl.handVisible(app.t),
      t: app.t, fps: app.fps, frames: app.frames,
      sigil: app.sigil.status(),
      sigilPos: app.sigil.pos.slice(), sigilRoll: app.sigil.roll, sigilScale: app.sigil.scale,
      camera: app.cam ? { running: app.cam.running, fps: app.cam.fps, delegate: app.cam.delegate, frames: app.cam.frames } : null,
      anchorMode: CFG.anchor.mode, bgMode: CFG.background.mode,
      state: app.stateMachine.state, gesture: app.mapper.status(app.t),
    }),
    centerPixel: () => app.centerPixel(),
    cast: () => app.sigil.cast(),
    uncast: () => app.sigil.uncast(),
    explode: (v) => app.sigil.explode(v),
    solo: (name) => app.sigil.solo(name),
    regroup: () => app.sigil.regroup(),
    setSize: (p) => app.sigil.setSize(p),
    part: (name) => app.sigil.part(name),
    /** Test/dev-only: jumps straight to ACTIVE with no animation, no camera, no gesture required. */
    forceActive: () => { app.stateMachine.forceState(ACTIVE); app.sigil.cast(); },
  };

  if (!FLAGS.manual) {
    const loop = (ms) => { app.frame(ms / 1000); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
}
boot();

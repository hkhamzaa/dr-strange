// One hand -> one sigil's intents. `hand` is a HandTrack (or the Controller, whose fields proxy its
// primary track). Presence drives summon/dismiss; openness drives size; the split pose drives
// explode. Roll and palm position are applied by the follow rule in app.js from the same hand.
// Emits onto the bus only — never touches a sigil.
import { emit } from '../bus/bus.js';
import { GESTURE_MAP } from '../config.js';
import { DORMANT, DISMISSING } from './stateMachine.js';

export class GestureMapper {
  constructor(hand, stateMachine) {
    this.ctl = hand;
    this.sm = stateMachine;
    this.keepAlive = false;      // ?nocam / camera-failure idle display: never dismiss for lack of a hand
    this.split = false;
    this.frozenSize = null;      // size target held while the split pose arms or holds
    this.label = 'none';
    // reused payloads — this runs every render frame
    this._resize = { t: 0.5 };
    this._explode = { amount: 0 };
    this._pulse = { gesture: 'split' };
  }

  update(t, dt) {
    const h = this.ctl, sm = this.sm, g = GESTURE_MAP.presence;
    sm.tick(dt);

    const present = h.streak >= g.confirmFrames && t - h.lastHandT < g.graceS;
    if (present && (sm.state === DORMANT || sm.state === DISMISSING)) sm.summon('hand');
    else if (!present && sm.shown && !this.keepAlive) { this._unsplit(); sm.dismiss(undefined, 'handLost'); }

    if (!sm.shown) { this.label = sm.state; return; }
    if (!h.handVisible(t)) { this.label = 'dropout'; return; }    // inside the grace window: hold everything

    if (h.three && !this.split) {
      this.split = true;
      this._explode.amount = 1; emit('explode', this._explode);
      emit('pulse', this._pulse);
    } else if (!h.three && this.split) this._unsplit();

    if (h.three || h.threeArming) {
      if (this.frozenSize === null) {
        this.frozenSize = h.recentMaxOpenness(t, GESTURE_MAP.split.freezeLookbackS);
        this._resize.t = this.frozenSize; emit('resize', this._resize);
      }
      this.label = this.split ? 'split' : 'split-arming';
    } else {
      this.frozenSize = null;
      this._resize.t = h.openness; emit('resize', this._resize);
      this.label = 'size';
    }
  }

  _unsplit() {
    if (!this.split) return;
    this.split = false;
    this._explode.amount = 0; emit('explode', this._explode);
  }

  /** Gesture-state snapshot for the ?debug=1 HUD. */
  status(t) {
    const h = this.ctl;
    return {
      state: this.sm.state, label: this.label,
      raw: h.landmarks ? { pose: h.rawPose, openness: +h.rawOpenness.toFixed(3), normalized: +h.openness.toFixed(3), scale: +(h.scale ?? 0).toFixed(4) } : null,
      gates: {
        split: this.split ? 'active' : h.threeArming ? 'arming' : 'idle',
        size: this.frozenSize !== null ? 'frozen' : h.handVisible(t) ? 'live' : 'held',
      },
    };
  }
}

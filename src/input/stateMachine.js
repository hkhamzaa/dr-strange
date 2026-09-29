// DORMANT -> CASTING -> ACTIVE -> DISMISSING -> DORMANT. The mapper drives this with a snap or an
// open-palm hold; nothing else touches it. Every transition emits summon/dismiss on the bus — the
// sigil's own cast()/uncast() sweep is wired to those intents elsewhere, this module never imports
// the sigil itself.
import { emit } from '../bus/bus.js';
import { CFG } from '../config.js';

export const DORMANT = 'dormant', CASTING = 'casting', ACTIVE = 'active', DISMISSING = 'dismissing';

export class SigilStateMachine {
  constructor() {
    this.state = DORMANT;
    this._clock = 0;
    this._t0 = 0;              // clock value when the current state was entered
    this.onChange = null;      // optional (state, prev, clock) => void, for the HUD log
  }

  get elapsed() { return this._clock - this._t0; }
  get inGesture() { return this.state === ACTIVE; }       // CASTING/DISMISSING ignore gesture input

  _enter(state) {
    const prev = this.state;
    this.state = state;
    this._t0 = this._clock;
    this.onChange?.(state, prev, this._clock);
  }

  snap() {
    if (this.state === DORMANT) { this._enter(CASTING); emit('summon', { via: 'snap' }); }
    else if (this.state === ACTIVE) { this._enter(DISMISSING); emit('dismiss', { via: 'snap' }); }
  }

  /** Fallback for when snaps are unreliable: an open palm held through the whole hold window. */
  openHoldSummon() {
    if (this.state === DORMANT) { this._enter(CASTING); emit('summon', { via: 'hold' }); }
  }

  tick(dt) {
    this._clock += dt;
    if (this.state === CASTING && this.elapsed >= CFG.reveal.castS) this._enter(ACTIVE);
    else if (this.state === DISMISSING && this.elapsed >= CFG.reveal.castS) this._enter(DORMANT);
  }

  /** Skips straight to a state with no animation and no intent — only for ?nocam=1 visual tuning. */
  forceState(state) { this._enter(state); }
}

// DORMANT -> CASTING -> ACTIVE -> DISMISSING -> DORMANT, driven purely by hand presence: the
// mapper calls summon() when a hand appears and dismiss() once it's been gone past the grace
// period. A hand coming back mid-dismiss re-summons straight from DISMISSING (the sigil's sweep
// reverses from wherever it got to). Every transition emits summon/dismiss on the bus — this
// module never imports the sigil itself.
import { emit } from '../bus/bus.js';
import { CFG } from '../config.js';

export const DORMANT = 'dormant', CASTING = 'casting', ACTIVE = 'active', DISMISSING = 'dismissing';

const dismissDuration = (style) => style === 'shatter' ? CFG.dismiss.shatter.durationS
  : style === 'dissolve' ? CFG.dismiss.dissolve.durationS : CFG.reveal.uncastS;

export class SigilStateMachine {
  constructor(id = 'A') {
    this.id = id;
    this.state = DORMANT;
    this._clock = 0;
    this._t0 = 0;              // clock value when the current state was entered
    this._dismissStyle = 'uncast';
    this.onChange = null;      // optional (state, prev, clock) => void, for the HUD log
  }

  get elapsed() { return this._clock - this._t0; }
  get shown() { return this.state === CASTING || this.state === ACTIVE; }

  _enter(state) {
    const prev = this.state;
    this.state = state;
    this._t0 = this._clock;
    this.onChange?.(state, prev, this._clock);
  }

  summon(via = 'hand') {
    if (this.state !== DORMANT && this.state !== DISMISSING) return;
    const from = this.state;
    this._enter(CASTING);
    emit('summon', { via, from, sigil: this.id });
  }

  /** style is 'uncast' | 'dissolve' | 'shatter'. Acts from CASTING or ACTIVE. */
  dismiss(style = CFG.dismiss.style, via = 'handLost') {
    if (!this.shown) return;
    this._dismissStyle = style;
    this._enter(DISMISSING);
    emit('dismiss', { via, style, sigil: this.id });
  }

  tick(dt) {
    this._clock += dt;
    if (this.state === CASTING && this.elapsed >= CFG.reveal.castS) this._enter(ACTIVE);
    else if (this.state === DISMISSING && this.elapsed >= dismissDuration(this._dismissStyle)) this._enter(DORMANT);
  }

  /** Skips straight to a state with no animation and no intent — for ?nocam=1 and tests. */
  forceState(state) { this._enter(state); }
}

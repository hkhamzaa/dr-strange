# SIGIL

A glowing orange-gold magic circle, controlled only by webcam hand gestures. No keyboard, no mouse
— the only pointer interaction in the whole app is the one "Enable camera" button a browser
requires for permission.

This is **Phase 2 of 4**: the gesture engine. Phase 1 built the procedural sigil, the intent bus,
the stage and the component system, with one hardcoded rule (follow the palm). Phase 2 adds a real
`DORMANT → CASTING → ACTIVE → DISMISSING` state machine and a gesture mapper that turns hand
tracking into intents — summon, dismiss, resize, explode, solo, spin, tilt, pulse. The mapper never
touches a Sigil method directly; every visual reaction is still a bus listener, same as Phase 1.

Built on top of [WonderSnap](https://github.com/AkbarSheikh-debug/wondersnap)'s hand-tracking
stack (MediaPipe wrapper, gesture classifier, controller pattern, synthetic-hand test fixtures) —
its particle-model system, catalog, quiz, voice and recorder are gone; the visuals here are an
entirely original, procedurally generated seal (SDF line art + a baked rune-glyph atlas), not a
reproduction of any film or franchise artwork.

## Run it

```
npm install
npm start
```

Open `http://localhost:5173`, click **Enable camera**, then **snap your fingers** (or hold an open
palm still for half a second) to summon the sigil.

## Gestures

| gesture | while | does | intent |
|---|---|---|---|
| Snap | DORMANT / ACTIVE | summons / dismisses | `summon` / `dismiss` |
| Open palm held 0.5s | DORMANT only | summons — a fallback for when a snap is missed | `summon` |
| Hand visible, any pose | ACTIVE | the sigil follows your palm and twists with your hand's roll | `move` / `tilt`-ish (Phase 1's follow rule) |
| Openness (continuous) | ACTIVE, not pinching | resizes between `smol` and `full` | `resize` |
| Pinch + move hand toward/away | ACTIVE | pulls the sigil apart; releasing eases back together over ~0.6s | `explode` |
| Peace sign | ACTIVE | cycles `solo()` through outerSeal → tickRing → starCore → innerSeal → heart → regroup, one step per gesture, 0.7s cooldown | `solo` / `regroup` |
| Point (index only), twist | ACTIVE | sets the whole sigil's spin speed — clockwise faster, counter-clockwise slower; eases back to 1× over 1.5s once you let go | `spin` |
| Palm offset from frame centre | ACTIVE | the sigil leans toward your hand | `tilt` |

Every recognized gesture also fires a `pulse` — a short brightness surge on the component it
affected (or the whole sigil, for snap/peace-regroup). The exact numbers (dwell times, cooldowns,
release curves) live in one table, `GESTURE_MAP` in `src/config.js` — see **Tuning** below.

**Deliberate deviation from the brief:** the continuous openness→resize mapping is suspended while
pinching. Without that, a pinched hand's ambiguous openness would fight the pinch→explode gesture
for the same continuous channel. Resize resumes live tracking the instant the pinch releases.

## Robustness

- **Hysteresis.** Every continuous gesture (explode, spin, solo-cycle) is gated by a `DwellGate`:
  the raw signal (pinch, point pose, peace pose) must hold for an *arm* window before the gesture
  is trusted, and drop for a *release* window before it lets go. A single noisy frame can't flip
  either direction. While released-but-not-yet-let-go, the gesture's live value freezes rather than
  chasing whatever the hand shape becomes next — see the "one real bug" note below.
- **Hand-lost policy.** No hand for 0.4s: continuous gestures freeze at their last value (the
  mapper simply stops touching their targets). No hand for 6s while ACTIVE: spin and tilt ease back
  to rest — the sigil doesn't dismiss itself, it just calms down.
- **Primary hand only.** A second hand is tracked (Controller already does primary/secondary
  selection) but the mapper ignores it this phase. Phase 3 uses it.
- **Session hygiene.** The instant ACTIVE gives way to DISMISSING, the mapper neutralizes itself —
  regroup, spin back to 1×, tilt back to 0 — so the next summon doesn't inherit a half-exploded,
  spun-up sigil from the session that just ended.

## URL flags

| flag | effect |
|---|---|
| `?debug=1` | Debug HUD: hand skeleton, gesture chip with a progress bar, calibration readout, per-gesture state, last 5 intents, per-component state |
| `?dev=1` | Dev harness keys — see below. Drives the real Controller → GestureMapper path, not a shortcut. |
| `?autostart=1` | Skip the start panel and request the camera immediately (still starts DORMANT — you still gesture to summon) |
| `?nocam=1` | Boot straight into a fully-cast, ACTIVE sigil with no camera and no gesture engine at all — for visual tuning |
| `?anchor=hand\|stage` | Anchor mode (default `hand`): follow the palm, or stay centered |
| `?bg=void\|ar` | Background mode (default `void`): near-black vignette, or the dimmed webcam feed |
| `?manual=1` | Deterministic clock for tests — frames only advance via `window.sigilApp.advance()` |
| `?dpr=<n>` | Override the device-pixel-ratio clamp (default 1.5) |

### Dev harness (`?dev=1` only)

Keys drive a synthetic hand through the exact same `Controller.onHands()` → `GestureMapper` path a
real camera frame takes — no Sigil method is called directly, so this exercises the real state
machine and thresholds with no camera in the room.

| key | hand pose | notes |
|---|---|---|
| `S` | a scripted snap (press → release) | momentary, fires once per keypress |
| hold `O` | open palm | DORMANT: fallback hold-summon. ACTIVE: resize toward `full` |
| hold `F` | fist | ACTIVE: resize toward `smol` |
| hold `P` | pinch | ACTIVE: explode. **Down arrow** shrinks the simulated hand (explode out), **Up arrow** grows it back |
| hold `I` | point | ACTIVE: spin control. **Left/Right arrow** twists the simulated roll |
| hold `V` | peace | cycles solo |
| arrow keys (no pose held) | — | nudges the simulated palm position — drives tilt, or follow in `hand` anchor mode |

## Tuning

Every threshold is in `GESTURE_MAP` and `CFG.gestures` in `src/config.js` — nothing is hardcoded in
`mapper.js` itself. With `?debug=1`, the HUD's **calibration** block shows live raw values
(openness, pinch ratio, hand scale, snap ratio) and each gesture's current state (`idle` /
`arming` / `active` / `releasing` / `cooldown` / `suspended`) so you can watch a threshold land in
real time while you move your hand, instead of guessing from source.

If gestures feel twitchy: raise the relevant `armS`. If releasing feels sticky: lower `releaseS`.
If explode is too sensitive to small hand-depth changes: raise `explode.scaleRange`. If spin winds
up too fast: lower `spin.gain`.

## Architecture

```
src/
  input/      tracker.js (MediaPipe wrapper), gestures.js, controller.js, synth.js — hand -> pose/palm/roll
              stateMachine.js — DORMANT/CASTING/ACTIVE/DISMISSING, emits summon/dismiss
              mapper.js — Controller output -> intents; owns all gesture thresholds via config
  bus/        bus.js — the only channel visual code listens on; intent names declared up front
  sigil/      shaders.js (SDF stroke/ring/star/tick/rune-band GLSL), glyphs.js (rune atlas),
              layer.js (one quad + material), component.js (grouped layers + animated transform,
              plus the decaying `flash` a pulse triggers), sigil.js (the public Sigil API)
  stage/      scene.js, bloom.js, floor.js, sparks.js, background.js
  hud/        hud.js — debug overlay, only ever built with ?debug=1
  config.js   every tunable: colors, layer composition, component membership, bloom, anchor,
              presets, and GESTURE_MAP (Phase 2's gesture -> intent -> params table)
  app.js      boot, main loop, dev harness, window.sigilApp test API
```

**Data flow.** `tracker.js` polls the camera once per new video frame and hands 21-point landmarks
(mirrored) to `Controller`, which classifies pose, tracks primary/secondary hand selection, palm
centre and smoothed roll. Every frame, `app.js` turns that into a `handState` intent, and
`GestureMapper.update()` reads the Controller directly (it's allowed to — it's the one place raw
hand data becomes meaning) to drive the state machine and emit every other intent. Nothing past
that point — not the sigil, not the stage, not the HUD's calibration panel via its own data path —
ever reads a landmark itself; visuals only ever hear intents, exactly like Phase 1's follow rule.

**The sigil.** Thirteen layers (rings, star polygons `{9/4}` `{7/2}` `{12/5}`, a rotated square
pair, tick ring, two rune bands, a glow disc), each a flat additive-blended quad whose fragment
shader computes a signed distance to hand-unrolled line segments (or, for rings and ticks, a
closed-form annulus/angular-repeat distance) and shades it with a soft glow and the orange-to-gold
ramp. Rune bands sample one shared 8×8 glyph atlas (baked once on an offscreen canvas at startup,
deterministic per `config.seed`) via a per-slot hash. Layers are grouped into five named
`Component`s (`outerSeal`, `tickRing`, `starCore`, `innerSeal`, `heart`); every component and the
`Sigil` root itself share the same setter contract (`setSpinMul`, `setScale`, `setTilt`, `setLeanY`,
`setPosition`, `setIntensity`, `flash`/`pulse`) and animate toward their targets by exponential
smoothing. `cast()` staggers each component's angular reveal sweep from outer to inner over ~1.2s;
`uncast()` reverses it. Phase 2 additions are purely additive: `setSizeT(t)` (continuous size
between the `smol`/`full` presets), `setLeanY` (the second tilt axis — "leans toward the hand"
needs both), and `pulse(name?)` (a decaying brightness surge on one component or the whole sigil).

## Tests

```
npm test
```

Playwright drives the real app in Chromium (real GPU, `--use-angle=d3d11` on Windows) with a fake
webcam device — no physical camera needed.

- `logic.spec.js`, `bus.spec.js`, `sigil.spec.js`, `boot.spec.js` — Phase 1, unchanged and still
  green (`boot.spec.js`'s `?nocam=1` case now also asserts the state machine reads ACTIVE).
- `gestures.spec.js` — Phase 2: snap driving the full state cycle, the open-palm-hold fallback
  summon, openness→size convergence, pinch+hand-scale→explode with release→regroup, peace cycling
  solo in order while respecting its cooldown (including that holding the pose past the cooldown
  does *not* re-trigger without a release edge first), and a jitter test asserting a noisy 6-frame
  pose burst produces zero premature flips before a clean run settles.

One real bug the tests (and a lot of manual tracing) caught during development: the hysteresis
release window was re-deriving each continuous gesture's live value from whatever the hand became
*next* — so releasing a point-pose spin twist by opening the hand briefly sent the spin multiplier
plunging toward its clamped minimum before recovering. Fixed by freezing the value the instant the
raw pose condition goes false, and only starting the release ramp once the hysteresis window fully
elapses.

## Out of scope (Phase 2)

Two-hand control, multiple sigils, sound, shatter effects, external 3D model loading.

**Planned for Phase 3:** the second hand. Two-hand spread scales the sigil; the second hand grabs
and moves a single component (most likely gated behind the second hand pinching, to disambiguate
from the spread gesture).

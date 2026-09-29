# SIGIL

A glowing orange-gold magic circle that appears on your palm, driven only by your hands in front of
the webcam. No keyboard, no mouse, no setup step — the only pointer interaction is the one
"Enable camera" button a browser requires for permission.

The visuals are an entirely original, procedurally generated seal (SDF line art + a baked
rune-glyph atlas). Hand-tracking plumbing started from
[WonderSnap](https://github.com/AkbarSheikh-debug/wondersnap)'s stack; its particle models,
catalog, quiz, voice and recorder are gone.

## Quick start

```
npm install
npm start
```

`npm start` runs `scripts/dev-server.mjs`, a zero-dependency static server (`node scripts/dev-server.mjs [port] [dir]`; pass `dist` to check a production build).

Open `http://localhost:5173` (camera access needs a secure context — `localhost` counts, a plain
`http://` IP address does not), click **Enable camera**, and hold up a hand. The live, mirrored
camera fills the screen and the sigil casts in on your palm the moment it's in view (see **AR
mode**). There is no calibration screen: the app starts with sane
defaults and silently adapts to your hand while you play (see **Calibration**).

## AR mode (the default)

The mirrored webcam feed is the whole stage — full brightness, natural colour (only a 6 % dim so
the glow reads), `cover`-fitted with no letterboxing — and the sigil is composited on top of you,
attached to your hand. `?bg=void` brings back the old near-black vignette stage as a dev override;
nothing else switches it on or off.

- **One transform for everything.** The palm centre goes from video coordinates to the screen with
  the same cover-fit transform the video uses (`src/stage/cover.js`, mirrored in the composite
  shader), so the sigil sits on the palm at any window size or aspect ratio. `tests/ar.spec.js`
  renders a dot at a known video pixel and checks it lands within 2 px of where a palm at that
  pixel is drawn, across five window shapes.
- **Sized by the hand.** Base size follows the hand's size in frame (wrist → knuckle length), so
  moving your hand closer makes the sigil larger — on top of the openness-driven size
  (`CFG.ar.baseAtRef`, `refScale`).
- **No trailing.** The palm is led forward by its filtered velocity × (time since the frame the
  landmarks describe + the follow chase), capped at 120 ms and ramped in above a jitter-level speed
  (`CFG.ar.predict`). Rendering never waits on detection: the video is uploaded to the GPU only when
  the camera produces a new frame (`videoFeed.js`, requestVideoFrameCallback with a polling
  fallback), and detection sees a separate 640-px-wide downscaled copy of each 1280×720 frame, so
  the picture stays sharp and detection stays cheap.
- **How the picture is composed.** The sigil scene + bloom render on black; the last composer pass
  (`stage/background.js`) lays them over the video. That keeps the camera out of tone mapping and
  bloom (natural colour) while the sigil still gets its ACES curve. The floor and reflection are
  hidden in AR; the embers ride on each sigil rather than filling the frame.
- **Readable on a bright wall.** Where the video behind the sigil is bright, the glow gets a small
  boost and a soft dark halo is laid behind the strokes (which is what actually makes them read —
  additive light on a white wall can't). A warm radial light spill lights the video around the
  sigil; it's a gradient in the composite pass, not real lighting.
- **Occlusion (off by default).** `?occlusion=1` / `CFG.ar.occlusion.enabled` draws the sigil
  slightly behind the fingers: each finger's joints go through a convex hull, inflated to finger
  width and feathered into a small 2D mask (the palm is left out — the sigil lives there). It is
  off by default because a curled fist puts the fingers across the palm, which hides the sigil the
  fist is meant to shrink; measure it on your camera before turning it on.
- **Start screen.** A single "Enable camera" button over a blurred view of the canvas: dark until
  you grant permission, then the live feed (blurred) while the hand tracker loads. No HUD in normal
  mode; the only text on screen is "Show your hand to the camera", which goes away once a hand is
  seen.

## Gestures

Presence and pose only — every hand drives its own sigil through the same map.

| you do | the sigil does | intent |
|---|---|---|
| Show a hand | casts in immediately with the draw-in sweep, centred on your palm, and follows it | `summon` |
| Take all hands away | holds through a 0.5 s grace period (tracking dropouts), then uncasts with a fast 0.4 s fade. No hand, no sigil | `dismiss` |
| Open your hand | grows to full size | `resize` |
| Close to a fist | shrinks to its smallest (`smol`) size | `resize` |
| Anything in between | size follows openness continuously — half-open hand, half-size sigil | `resize` |
| Rotate your hand (roll) | rotates with it one to one, smoothed; the layers keep their own counter-spin on top | (follow rule) |
| Three-finger pose — thumb, index and middle out, ring and pinky curled | splits apart into its components. Hold to keep it split; release and it regroups over ~0.6 s | `explode` |
| Two hands | two sigils, one per hand, each driven by its own hand through everything above | — |
| One of two hands leaves | only that hand's sigil uncasts; the other stays put on its own hand | `dismiss` |

**Priority, per hand:** the three-finger pose beats size changes. Size is frozen from the moment
the pose starts arming until it's released, at the largest size seen in the 0.3 s before — curling
the ring and pinky away naturally lowers openness, and "split the enlarged sigil" shouldn't shrink
it first.

**Robustness.** OPEN counts any 4 of 5 digits extended (the thumb is optional). Every pose test is a
ratio of distances computed on aspect-corrected landmarks, so it works at any hand rotation and any
distance from the camera. The split pose has its own classifier with threshold hysteresis (looser
once active) plus a 0.15 s arm / 0.12 s release dwell, so a jittery hand can't flicker it into
peace, point or open.

Thresholds live in `GESTURE_MAP` in `src/config.js`.

## Smoothness

- **Detection never shares the render thread.** MediaPipe runs in a Web Worker
  (`src/input/detectWorker.js`), paced by the video's own frame callback. One frame is in flight at
  a time; a camera frame that arrives while the worker is busy is dropped, never queued. The render
  loop runs at display refresh and only reads the latest targets. (Browsers that can't run the
  worker fall back to main-thread detection, scheduled as its own task between frames.)
- **One-Euro filtering** on landmarks, palm position, roll, openness and hand scale, each with
  parameters tuned to its own units (`CFG.filter`): heavy smoothing when the hand is still, almost
  no lag when it moves fast.
- **Every visual value chases its target** with frame-rate-independent exponential smoothing
  (`x += (target − x)·(1 − e^(−dt/τ))`) — position, scale, rotation, explode. No snapping, no
  stepping between 30 Hz detections. A sigil casting in on a newly seen hand appears directly on
  the palm (at that hand's size and roll) rather than sliding over from wherever it last was; a
  hand returning mid-fade reverses the sweep from where it got to.
- **Camera:** 1280×720 @ 30 fps requested for the visible feed (detection runs on a 640-px downscaled copy), GPU delegate with CPU fallback, at most two hands per
  detection. MediaPipe's multi-second first-detection warm-up happens inside the worker before the
  start screen closes, so the first real frame isn't a stall.
- **No per-frame allocation in our frame loop** (`tests/perf.spec.js`): reused intent payloads and
  snapshot objects, index loops instead of iterators, copy-on-write listener arrays on the bus, a
  ring buffer in the quality governor, unboxed float uniforms. See **Performance notes**.
- Both sigils are built and pre-rendered once at boot and hidden while dormant, so neither the
  first hand nor a second hand ever pays for building or uploading a sigil mid-interaction.

**Model note:** MediaPipe publishes the hand landmarker only as the single `hand_landmarker.task`
bundle (float16); there is no separate "lite" `.task` bundle for the Tasks API, so that's what
ships. The path is one constant in `src/input/tracker.js` if a lighter bundle becomes available.

## Calibration

None to do. `src/calib/calibrate.js` keeps a rolling 30 s window of the openness and hand scale
your hands actually reach and eases the fist/open bounds (which normalize openness → size) toward
that window's min/max, so a hand that never fully opens or closes still spans the full size range.
Hard limits keep the range from collapsing if, say, you only ever show an open hand. The adapted
profile persists in `localStorage` (`sigil.calib.v2`); `?recalibrate=1` resets it. With `?debug=1`
the HUD shows the live raw pose, raw and normalized openness, and the adapted bounds per hand, and
the console logs them once a second.

**Why the old guided calibration stalled at "Hold your hand open, 0%":** MediaPipe normalizes
landmark x by the frame's width and y by its height. On a 16:9 camera that squashes horizontal
distances by ~44%, so an upright open hand's sideways thumb read as tucked, the strict "all four
fingers *and* thumb out" OPEN rule failed, and the pose came back `other`. On top of that, the old
flow reset its 2 s hold timer to zero on any single missed frame. Fixed at the root: poses are now
classified on aspect-corrected landmarks, OPEN is 4-of-5 with the thumb optional, and there is no
blocking flow left to stall (`tests/logic.spec.js` pins the regression).

## Deploying

```
npm run build
```

produces a self-contained `dist/` folder: no bundler, just `src/**/*.js` and `styles.css` copied
out with content-hashed filenames (cache-busted on every build) and their import specifiers — and
the detection worker's `new URL(…, import.meta.url)` — rewritten to match, plus the vendored `three`
build + postprocessing addons, the MediaPipe `tasks-vision` wasm runtime, and the hand-landmark
model at the same relative paths the app already expects. `dist/` is a static site.

- **Netlify** — publish directory `dist`, build command `npm run build`. `_headers` sets
  long-cache-immutable on the hashed files, a shorter revalidating cache on vendored assets, and
  no-cache on `index.html`/`sw.js`.
- **Vercel** — `vercel.json` sets `buildCommand`/`outputDirectory` and the same header rules.
- **GitHub Pages** — `.github/workflows/deploy.yml` builds and publishes `dist/` on every push to
  `main`. Enable Pages under Settings → Pages → Source → "GitHub Actions" once. All references are
  relative, so a project-page subpath works.

All three give HTTPS automatically, which the camera requires off `localhost`.

## URL flags

| flag | effect |
|---|---|
| `?debug=1` | Debug HUD: hand skeletons, per-hand raw/stable pose, raw → normalized openness, split gate, both sigils' state, adapted calibration bounds, last intents; plus a once-a-second console log |
| `?dev=1` | Dev harness keys (below) — synthetic hands through the real Controller → mapper path |
| `?perf=1` | Render fps, detection fps and capture-to-landmarks latency, plus frame time avg/p95, GPU time, draw calls, triangles, heap, quality tier |
| `?record=1` | (with `?debug=1`) a record button capturing canvas + audio to WebM |
| `?quality=high\|mid\|low` | Pin a quality tier (disables the governor) |
| `?recalibrate=1` | Reset the adapted calibration profile |
| `?autostart=1` | Skip the start button and request the camera immediately |
| `?nocam=1` | No camera: a fully cast idle sigil for visual tuning (the no-hand rule is off) |
| `?anchor=hand\|stage` | Follow the palm (default) or stay centred |
| `?bg=void` | Dev override: the old dark vignette stage instead of the camera. **AR — the live camera fullscreen — is the default**; there is no flag for it |
| `?occlusion=1` | Draw the sigil slightly behind the fingers (soft finger-silhouette mask; off by default) |
| `?dismiss=uncast\|dissolve\|shatter` | What "hand gone" looks like (default the fast uncast) |
| `?loadtimeout=<s>` | How long the hand tracker may take to load before the start screen shows an error + Retry (default 15) |
| `?dpr=<n>`, `?mute=1` | Device-pixel-ratio clamp; start muted |
| `?manual=1` | Deterministic clock for tests — frames only advance via `window.sigilApp.advance()`; the real camera is never started |

A plain load with no query string reaches none of these.

### Dev harness (`?dev=1`)

| key | does |
|---|---|
| `1` / `2` | toggle hand A / hand B in and out of view |
| arrows | move hand A |
| `A` / `D` | roll hand A |
| `[` / `]` | close / open hand A continuously |
| hold `F` / hold `T` | hand A fist / three-finger pose |
| `J` / `L`, `-` / `=` | roll / close-open hand B |
| hold `V` / hold `G` | hand B fist / three-finger pose |
| `M` | mute |

## Quality tiers

| tier | DPR clamp | bloom scale/mips | sparks | shatter cells | sigil-B layers | floor reflection |
|---|---|---|---|---|---|---|
| high | 1.5 | 1.0× / 5 | 140 | 10×3 | 100% | on |
| mid | 1.15 | 0.75× / 4 | 80 | 8×2 | 85% | on |
| low | 0.9 | 0.5× / 3 | 36 | 6×2 | 60% | off |

The governor drops a tier after 2 s below 50 fps and climbs back after 8 s at 56+. Desktop starts
at `high`, touch devices at `mid`. Measured on this project's dev machine (headless Chromium, real
GPU via ANGLE/D3D11) with the camera running and detection in the worker: rendering holds a flat
60 fps at `high`. That machine's GPU class wasn't verified as integrated, so treat "60 fps on an
integrated GPU" as the governor's job to guarantee rather than a measured claim — `?perf=1` shows
exactly where a given machine lands.

## Performance notes

`tests/perf.spec.js` checks three things: a 600-frame two-hand run leaves the retained heap flat
(< 256 KB after a full GC); our own frame loop allocates no objects, closures or iterators per
frame; and 50 rounds of hands appearing and leaving don't grow GPU resource counts. Two residual
sources of short-lived garbage are outside this project's control: three.js's renderer internals
(~6 KB/frame, mostly uniform uploads and render-list sorting) and V8 boxing doubles into 12-byte
heap numbers when passing them to calls it didn't inline (~0.6 KB/frame across both sigils). Both
die young and are collected by the cheap nursery GC.

## Troubleshooting

- **Nothing happens when I show my hand** — the "Show your hand to the camera" hint means no hand
  is being detected: check lighting, keep the whole hand in frame, and try `?debug=1` to see what
  the tracker reports.
- **"This browser cannot access a camera"** — use `localhost` or HTTPS.
- **Camera denied / not found / lost** — an idle sigil shows and a **Retry camera** button appears.
- **Stuck on "Loading hand tracker…" / "The hand tracker didn't load"** — the tracker (`vendor/mediapipe/*` wasm and `vendor/models/hand_landmarker.task`, ~30 MB) has 15 s to load. If it doesn't, the start screen names the URL that is wrong (HTTP status, wrong MIME type, or a truncated/HTML-error body) and logs it to the console as `[sigil] failing URL: …`, with a Retry button. On a host, check that `/vendor/models/hand_landmarker.task` returns the full ~7.8 MB as `application/octet-stream` and the `.wasm` files return `application/wasm`. The service worker never caches or answers `vendor/` requests.
- **WebGL2 unsupported** — the start screen says so; use a recent Chrome, Edge, Firefox or Safari.
- **Low frame rate** — `?perf=1` shows render/detection fps; `?quality=low` isolates GPU cost.
- **No sound** — audio unlocks on the "Enable camera" click; check `?mute=1` isn't set.
- **Size range feels off** — give it a few seconds of opening and closing (it adapts), or reset
  with `?recalibrate=1`.

## Architecture

```
src/
  input/   tracker.js       camera + frame pacing; posts frames to the worker, drops stale ones
           detectWorker.js  MediaPipe HandLandmarker in a Web Worker
           controller.js    two identity-stable hand slots (nearest-wrist matching), One-Euro
                            filtering, aspect-corrected classification, the split-pose gate
           gestures.js      pose classifier (OPEN 4-of-5, FIST, THREE, …), openness
           oneEuro.js       the adaptive low-pass
           stateMachine.js  DORMANT → CASTING → ACTIVE → DISMISSING, driven by presence
           mapper.js        one hand → one sigil's intents (presence, size, split)
           synth.js         synthetic hands for tests and the dev harness
  bus/     bus.js           the only channel visuals listen on; withTag() routes a mapper's intents to its sigil
  calib/   calibrate.js     silent rolling-window adaptation + persistence
  sigil/   shaders.js, glyphs.js, layer.js, component.js, sigil.js (the public Sigil API)
  stage/   scene.js, bloom.js, floor.js, sparks.js
           background.js    void quad, or the AR composite pass (camera + sigil + exposure/halo/spill)
           cover.js         the one cover-fit transform (video <-> screen)
           videoFeed.js     "a new camera frame arrived" -> one texture upload
           occlusion.js     finger-silhouette mask (convex hulls), ?occlusion=1
  audio/   engine.js        synthesized WebAudio (no sample files)
  perf/    governor.js, overlay.js
  hud/     hud.js           ?debug=1 only
  record/  record.js        ?record=1 only
  app.js   boot, render loop, one SigilSession per hand slot, palm → world mapping, dev harness
```

**Data flow.** Camera frame → worker detection → `Controller.onHands()` updates each slot's
filtered targets (detection rate). Render loop (display rate): each `SigilSession` runs its
mapper inside `bus.withTag(id)` (presence → `summon`/`dismiss`, openness → `resize`, split pose →
`explode`), applies the palm/roll follow rule, then the sigil eases toward its targets. Nothing past
the mapper reads a landmark. The renderer methods for other effects (`solo`, `shatter`,
`dissolve`, `reassemble`, `setSpinMul`, `setTilt`, …) remain available on the `Sigil` API and bus;
no gesture triggers them in this build.

## Tests

```
npm test
```

Playwright drives the real app in Chromium (real GPU) with deterministic synthetic hands:

- `gestures.spec.js` — hand appears → cast (on the palm); hand lost → uncast after the grace period
  (a shorter dropout survives); openness drives size monotonically and a fist gives `smol`; roll
  drives rotation one to one; three-finger pose → split, hold keeps it, release regroups; jittered
  landmarks never flicker the split; `?nocam=1` idle display
- `twoHand.spec.js` — two hands → two independent sigils (own palm, own size, own split); losing
  either hand removes only its sigil; identity survives the tracker reporting hands in either order
- `calib.spec.js` — no setup step; auto-adaptation spans the full size range for a half-range hand;
  persistence and `?recalibrate=1`; scale invariance
- `logic.spec.js` — pose classification at any rotation (including THREE and 4-of-5 OPEN), the
  16:9 regression, controller palm/roll/slot tracking
- `ar.spec.js` — AR: a video pixel and the palm at that pixel land on the same screen pixel across window aspect ratios; the sigil projects onto the palm; boot with the fake camera shows the live picture (not black) with no HUD; `?bg=void` override; floor hidden, embers on the sigil, sigil size follows hand size; motion prediction; occlusion mask
- `perf.spec.js` — retained heap, per-frame allocation, GPU resource stability
- `e2e.spec.js` — the whole lifecycle in one run, no console errors, no GPU growth
- `bus.spec.js`, `sigil.spec.js`, `boot.spec.js`, `audio.spec.js` — renderer, bus, boot, sound

CI (`.github/workflows/ci.yml`) runs the suite and a build on every push and pull request.

## Credits

- Hand tracking: [MediaPipe Tasks — HandLandmarker](https://developers.google.com/mediapipe)
- Rendering: [Three.js](https://threejs.org)
- Hand-tracking plumbing (camera wrapper, pose-classification approach, synthetic-hand test
  fixtures, the Controller pattern) adapted from
  [WonderSnap](https://github.com/AkbarSheikh-debug/wondersnap), used under its MIT license;
  everything visual, audible and gesture-logical here is new.

## License

MIT

// A tiny pub/sub. Every visual reaction in the sigil goes through this — shader code and stage
// code never read hand landmarks directly, they only ever hear intents.
//
// Listener lists are copy-on-write arrays: emit() runs several times a frame and walks them with
// an index (no iterator allocation), while on()/off() — rare — replace the array, so a listener
// added or removed mid-dispatch never disturbs the loop already running.
const chans = new Map();

export function on(name, fn) {
  chans.set(name, [...(chans.get(name) || []), fn]);
  return () => off(name, fn);
}

function off(name, fn) {
  const list = chans.get(name);
  if (list) chans.set(name, list.filter((f) => f !== fn));
}

export function emit(name, payload) {
  if (_tag && payload && typeof payload === 'object' && payload.sigil === undefined) payload.sigil = _tag;
  const list = chans.get(name);
  if (!list) return;
  for (let i = 0; i < list.length; i++) list[i](payload);
}

// Phase 3: two sigils share this one bus, but GestureMapper (unchanged) has no idea which sigil
// it's driving — it just calls emit(). withTag() lets a caller stamp every intent emitted during a
// synchronous call (e.g. one GestureMapper.update()) with which sigil it came from, without that
// module ever knowing tagging exists. Untagged payloads are unaffected — every Phase 1/2 listener
// that never checks payload.sigil keeps seeing exactly what it always did.
let _tag = null;
export function withTag(tag, fn) {
  const prev = _tag; _tag = tag;
  try { return fn(); } finally { _tag = prev; }
}

// The full set of intents Phase 1 wires up (handState + the temporary follow rule) and the names
// Phase 2's gesture mapping will start emitting into. Declaring them all now means the bus, the
// HUD and any listener code can be written against a stable vocabulary from day one.
// Phase 3 adds one: 'clap' (both hands closing fast — a pulse plus, with two sigils, a merge).
export const INTENTS = Object.freeze([
  'summon', 'dismiss', 'spin', 'scale', 'resize', 'move', 'tilt', 'pulse', 'explode', 'solo', 'regroup',
  'handState', 'clap',
]);

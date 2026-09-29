// A tiny pub/sub. Every visual reaction in the sigil goes through this — shader code and stage
// code never read hand landmarks directly, they only ever hear intents.
const chans = new Map();

export function on(name, fn) {
  let set = chans.get(name);
  if (!set) { set = new Set(); chans.set(name, set); }
  set.add(fn);
  return () => off(name, fn);
}

export function off(name, fn) {
  chans.get(name)?.delete(fn);
}

export function emit(name, payload) {
  const set = chans.get(name);
  if (!set) return;
  for (const fn of set) fn(payload);
}

// The full set of intents Phase 1 wires up (handState + the temporary follow rule) and the names
// Phase 2's gesture mapping will start emitting into. Declaring them all now means the bus, the
// HUD and any listener code can be written against a stable vocabulary from day one.
export const INTENTS = Object.freeze([
  'summon', 'dismiss', 'spin', 'scale', 'resize', 'move', 'tilt', 'pulse', 'explode', 'solo', 'regroup',
  'handState',
]);

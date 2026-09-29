// Deterministic RNG (mulberry32) so every model builds to exactly the same point cloud each run.
export function makeRng(seed = 0) {
  let a = (seed * 2654435761 + 0x9e3779b9) >>> 0;
  const random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { random };
}

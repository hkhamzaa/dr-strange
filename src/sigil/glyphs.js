// Bakes a single 8x8 atlas of procedural rune glyphs onto an offscreen canvas at startup, seeded
// so the atlas is identical every run for a given config seed. Each cell is a small deterministic
// scribble of strokes, arcs, dots and hooks — no glyph is drawn twice the same way, but none of it
// resembles a real alphabet. The atlas stores crisp coverage in the R channel and a pre-blurred
// glow in G, so the rune-band shader never has to blur anything itself.
import { makeRng } from '../lib/rng.js';

const COLS = 8, ROWS = 8, CELL = 64;
const SIZE = COLS * CELL;

function strokeCell(ctx, rng, cx, cy, cell) {
  const n = 1 + Math.floor(rng.random() * 4);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = '#fff';
  ctx.fillStyle = '#fff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const pad = cell * 0.16, span = cell - pad * 2;
  const pt = () => [pad + rng.random() * span, pad + rng.random() * span];
  for (let i = 0; i < n; i++) {
    const kind = Math.floor(rng.random() * 4);
    ctx.lineWidth = cell * (0.06 + rng.random() * 0.05);
    if (kind === 0) {                                       // straight stroke
      const [ax, ay] = pt(), [bx, by] = pt();
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    } else if (kind === 1) {                                 // arc
      const [ax, ay] = pt();
      const r = cell * (0.14 + rng.random() * 0.16);
      const a0 = rng.random() * Math.PI * 2, a1 = a0 + (0.6 + rng.random() * 1.6) * (rng.random() < 0.5 ? -1 : 1);
      ctx.beginPath(); ctx.arc(ax, ay, r, a0, a1); ctx.stroke();
    } else if (kind === 2) {                                 // dot
      const [ax, ay] = pt();
      ctx.beginPath(); ctx.arc(ax, ay, cell * (0.035 + rng.random() * 0.03), 0, Math.PI * 2); ctx.fill();
    } else {                                                  // hook: short quadratic curve
      const [ax, ay] = pt(), [bx, by] = pt(), [cx2, cy2] = pt();
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(cx2, cy2, bx, by); ctx.stroke();
    }
  }
  ctx.restore();
}

/** Builds the crisp + glow canvases and returns a THREE.DataTexture (R = crisp, G = glow). */
export function buildRuneAtlas(THREE, seed = 0) {
  const rng = makeRng(seed * 7919 + 11);
  const crisp = document.createElement('canvas');
  crisp.width = crisp.height = SIZE;
  const cctx = crisp.getContext('2d');
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) strokeCell(cctx, rng, col * CELL, row * CELL, CELL);
  }
  const glow = document.createElement('canvas');
  glow.width = glow.height = SIZE;
  const gctx = glow.getContext('2d');
  gctx.filter = `blur(${(CELL * 0.14).toFixed(1)}px)`;
  gctx.drawImage(crisp, 0, 0);

  const crispData = cctx.getImageData(0, 0, SIZE, SIZE).data;
  const glowData = gctx.getImageData(0, 0, SIZE, SIZE).data;
  const out = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    out[i * 4 + 0] = crispData[i * 4 + 3];    // crisp coverage from alpha
    out[i * 4 + 1] = glowData[i * 4 + 3];     // pre-blurred glow coverage
    out[i * 4 + 2] = 0;
    out[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(out, SIZE, SIZE, THREE.RGBAFormat);
  tex.flipY = true;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

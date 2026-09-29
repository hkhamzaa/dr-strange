// Soft finger-silhouette mask for occlusion: the sigil is drawn slightly behind the fingers.
//
// Each finger's joints (knuckle -> tip) go through a convex hull, which is inflated to finger
// width and feathered on a small 2D canvas, all in mirrored-image space — the composite shader
// samples it with the same cover transform as the video. The PALM is deliberately not part of the
// mask: the sigil sits on the palm, so masking the whole hand would erase it. Redrawn once per
// detection (~30 Hz) on a 256-px canvas, uploaded only when it changed; off by default in config.
import { CFG } from '../config.js';

const FINGERS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Andrew's monotone chain. Points are [x, y]; returns the hull in order (no repeated endpoint). */
export function convexHull(points) {
  const p = points.map((q) => [q[0], q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const lower = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

export function makeHandMask(THREE) {
  const oc = CFG.ar.occlusion;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  let aspect = 0, cleared = false;

  function size(a) {
    if (Math.abs(a - aspect) < 1e-3) return;
    aspect = a;
    canvas.width = oc.size; canvas.height = Math.max(8, Math.round(oc.size / a));
    cleared = false;
  }

  const hullPts = [[0, 0], [0, 0], [0, 0], [0, 0]];
  return {
    texture,
    /** hands: [{ lm, scale }] — lm = 21 mirrored [x, y] image points, scale = hand scale in image-height units. */
    update(hands, videoAspect) {
      size(videoAspect);
      if (!hands.length && cleared) return;
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      cleared = !hands.length;
      ctx.fillStyle = ctx.strokeStyle = '#fff';
      ctx.shadowColor = '#fff'; ctx.shadowBlur = oc.feather * H;
      ctx.lineJoin = 'round';
      for (const { lm, scale } of hands) {
        ctx.lineWidth = Math.max(2, oc.fingerWidth * scale * H);
        for (const f of FINGERS) {
          for (let k = 0; k < 4; k++) { hullPts[k][0] = lm[f[k]][0] * W; hullPts[k][1] = lm[f[k]][1] * H; }
          const hull = convexHull(hullPts);
          ctx.beginPath();
          ctx.moveTo(hull[0][0], hull[0][1]);
          for (let k = 1; k < hull.length; k++) ctx.lineTo(hull[k][0], hull[k][1]);
          ctx.closePath();
          ctx.fill(); ctx.stroke();
        }
      }
      texture.needsUpdate = true;
    },
    dispose() { texture.dispose(); },
  };
}

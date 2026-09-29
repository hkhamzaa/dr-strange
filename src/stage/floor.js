// A dark floor plane carrying a baked soft glow puddle plus a faint downward-fading reflection
// glow, both painted into one canvas texture at startup — no per-frame cost, no allocations.
import { CFG } from '../config.js';

function puddleTexture(THREE) {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const [cr, cg, cb] = CFG.color.mid.map((v) => Math.round(v * 255));
  const cx = size / 2, cy = size * 0.42;
  const puddle = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.42);
  puddle.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, 0.55)`);
  puddle.addColorStop(0.5, `rgba(${cr}, ${cg}, ${cb}, 0.16)`);
  puddle.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = puddle;
  ctx.fillRect(0, 0, size, size);
  const reflect = ctx.createLinearGradient(0, cy, 0, size);
  reflect.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, 0.22)`);
  reflect.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = reflect;
  ctx.fillRect(0, cy, size, size - cy);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function makeFloor(THREE) {
  const geo = new THREE.PlaneGeometry(CFG.floor.puddleRadius * 2.4, CFG.floor.puddleRadius * 2.4);
  const mat = new THREE.MeshBasicMaterial({
    map: puddleTexture(THREE), transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, opacity: CFG.floor.reflectionOpacity + 0.5,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = CFG.floor.y;
  return mesh;
}

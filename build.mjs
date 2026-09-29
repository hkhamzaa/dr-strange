// Zero-bundler production build. Copies src/ into dist/ with content-hashed filenames (so a CDN
// can cache them forever) and rewrites the relative import specifiers between them to match.
// Vendor code (three, MediaPipe) and large binary assets (wasm, the hand model) are copied
// byte-for-byte into dist/vendor/ (NOT node_modules/: some hosts strip folders with that name from
// static output). The importmap in index.html and tracker.js point at vendor/, and server.mjs serves
// the same URLs from node_modules in dev. Their own version pin is the cache key.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rm, cp, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

async function walk(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

function hash8(buf) { return createHash('sha256').update(buf).digest('hex').slice(0, 8); }

function hashedName(relPath, buf) {
  const dir = path.posix.dirname(relPath);
  const ext = path.posix.extname(relPath);
  const base = path.posix.basename(relPath, ext);
  const hashed = `${base}.${hash8(buf)}${ext}`;
  return dir === '.' ? hashed : `${dir}/${hashed}`;
}

async function buildSrc() {
  const files = await walk(SRC);
  const rel = files.map((f) => path.relative(SRC, f).split(path.sep).join('/'));
  const raw = new Map();
  await Promise.all(rel.map(async (r, i) => raw.set(r, await readFile(files[i]))));

  // Hash names are derived from ORIGINAL content — good enough for cache-busting on every source
  // edit without needing a fixed-point rewrite pass to hash the post-rewrite bytes exactly.
  const nameMap = new Map();
  for (const r of rel) nameMap.set(r, hashedName(r, raw.get(r)));

  // static imports, plus `new URL('./x.js', import.meta.url)` (how the detection worker is loaded)
  const IMPORT_RE = /(from\s+|import\s+|new URL\(\s*)(['"])(\.\.?\/[^'"]+)\2/g;
  for (const r of rel) {
    const dir = path.posix.dirname(r);
    let text = raw.get(r).toString('utf8');
    text = text.replace(IMPORT_RE, (m, kw, q, spec) => {
      const targetRel = path.posix.normalize(path.posix.join(dir, spec));
      if (targetRel.startsWith('../')) return m;          // outside src/: path is kept as-is
      const hashed = nameMap.get(targetRel);
      if (!hashed) throw new Error(`build: unresolved import '${spec}' in src/${r}`);
      return `${kw}${q}${relSpec(dir, hashed)}${q}`;
    });
    const outPath = path.join(DIST, 'src', ...nameMap.get(r).split('/'));
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, text, 'utf8');
  }
  return nameMap.get('app.js');
}

function relSpec(fromDir, targetRel) {
  let r = path.posix.relative(fromDir, targetRel);
  if (!r.startsWith('.')) r = `./${r}`;
  return r;
}

async function buildStyles() {
  const buf = await readFile(path.join(ROOT, 'styles.css'));
  const hashed = hashedName('styles.css', buf);
  await writeFile(path.join(DIST, hashed), buf);
  return hashed;
}

// [where it lives in the repo, where it goes under dist/vendor/]
const VENDOR = [
  ['node_modules/three/build/three.module.js', 'three/build/three.module.js'],
  ...['postprocessing/EffectComposer', 'postprocessing/RenderPass', 'postprocessing/UnrealBloomPass', 'postprocessing/OutputPass',
    'postprocessing/ShaderPass', 'postprocessing/MaskPass', 'postprocessing/Pass', 'shaders/CopyShader',
    'shaders/LuminosityHighPassShader', 'shaders/OutputShader'].map((f) => [`node_modules/three/examples/jsm/${f}.js`, `three/examples/jsm/${f}.js`]),
  ['node_modules/@mediapipe/tasks-vision/vision_bundle.mjs', 'mediapipe/vision_bundle.mjs'],
  // The wasm loader picks between simd/nosimd/plain variants at runtime, and between .js/.wasm
  // pairs, so the whole wasm/ folder travels rather than hand-picking files.
  ['node_modules/@mediapipe/tasks-vision/wasm', 'mediapipe/wasm'],
  ['models/hand_landmarker.task', 'models/hand_landmarker.task'],
];

async function copyVendor() {
  for (const [src, dest] of VENDOR) {
    const from = path.join(ROOT, src), to = path.join(DIST, 'vendor', dest);
    await stat(from).catch(() => { throw new Error(`build: missing ${src} (did \`npm install\` run?)`); });
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to, { recursive: true });
  }
}

async function buildHtml(appEntry, cssEntry) {
  let html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
  html = html.replace('href="styles.css"', `href="${cssEntry}"`);
  html = html.replace('src="src/app.js"', `src="src/${appEntry}"`);
  await writeFile(path.join(DIST, 'index.html'), html, 'utf8');
}

async function copyIfExists(name) {
  try {
    await stat(path.join(ROOT, name));
    await cp(path.join(ROOT, name), path.join(DIST, name), { recursive: true });
    return true;
  } catch { return false; }
}

async function main() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  const appEntry = await buildSrc();
  const cssEntry = await buildStyles();
  await copyVendor();
  await buildHtml(appEntry, cssEntry);
  // vercel.json is read from the repo root by Vercel itself before the build runs, so it stays
  // out of dist/ — only assets the deployed site needs to actually serve go here.
  for (const extra of ['manifest.json', 'sw.js', 'icons', '_headers']) {
    await copyIfExists(extra);
  }

  console.log(`dist/ built — entry src/${appEntry}, styles ${cssEntry}`);
  await listDist();
}

/** Print everything in dist/ (so a host's build log shows exactly what it will serve) and fail the
 *  build if the site can't possibly load. */
async function listDist() {
  const files = (await walk(DIST)).map((f) => path.relative(DIST, f).split(path.sep).join('/')).sort();
  const sizes = await Promise.all(files.map(async (f) => (await stat(path.join(DIST, f))).size));
  console.log(`\ndist/ listing (${files.length} files):`);
  files.forEach((f, i) => console.log(`  ${String(sizes[i]).padStart(9)}  ${f}`));
  const need = ['index.html', 'vendor/three/build/three.module.js', 'vendor/mediapipe/vision_bundle.mjs', 'vendor/models/hand_landmarker.task'];
  const missing = need.filter((f) => !files.includes(f));
  if (missing.length) {
    console.error(`\nbuild FAILED: dist/ is missing ${missing.join(', ')}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

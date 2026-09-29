// Zero-bundler production build. Copies src/ into dist/ with content-hashed filenames (so a CDN
// can cache them forever) and rewrites the relative import specifiers between them to match.
// Vendor code (three, MediaPipe) and large binary assets (wasm, the hand model) are copied
// byte-for-byte at their existing node_modules-relative paths, since tracker.js and the importmap
// in index.html already point there — nothing to rewrite, and their own version pin is the cache key.
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
      if (targetRel.startsWith('../')) return m;          // outside src/ (vendored node_modules): path is kept as-is
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

async function copyVendor() {
  const files = [
    'node_modules/three/build/three.module.js',
    'node_modules/three/examples/jsm/postprocessing/EffectComposer.js',
    'node_modules/three/examples/jsm/postprocessing/RenderPass.js',
    'node_modules/three/examples/jsm/postprocessing/UnrealBloomPass.js',
    'node_modules/three/examples/jsm/postprocessing/OutputPass.js',
    'node_modules/three/examples/jsm/postprocessing/ShaderPass.js',
    'node_modules/three/examples/jsm/postprocessing/MaskPass.js',
    'node_modules/three/examples/jsm/postprocessing/Pass.js',
    'node_modules/three/examples/jsm/shaders/CopyShader.js',
    'node_modules/three/examples/jsm/shaders/LuminosityHighPassShader.js',
    'node_modules/three/examples/jsm/shaders/OutputShader.js',
    'node_modules/@mediapipe/tasks-vision/vision_bundle.mjs',
    'models/hand_landmarker.task',
  ];
  for (const src of files) {
    const from = path.join(ROOT, src);
    const to = path.join(DIST, src);
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to);
  }
  // The wasm loader picks between simd/nosimd/plain variants at runtime, and between .js/.wasm
  // pairs, so the whole wasm/ folder travels rather than hand-picking files.
  const wasmDir = path.join(ROOT, 'node_modules/@mediapipe/tasks-vision/wasm');
  const wasmOut = path.join(DIST, 'node_modules/@mediapipe/tasks-vision/wasm');
  await mkdir(wasmOut, { recursive: true });
  await cp(wasmDir, wasmOut, { recursive: true });
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
  // Deploy config lives at the repo root (or in the CI workflow), so it stays
  // out of dist/ — only assets the deployed site needs to actually serve go here.
  for (const extra of ['manifest.json', 'sw.js', 'icons', '_headers']) {
    await copyIfExists(extra);
  }

  console.log(`dist/ built — entry src/${appEntry}, styles ${cssEntry}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

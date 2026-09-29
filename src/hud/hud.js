// Debug overlay, only ever created when ?debug=1 is on the URL. Draws the hand skeleton on its own
// canvas, and a small glass panel with a pose chip, fps/detect-ms, the last few intents and each
// component's live state. Reads only what app.js hands it each frame — never touches the bus or
// the controller directly, so it can't become a second source of truth.
import { CFG } from '../config.js';

const HAND_EDGES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];

export class Hud {
  constructor() {
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: 50 });
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.panel = document.createElement('div');
    Object.assign(this.panel.style, {
      position: 'fixed', top: '12px', left: '12px', zIndex: 51, font: '12px/1.5 ui-monospace, monospace',
      color: '#ffe3b0', background: 'rgba(10, 6, 2, 0.72)', border: '1px solid rgba(255, 170, 60, 0.35)',
      borderRadius: '8px', padding: '10px 12px', whiteSpace: 'pre', pointerEvents: 'none', maxWidth: '46vw',
    });
    document.body.appendChild(this.panel);

    this.intents = [];
    this._resize();
    addEventListener('resize', () => this._resize());
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, CFG.dpr.clamp);
    this.canvas.width = innerWidth * dpr;
    this.canvas.height = innerHeight * dpr;
    this.dpr = dpr;
  }

  logIntent(name, payload) {
    // a continuous gesture (charging pulse, live resize…) fires every frame; refresh the head entry
    // instead of spamming the log with duplicates of the same name back to back.
    if (this.intents[0]?.name === name) { this.intents[0].brief = brief(payload); this.intents[0].t = performance.now(); return; }
    this.intents.unshift({ name, t: performance.now(), brief: brief(payload) });
    this.intents.length = Math.min(this.intents.length, CFG.hud.intentLogLen);
  }

  update({ ctl, fps, detectMs, camDelegate, sigilStatus, anchorMode, bgMode, gesture }) {
    const g = this.ctx, dpr = this.dpr;
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (ctl.landmarks) {
      const P = ctl.landmarks.map(([x, y]) => [x * innerWidth * dpr, y * innerHeight * dpr]);
      g.strokeStyle = '#ffb238'; g.lineWidth = 2 * dpr; g.globalAlpha = 0.85;
      g.beginPath();
      for (const [a, b] of HAND_EDGES) { g.moveTo(P[a][0], P[a][1]); g.lineTo(P[b][0], P[b][1]); }
      g.stroke();
      g.fillStyle = '#fff'; g.globalAlpha = 0.9;
      for (const p of P) { g.beginPath(); g.arc(p[0], p[1], 2.6 * dpr, 0, Math.PI * 2); g.fill(); }
      g.globalAlpha = 1;
    }

    const compLines = Object.entries(sigilStatus.components)
      .map(([id, s]) => `  ${id.padEnd(10)} reveal ${s.reveal.toFixed(2)}  intensity ${s.intensity.toFixed(2)}  scale ${s.scale.toFixed(2)}${s.soloed ? '  [solo]' : ''}`)
      .join('\n');
    const intentLines = this.intents.map((e) => `  ${e.name}${e.brief ? ' ' + e.brief : ''}`).join('\n') || '  (none yet)';

    const chip = gesture ? `${gesture.state}  gesture: ${gesture.label}${bar(gesture.progress)}` : '-';
    const gateLines = gesture
      ? Object.entries(gesture.gates).map(([k, v]) => `  ${k.padEnd(10)} ${v}`).join('\n')
      : '  -';
    const raw = gesture?.raw;
    const rawLine = raw
      ? `  openness ${raw.openness}  pinchRatio ${raw.pinchRatio}  handScale ${raw.handScale}  snapRatio ${raw.snapRatio}`
      : '  (no hand)';

    this.panel.textContent =
      `${chip}\n` +
      `pose: ${ctl.pose}  raw: ${ctl.rawPose}  pinch: ${ctl.pinch}\n` +
      `fps: ${fps.toFixed(0)}  detect: ${detectMs.toFixed(1)}ms  delegate: ${camDelegate || '-'}\n` +
      `anchor: ${anchorMode}  bg: ${bgMode}  exploded: ${sigilStatus.exploded}  solo: ${sigilStatus.solo || '-'}\n` +
      `calibration:\n${rawLine}\n` +
      `gesture states:\n${gateLines}\n` +
      `intents:\n${intentLines}\n` +
      `components:\n${compLines}`;
  }
}

function bar(progress, width = 10) {
  if (!progress) return '';
  const filled = Math.round(clamp01(progress) * width);
  return `  [${'#'.repeat(filled)}${'.'.repeat(width - filled)}]`;
}
const clamp01 = (x) => Math.min(1, Math.max(0, x));

function brief(payload) {
  if (payload == null) return '';
  if (typeof payload === 'object') {
    const parts = Object.entries(payload).slice(0, 3).map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(2) : v}`);
    return `{${parts.join(' ')}}`;
  }
  return String(payload);
}

// ?record=1 only: a small capture control on the debug HUD that records the canvas (plus the
// synthesized audio, if unlocked and unmuted) to a WebM via MediaRecorder — for demos, never on
// in normal use.
export class RecordControl {
  constructor(canvas, audioEngine) {
    this.canvas = canvas;
    this.audio = audioEngine;
    this.recorder = null;
    this.chunks = [];
    this.on = false;

    this.button = document.createElement('button');
    this.button.textContent = '● record';
    Object.assign(this.button.style, {
      position: 'fixed', top: '12px', right: '12px', zIndex: 53, font: '12px ui-monospace, monospace',
      color: '#fff', background: 'rgba(180, 20, 20, 0.85)', border: '1px solid rgba(255,255,255,0.3)',
      borderRadius: '6px', padding: '6px 10px', cursor: 'pointer',
    });
    this.button.onclick = () => this.toggle();
    document.body.appendChild(this.button);
  }

  toggle() { this.on ? this.stop() : this.start(); }

  start() {
    if (this.on || typeof MediaRecorder === 'undefined') return;
    const stream = this.canvas.captureStream(30);
    if (this.audio?.ctx && this.audio.master) {
      const dest = this.audio.ctx.createMediaStreamDestination();
      this.audio.master.connect(dest);
      this._audioDest = dest;
      for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
    }
    this.chunks = [];
    this.recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    this.recorder.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.recorder.onstop = () => this._save();
    this.recorder.start();
    this.on = true;
    this.button.textContent = '■ stop';
    this.button.style.background = 'rgba(20, 180, 60, 0.9)';
  }

  stop() {
    if (!this.on) return;
    this.recorder.stop();
    if (this._audioDest) { this.audio.master.disconnect(this._audioDest); this._audioDest = null; }
    this.on = false;
    this.button.textContent = '● record';
    this.button.style.background = 'rgba(180, 20, 20, 0.85)';
  }

  _save() {
    const blob = new Blob(this.chunks, { type: 'video/webm' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `sigil-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.webm`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  dispose() { this.stop(); this.button.remove(); }
}

// Tells the render loop when the camera has produced a NEW frame, so the video texture is uploaded
// once per camera frame (~30/s) rather than once per display frame, and never while paused.
// Independent of detection: the picture is live while the hand tracker is still loading.
//
// requestVideoFrameCallback fires per presented frame; a hidden <video> may not be presented, so if
// it goes quiet (or doesn't exist) fall back to watching currentTime, same as the tracker's pump.
export class VideoFeed {
  constructor(video) {
    this.video = video;
    this.dirty = false;
    this._armed = false;
    this._lastTime = -1;
    this._lastCbAt = -1e9;
    this.active = false;
  }

  start() {
    this.active = true;
    this._lastTime = -1;
    this._arm();
  }

  stop() { this.active = false; this.dirty = false; }

  _arm() {
    if (this._armed || !this.active || !this.video.requestVideoFrameCallback) return;
    this._armed = true;
    this.video.requestVideoFrameCallback((now, meta) => {
      this._armed = false;
      this._lastCbAt = performance.now();
      this._lastTime = meta.mediaTime;
      this.dirty = true;
      this._arm();
    });
  }

  /** True once per new camera frame. O(1). */
  consume(nowMs) {
    if (!this.active) return false;
    if (!this.dirty && nowMs - this._lastCbAt > 250 && this.video.readyState >= 2 && this.video.currentTime !== this._lastTime) {
      this._lastTime = this.video.currentTime;    // callback gone quiet: poll
      this.dirty = true;
    }
    if (!this.dirty) return false;
    this.dirty = false;
    return true;
  }
}

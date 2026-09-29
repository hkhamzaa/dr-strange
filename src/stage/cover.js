// The one "background-size: cover" transform, shared by everything that has to agree about where a
// video pixel lands on screen: the AR composite shader (same maths, in GLSL), the palm -> world
// mapping that pins the sigil to the hand, the light spill, and the tests.
//
// Coordinates: x, y are normalized image coords of the MIRRORED (selfie) feed, y down, 0..1.
// Output is normalized screen coords, y down, 0..1.

/** Displayed image height, in screen heights: 1 when the video is fitted by height (screen narrower
 *  than the video), >1 when it is fitted by width and the top/bottom are cropped. */
export function coverScale(screenAspect, videoAspect) { return Math.max(1, screenAspect / videoAspect); }

export function videoToScreen(x, y, screenAspect, videoAspect, out = [0, 0]) {
  let sx = x - 0.5, sy = y - 0.5;
  if (screenAspect > videoAspect) sy *= screenAspect / videoAspect; else sx *= videoAspect / screenAspect;
  out[0] = sx + 0.5; out[1] = sy + 0.5;
  return out;
}

/** Inverse: which mirrored-image point is displayed at this screen point. */
export function screenToVideo(u, v, screenAspect, videoAspect, out = [0, 0]) {
  let sx = u - 0.5, sy = v - 0.5;
  if (screenAspect > videoAspect) sy *= videoAspect / screenAspect; else sx *= screenAspect / videoAspect;
  out[0] = sx + 0.5; out[1] = sy + 0.5;
  return out;
}

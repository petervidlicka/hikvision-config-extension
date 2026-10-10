/**
 * Shapes the config tools draw on the picture (motion polygons, privacy
 * rectangles), kept as fractions of the picture's width and height: 0–1,
 * Y=0 at the top.
 *
 * The drawing canvas takes each frame's pixels as its size, and frames
 * differ: a 704×576 live still, a 1920×1088 HD still, a 1280×720 stored
 * picture from Playback, or none yet (300×150). A shape kept in canvas pixels
 * would move, or be saved scaled wrong, when the frame under it changes size
 * between loading, drawing and saving. As fractions it stays on the same
 * part of the picture. Pixels come in only to draw a shape and to measure
 * what the user aims at in pixels (closing a polygon, a double-click's
 * repeated corner, a rectangle too small to keep); device units are
 * lib/config-xml.js's business.
 *
 * Pure; no imports.
 */

/** @typedef {import('./config-xml.js').Size} Size */

/**
 * A point on the picture as fractions of its width and height, Y=0 at the top.
 * @typedef {{x: number, y: number}} ImagePoint
 */

/**
 * A rectangle on the picture in the same fractions: its top-left corner,
 * width and height.
 * @typedef {{x: number, y: number, w: number, h: number}} ImageRect
 */

/**
 * A point in pixels of a canvas, Y=0 at the top.
 * @typedef {{x: number, y: number}} PixelPoint
 */

/**
 * A rectangle in pixels of a canvas.
 * @typedef {{x: number, y: number, w: number, h: number}} PixelRect
 */

/**
 * Where a point on the picture is on a canvas of the given size, to draw it.
 * @param {ImagePoint} point
 * @param {Size} size - the canvas's width and height in pixels
 * @returns {PixelPoint}
 * @example
 * toPixels({x: 0.5, y: 0.25}, {width: 704, height: 576}) // → {x: 352, y: 144}
 */
export function toPixels(point, size) {
  return { x: point.x * size.width, y: point.y * size.height };
}

/**
 * Where a rectangle on the picture is on a canvas of the given size.
 * @param {ImageRect} rect
 * @param {Size} size - the canvas's width and height in pixels
 * @returns {PixelRect}
 */
export function rectToPixels(rect, size) {
  return { x: rect.x * size.width, y: rect.y * size.height, w: rect.w * size.width, h: rect.h * size.height };
}

/**
 * How far apart two points on the picture are on a canvas of the given size,
 * for checks the user aims at in pixels, such as clicking near a corner.
 * @param {ImagePoint} a
 * @param {ImagePoint} b
 * @param {Size} size - the canvas's width and height in pixels
 * @returns {number} pixels
 */
export function pixelDistance(a, b, size) {
  return Math.hypot((a.x - b.x) * size.width, (a.y - b.y) * size.height);
}

/**
 * The rectangle a drag spans, whichever way it went.
 * @param {ImagePoint} a - where the drag started
 * @param {ImagePoint} b - where it is now, or ended
 * @returns {ImageRect}
 */
export function rectFromCorners(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/**
 * Whether a point is in a rectangle, edges included.
 * @param {ImageRect} rect
 * @param {ImagePoint} point
 * @returns {boolean}
 */
export function rectContains(rect, point) {
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;
}

/**
 * Whether a point is inside a polygon (ray casting). Stretching both by the
 * same factors doesn't change the answer, so fractions of the picture work
 * as well as pixels.
 * @param {ImagePoint} point
 * @param {ImagePoint[]} polygon - its corners in order
 * @returns {boolean}
 */
export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const { x: xi, y: yi } = polygon[i];
    const { x: xj, y: yj } = polygon[j];
    if ((yi > point.y) !== (yj > point.y) && point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Shapes the config tools draw on the picture (motion polygons, privacy
 * rectangles), kept as fractions of the picture's width and height: 0–1,
 * Y=0 at the top.
 *
 * The drawing canvas takes the picture's displayed size as its pixels,
 * which changes with the frame (a 704×576 live still shown at 16:9, a
 * 1920×1088 HD still, a 1280×720 stored picture from Playback, or none yet:
 * 300×150) and with the window. A shape kept in canvas pixels would move, or
 * be saved scaled wrong, when the canvas under it changes size between
 * loading, drawing and saving. As fractions it stays on the same
 * part of the picture. Pixels come in only to draw a shape and to measure
 * what the user aims at in pixels (closing a polygon, a double-click's
 * repeated corner, a rectangle too small to keep); device units are
 * lib/config-xml.js's business. The geometry checks (a point in a polygon,
 * an outline that crosses itself) work in any of these units.
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

/**
 * Whether a polygon's outline never meets itself: no two edges cross, touch
 * or overlap, apart from neighbouring edges sharing their corner. A bow-tie
 * or a corner placed on another edge is not simple, and Hikvision's web UI
 * refuses to save such a motion region ("no crossing line is allowed"); the
 * device may reject it or detect motion in an area nobody meant.
 *
 * Unlike the web UI's check, two edges that lie on one line count only when
 * they really overlap or touch: its test rejects any such pair, which turns
 * down valid shapes such as a U whose two feet stand on the same line.
 *
 * A corner repeated straight after itself (a double click) doesn't count as
 * an edge. Fewer than three distinct corners is no polygon, so not simple.
 * Stretching all points by the same factors doesn't change the answer, so
 * device units work as well as fractions of the picture; with whole device
 * units the arithmetic is exact.
 * @param {ImagePoint[]} polygon - its corners in order; the last joins the first
 * @returns {boolean}
 * @example
 * isSimplePolygon([{x: 0, y: 0}, {x: 1, y: 0}, {x: 1, y: 1}, {x: 0, y: 1}]) // → true
 * isSimplePolygon([{x: 0, y: 0}, {x: 1, y: 1}, {x: 1, y: 0}, {x: 0, y: 1}]) // → false: a bow-tie
 */
export function isSimplePolygon(polygon) {
  const corners = withoutRepeatedCorners(polygon);
  const n = corners.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % n];
    // The next edge, from b, folding back along this one
    if (foldsBack(a, b, corners[(i + 2) % n])) return false;
    // Every edge that doesn't share a corner with this one; the last edge
    // shares the first corner with the first
    for (let j = i + 2; j < n - (i === 0 ? 1 : 0); j++) {
      if (segmentsMeet(a, b, corners[j], corners[(j + 1) % n])) return false;
    }
  }
  return true;
}

/**
 * Corners with any that repeat the corner before them (or, for the last one,
 * the first) left out.
 * @param {ImagePoint[]} polygon
 * @returns {ImagePoint[]}
 */
function withoutRepeatedCorners(polygon) {
  /** @param {ImagePoint} p @param {ImagePoint} q */
  const same = (p, q) => p.x === q.x && p.y === q.y;
  const corners = polygon.filter((p, i) => i === 0 || !same(p, polygon[i - 1]));
  while (corners.length > 1 && same(corners[0], corners[corners.length - 1])) corners.pop();
  return corners;
}

/**
 * Which side of the line through a and b point c is on: positive for one
 * side, negative for the other, 0 on the line.
 * @param {ImagePoint} a
 * @param {ImagePoint} b
 * @param {ImagePoint} c
 * @returns {number}
 */
function turn(a, b, c) {
  return Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
}

/**
 * Whether c, on the line through a and b, lies within the segment a–b.
 * @param {ImagePoint} a
 * @param {ImagePoint} b
 * @param {ImagePoint} c
 */
function withinSegment(a, b, c) {
  return Math.min(a.x, b.x) <= c.x && c.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= c.y && c.y <= Math.max(a.y, b.y);
}

/**
 * Whether the segments a–b and c–d have any point in common: they cross,
 * one ends on the other, or they overlap along one line.
 * @param {ImagePoint} a
 * @param {ImagePoint} b
 * @param {ImagePoint} c
 * @param {ImagePoint} d
 */
function segmentsMeet(a, b, c, d) {
  const abc = turn(a, b, c);
  const abd = turn(a, b, d);
  const cda = turn(c, d, a);
  const cdb = turn(c, d, b);
  if (abc * abd < 0 && cda * cdb < 0) return true;
  return (abc === 0 && withinSegment(a, b, c)) || (abd === 0 && withinSegment(a, b, d)) ||
    (cda === 0 && withinSegment(c, d, a)) || (cdb === 0 && withinSegment(c, d, b));
}

/**
 * Whether the edge b–c turns all the way back along a–b, so the two overlap
 * beyond their shared corner b (a spike with no width).
 * @param {ImagePoint} a
 * @param {ImagePoint} b
 * @param {ImagePoint} c
 */
function foldsBack(a, b, c) {
  return turn(a, b, c) === 0 && (a.x - b.x) * (c.x - b.x) + (a.y - b.y) * (c.y - b.y) > 0;
}

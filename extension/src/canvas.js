/**
 * The drawing canvas over the live feed; mouse events go to the active tool.
 */

import { ctx, dom, state } from './state.js';
import { ToolRegistry } from './tools/registry.js';

/**
 * Where the pointer is on the picture, as fractions of its size (0–1, Y=0 at
 * the top). The canvas covers the picture as displayed, so its box on screen
 * is the picture's, whatever pixels it has at the moment (those follow each
 * frame, see resizeCanvas).
 * @param {MouseEvent} e
 * @returns {import('../lib/shapes.js').ImagePoint}
 */
export function getImagePos(e) {
  const rect = dom.canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / rect.width,
    y: (e.clientY - rect.top) / rect.height,
  };
}

// ─── Canvas Drawing ─────────────────────────────────────────────────────────

/**
 * Give the canvas the shown frame's pixels and displayed size. Tools keep
 * their shapes as fractions of the picture, so a frame of another size
 * (an HD still, a stored picture) only changes how finely they are drawn.
 */
export function resizeCanvas() {
  const img = dom.videoFeed;
  dom.canvas.width = img.naturalWidth || img.width;
  dom.canvas.height = img.naturalHeight || img.height;
  dom.canvas.style.width = img.clientWidth + 'px';
  dom.canvas.style.height = img.clientHeight + 'px';
}

export function redraw() {
  ctx.clearRect(0, 0, dom.canvas.width, dom.canvas.height);
  if (state.activeSection !== 'config') return;
  const tool = ToolRegistry.get(state.activeTool);
  if (tool?.draw) tool.draw(ctx, dom.canvas);
}


// ─── Canvas Event Handlers (delegated to active tool) ───────────────────────

/** Route canvas mouse events to the active tool. */
export function bindCanvasEvents() {

  dom.canvas.addEventListener('mousedown', (e) => {
    if (state.activeSection !== 'config') return;
    e.preventDefault();
    const pos = getImagePos(e);
    const tool = ToolRegistry.get(state.activeTool);
    if (tool?.onMouseDown) tool.onMouseDown(pos, e);
  });

  dom.canvas.addEventListener('mousemove', (e) => {
    if (state.activeSection !== 'config') return;
    // Allow mousemove even when not drawing (for polygon vertex preview)
    if (!state.isDrawing && !(state.drawingPoints && state.drawingPoints.length > 0)) return;
    const pos = getImagePos(e);
    const tool = ToolRegistry.get(state.activeTool);
    if (tool?.onMouseMove) tool.onMouseMove(pos, e);
  });

  dom.canvas.addEventListener('dblclick', (e) => {
    if (state.activeSection !== 'config') return;
    e.preventDefault();
    const pos = getImagePos(e);
    const tool = ToolRegistry.get(state.activeTool);
    if (tool?.onDblClick) tool.onDblClick(pos, e);
  });

  dom.canvas.addEventListener('mouseup', (e) => {
    if (state.activeSection !== 'config') return;
    const pos = getImagePos(e);
    const tool = ToolRegistry.get(state.activeTool);
    if (tool?.onMouseUp) tool.onMouseUp(pos, e);
    state.isDrawing = false;
    state.drawStart = null;
    state.drawCurrent = null;
    redraw();
  });

  dom.canvas.addEventListener('contextmenu', (e) => e.preventDefault());


}

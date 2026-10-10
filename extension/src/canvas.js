/**
 * The drawing canvas over the live feed; mouse events go to the active tool.
 */

import { ctx, dom, state } from './state.js';
import { ToolRegistry } from './tools/registry.js';

/**
 * Pointer position in canvas pixels (the canvas is scaled to fit the page).
 * @param {MouseEvent} e
 * @returns {import('./state.js').CanvasPoint}
 */
export function getCanvasPos(e) {
  const rect = dom.canvas.getBoundingClientRect();
  const scaleX = dom.canvas.width / rect.width;
  const scaleY = dom.canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  };
}

// ─── Canvas Drawing ─────────────────────────────────────────────────────────

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
    const pos = getCanvasPos(e);
    const tool = ToolRegistry.get(state.activeTool);
    if (tool?.onMouseDown) tool.onMouseDown(pos, e);
  });

  dom.canvas.addEventListener('mousemove', (e) => {
    if (state.activeSection !== 'config') return;
    // Allow mousemove even when not drawing (for polygon vertex preview)
    if (!state.isDrawing && !(state.drawingPoints && state.drawingPoints.length > 0)) return;
    const pos = getCanvasPos(e);
    const tool = ToolRegistry.get(state.activeTool);
    if (tool?.onMouseMove) tool.onMouseMove(pos, e);
  });

  dom.canvas.addEventListener('dblclick', (e) => {
    if (state.activeSection !== 'config') return;
    e.preventDefault();
    const pos = getCanvasPos(e);
    const tool = ToolRegistry.get(state.activeTool);
    if (tool?.onDblClick) tool.onDblClick(pos, e);
  });

  dom.canvas.addEventListener('mouseup', (e) => {
    if (state.activeSection !== 'config') return;
    const pos = getCanvasPos(e);
    const tool = ToolRegistry.get(state.activeTool);
    if (tool?.onMouseUp) tool.onMouseUp(pos, e);
    state.isDrawing = false;
    state.drawStart = null;
    state.drawCurrent = null;
    redraw();
  });

  dom.canvas.addEventListener('contextmenu', (e) => e.preventDefault());


}

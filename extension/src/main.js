/**
 * Entry point of the config page (app.html).
 */

import { Isapi } from '../lib/isapi.js';
import { bindCanvasEvents, redraw, resizeCanvas } from './canvas.js';
import { connect, disconnect, handleAuthFailure, loadSavedCredentials } from './connection.js';
import { cancelScan, showConnectionForm, showScanIntro, startScan } from './scan.js';
import { byId, dom, state } from './state.js';
import { eventsTool } from './tools/events.js';
import { motionTool } from './tools/motion.js';
import { privacyTool } from './tools/privacy.js';
import { ToolRegistry, initToolRegistry, switchTool, toggleConfig } from './tools/registry.js';
import { switchSection, switchToGridView, switchToLiveViewSingle, toggleMaximizeCell } from './views.js';

/** Wire up the page: buttons, keyboard shortcuts and window events. */
function bindAppEvents() {

  // Section tabs
  byId('liveViewSectionTab').addEventListener('click', () => switchSection('liveview'));
  byId('configSectionTab').addEventListener('click', () => switchSection('config'));

  // Live View sub-tabs
  byId('singleViewTab').addEventListener('click', () => {
    state.viewMode = 'single';
    switchToLiveViewSingle();
  });
  byId('gridViewTab').addEventListener('click', switchToGridView);

  // Config section collapse toggle
  byId('configToggleBtn').addEventListener('click', toggleConfig);

  // Scan flow
  byId('startScanBtn').addEventListener('click', startScan);
  byId('manualEntryBtn').addEventListener('click', showConnectionForm);
  byId('cancelScanBtn').addEventListener('click', cancelScan);
  byId('rescanBtn').addEventListener('click', startScan);
  byId('manualAfterScanBtn').addEventListener('click', showConnectionForm);
  byId('backToScanBtn').addEventListener('click', showScanIntro);

  dom.connectBtn.addEventListener('click', connect);
  byId('disconnectBtn').addEventListener('click', disconnect);

  // Allow Enter key to connect
  dom.passInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connect();
  });

  window.addEventListener('resize', () => {
    resizeCanvas();
    redraw();
  });

  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;

    // Context-dependent number shortcuts
    const tools = ToolRegistry.getAll();
    const keyIdx = parseInt(e.key) - 1;

    if (keyIdx >= 0) {
      if (state.activeSection === 'liveview') {
        if (e.key === '1') { state.viewMode = 'single'; switchToLiveViewSingle(); }
        if (e.key === '2') switchToGridView();
      } else {
        // Config mode: number keys switch tools
        if (keyIdx < tools.length) {
          switchTool(tools[keyIdx].id);
        }
      }
    }

    if (e.key === 'Escape') {
      if (state.gridExpandedCell !== null) {
        toggleMaximizeCell(state.gridExpandedCell);
      } else if (state.drawingPoints && state.drawingPoints.length > 0) {
        // Cancel in-progress polygon drawing
        state.drawingPoints = [];
        redraw();
      }
    }
  });


}

ToolRegistry.register(motionTool);
ToolRegistry.register(privacyTool);
ToolRegistry.register(eventsTool);
initToolRegistry();
bindCanvasEvents();
bindAppEvents();
Isapi.onAuthFailure = handleAuthFailure;
loadSavedCredentials();

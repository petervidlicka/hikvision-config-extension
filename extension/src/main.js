/**
 * Entry point of the config page (app.html).
 */

import { parseDateKey } from '../lib/device-time.js';
import { Isapi } from '../lib/isapi.js';
import { bindCanvasEvents, redraw, resizeCanvas } from './canvas.js';
import { connect, disconnect, handleAuthFailure, loadSavedCredentials } from './connection.js';
import { cancelScan, showConnectionForm, showScanIntro, startScan } from './scan.js';
import { byId, dom, queryAll, state } from './state.js';
import { eventsTool } from './tools/events.js';
import { motionTool } from './tools/motion.js';
import { privacyTool } from './tools/privacy.js';
import { ToolRegistry, initToolRegistry, switchTool, toggleConfig } from './tools/registry.js';
import { switchSection, switchToGridView, switchToLiveViewSingle, toggleMaximizeCell } from './views.js';
import { setStreamType, syncFeedsWithVisibility } from './feed.js';
import { initialPlaybackState, renderTimeline, seekFromClick, setDate, setFilter, setSpeed, shiftDate, skip, togglePlay } from './playback.js';

/** Wire up the page: buttons, keyboard shortcuts and window events. */
function bindAppEvents() {
  // Section tabs
  byId('liveViewSectionTab').addEventListener('click', () => switchSection('liveview'));
  byId('configSectionTab').addEventListener('click', () => switchSection('config'));
  byId('playbackSectionTab').addEventListener('click', () => switchSection('playback'));

  // Playback controls
  byId('pbPlayPauseBtn').addEventListener('click', togglePlay);
  byId('pbSkipBackBtn').addEventListener('click', () => skip(-10));
  byId('pbSkipFwdBtn').addEventListener('click', () => skip(10));
  byId('pbLiveBtn').addEventListener('click', () => switchSection('liveview'));
  byId('pbTimelineWrap').addEventListener('click', seekFromClick);
  byId('pbDatePrev').addEventListener('click', () => shiftDate(-1));
  byId('pbDateNext').addEventListener('click', () => shiftDate(1));
  const dateInput = byId('pbDateInput', HTMLInputElement);
  byId('pbDateLabel').addEventListener('click', () => dateInput.showPicker());
  dateInput.addEventListener('change', () => {
    const day = parseDateKey(dateInput.value);
    if (day) setDate(day);
  });
  byId('pbFilter', HTMLSelectElement).addEventListener('change', (e) => {
    setFilter(/** @type {HTMLSelectElement} */ (e.target).value === 'events' ? 'events' : 'all');
  });
  queryAll(document, '.pb-speed').forEach(btn => {
    btn.addEventListener('click', () => {
      const speed = Number(btn.dataset.speed);
      setSpeed(speed === 2 || speed === 4 ? speed : 1);
    });
  });

  // Live View sub-tabs
  byId('singleViewTab').addEventListener('click', () => {
    state.viewMode = 'single';
    switchToLiveViewSingle();
  });
  byId('gridViewTab').addEventListener('click', switchToGridView);
  byId('streamBtnSd').addEventListener('click', () => setStreamType('sub'));
  byId('streamBtnHd').addEventListener('click', () => setStreamType('main'));

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

  // No live feed asks the device for frames while nobody can see them
  document.addEventListener('visibilitychange', syncFeedsWithVisibility);

  window.addEventListener('resize', () => {
    resizeCanvas();
    redraw();
    if (state.activeSection === 'playback') renderTimeline();
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
      } else if (state.activeSection === 'config') {
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

state.playback = initialPlaybackState();
ToolRegistry.register(motionTool);
ToolRegistry.register(privacyTool);
ToolRegistry.register(eventsTool);
initToolRegistry();
bindCanvasEvents();
bindAppEvents();
Isapi.onAuthFailure = handleAuthFailure;
loadSavedCredentials();
chrome.storage.local.get('streamType', ({ streamType }) => {
  if (streamType === 'main' || streamType === 'sub') setStreamType(streamType);
});

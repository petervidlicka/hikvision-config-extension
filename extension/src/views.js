/**
 * Switching between Live View and Configuration, single and grid views,
 * and channel selection.
 */

import { startGridCellFeed, startSnapshotFeed, stopAllGridFeeds, stopSnapshotFeed } from './feed.js';
import { byId, dom, query, queryAll, state } from './state.js';
import { ToolRegistry, expandConfig, loadTool } from './tools/registry.js';
import { channelLabel, setStatus, showToast } from './ui.js';

/**
 * Select a channel: highlight it, start its feed, and load the active
 * tool's settings when in the Configuration section.
 * @param {string} channelId
 * @param {Element|undefined} element - its entry in the channel list
 */
export async function selectChannel(channelId, element) {
  // If in grid view, switch back to single camera mode
  if (state.viewMode === 'grid') {
    switchToSingleView();
  }

  document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
  if (element) element.classList.add('active');

  state.activeChannel = channelId;

  // Reset tool state for the new channel
  ToolRegistry.getAll().forEach(t => t.resetState());

  // Start the feed
  startSnapshotFeed(channelId);

  // Only load config and expand panel if in Configuration section
  if (state.activeSection === 'config') {
    expandConfig();
    loadTool(state.activeTool);
  }
}


// ─── Section Navigation ──────────────────────────────────────────────────────

/**
 * Switch between the Live View and Configuration sections.
 * @param {'liveview'|'config'} section
 */
export function switchSection(section) {
  state.activeSection = section;

  byId('liveViewSectionTab').classList.toggle('active', section === 'liveview');
  byId('configSectionTab').classList.toggle('active', section === 'config');

  dom.liveViewTabs.style.display = section === 'liveview' ? 'flex' : 'none';
  dom.configTabs.style.display = section === 'config' ? 'flex' : 'none';

  if (section === 'liveview') {
    dom.toolConfigSection.style.display = 'none';
    dom.canvas.style.cursor = 'default';

    if (state.viewMode === 'grid') {
      switchToGridView();
    } else {
      switchToLiveViewSingle();
    }
  } else {
    dom.toolConfigSection.style.display = 'block';

    const tool = ToolRegistry.get(state.activeTool);
    dom.canvas.style.cursor = tool?.cursor || 'crosshair';

    // Force single-cam view for configuration
    if (state.viewMode === 'grid') {
      stopAllGridFeeds();
    }
    dom.canvasContainer.style.display = '';
    dom.gridView.style.display = 'none';

    expandConfig();
    if (state.activeChannel) {
      startSnapshotFeed(state.activeChannel);
      loadTool(state.activeTool);
    }

    // Update config sub-tab active states
    queryAll(dom.configTabs, '.tool-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tool === state.activeTool);
    });
  }
}

export function switchToLiveViewSingle() {
  state.viewMode = 'single';
  stopAllGridFeeds();

  dom.canvasContainer.style.display = '';
  dom.gridView.style.display = 'none';

  byId('singleViewTab').classList.toggle('active', true);
  byId('gridViewTab').classList.toggle('active', false);

  if (state.activeChannel) {
    startSnapshotFeed(state.activeChannel);
  }

  setStatus('Live View', state.activeChannel ? `Channel ${state.activeChannel}` : '');
}


export function switchToGridView() {
  if (!state.connected || state.channels.length === 0) {
    showToast('Connect to an NVR first', 'error');
    return;
  }

  state.viewMode = 'grid';

  stopSnapshotFeed();

  dom.canvasContainer.style.display = 'none';
  dom.gridView.style.display = 'grid';

  byId('singleViewTab').classList.toggle('active', false);
  byId('gridViewTab').classList.toggle('active', true);

  // Clear any maximized state
  dom.gridView.classList.remove('maximized');
  document.querySelectorAll('.grid-cell').forEach(c => c.classList.remove('maximized'));
  state.gridExpandedCell = null;

  stopAllGridFeeds();

  // Assign default channels if not already assigned
  for (let i = 0; i < 4; i++) {
    if (!state.gridCellChannels[i]) {
      state.gridCellChannels[i] = state.channels[i]?.id || null;
    }
  }

  const cells = queryAll(document, '.grid-cell');
  cells.forEach((cell, idx) => {
    const picker = query(cell, '.grid-channel-picker', HTMLSelectElement);

    picker.replaceChildren(
      new Option('— empty —', ''),
      ...state.channels.map(ch => {
        const selected = state.gridCellChannels[idx] === ch.id;
        return new Option(channelLabel(ch), ch.id, selected, selected);
      }),
    );

    picker.onchange = () => {
      state.gridCellChannels[idx] = picker.value || null;
      startGridCellFeed(idx, state.gridCellChannels[idx]);
    };

    const maxBtn = query(cell, '.grid-maximize-btn');
    maxBtn.onclick = (e) => {
      e.stopPropagation();
      toggleMaximizeCell(idx);
    };

    startGridCellFeed(idx, state.gridCellChannels[idx]);
  });

  const activeCells = state.gridCellChannels.filter(Boolean).length;
  setStatus('4-Camera View', `${activeCells} camera${activeCells !== 1 ? 's' : ''}`);
}

export function switchToSingleView() {
  state.viewMode = 'single';
  stopAllGridFeeds();

  dom.canvasContainer.style.display = '';
  dom.gridView.style.display = 'none';

  if (state.activeChannel) {
    startSnapshotFeed(state.activeChannel);
  }
}

/**
 * Maximize a grid cell, or restore the grid if it's already maximized.
 * @param {number} cellIdx
 */
export function toggleMaximizeCell(cellIdx) {
  const cells = queryAll(document, '.grid-cell');

  if (state.gridExpandedCell === cellIdx) {
    dom.gridView.classList.remove('maximized');
    cells.forEach(c => c.classList.remove('maximized'));
    state.gridExpandedCell = null;
  } else {
    dom.gridView.classList.add('maximized');
    cells.forEach(c => c.classList.remove('maximized'));
    cells[cellIdx].classList.add('maximized');
    state.gridExpandedCell = cellIdx;
  }
}

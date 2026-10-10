/**
 * Switching between Live View and Configuration, single and grid views,
 * and channel selection.
 */

import { startGridCellFeed, startSnapshotFeed, stopAllGridFeeds, stopSnapshotFeed } from './feed.js';
import { dom, state } from './state.js';
import { ToolRegistry, expandConfig, setToolPanelLoading } from './tools/registry.js';
import { channelLabel, setStatus, showToast } from './ui.js';

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
    const tool = ToolRegistry.get(state.activeTool);
    if (tool?.load) {
      setToolPanelLoading(state.activeTool, true);
      tool.load().then(() => {
        setToolPanelLoading(state.activeTool, false);
      }).catch(() => {
        setToolPanelLoading(state.activeTool, false);
      });
    }
  }
}


// ─── Section Navigation ──────────────────────────────────────────────────────

export function switchSection(section) {
  state.activeSection = section;

  document.getElementById('liveViewSectionTab').classList.toggle('active', section === 'liveview');
  document.getElementById('configSectionTab').classList.toggle('active', section === 'config');

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
      if (tool?.load) {
        setToolPanelLoading(state.activeTool, true);
        tool.load().then(() => {
          setToolPanelLoading(state.activeTool, false);
        }).catch(() => {
          setToolPanelLoading(state.activeTool, false);
        });
      }
    }

    // Update config sub-tab active states
    dom.configTabs.querySelectorAll('.tool-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tool === state.activeTool);
    });
  }
}

export function switchToLiveViewSingle() {
  state.viewMode = 'single';
  stopAllGridFeeds();

  dom.canvasContainer.style.display = '';
  dom.gridView.style.display = 'none';

  document.getElementById('singleViewTab').classList.toggle('active', true);
  document.getElementById('gridViewTab').classList.toggle('active', false);

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

  document.getElementById('singleViewTab').classList.toggle('active', false);
  document.getElementById('gridViewTab').classList.toggle('active', true);

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

  const cells = document.querySelectorAll('.grid-cell');
  cells.forEach((cell, idx) => {
    const picker = cell.querySelector('.grid-channel-picker');

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

    const maxBtn = cell.querySelector('.grid-maximize-btn');
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

export function toggleMaximizeCell(cellIdx) {
  const cells = document.querySelectorAll('.grid-cell');

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

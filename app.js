/**
 * Hikvision Config Tool — Chrome Extension UI
 *
 * All NVR communication goes through chrome.runtime.sendMessage() to the
 * background service worker, which handles Digest auth and ISAPI calls.
 */

// ─── State ──────────────────────────────────────────────────────────────────
const state = {
  config: null,
  connected: false,
  channels: [],
  activeChannel: null,
  activeTool: 'motion',
  // Motion detection grid (22 cols x 18 rows for Hikvision)
  gridCols: 22,
  gridRows: 18,
  grid: [],
  motionEnabled: false,
  sensitivity: 50,
  // Privacy mask regions (max 4 rectangles)
  privacyEnabled: false,
  privacyRegions: [],
  // Drawing state
  isDrawing: false,
  drawStart: null,
  drawCurrent: null,
  paintValue: true,
  // Video
  snapshotInterval: null,
  rawMotionXml: null,
  // 4-cam grid view
  viewMode: 'single', // 'single' or 'grid'
  gridSnapIntervals: [],
  gridCellChannels: [null, null, null, null], // channelId assigned to each grid cell
  // Section navigation
  activeSection: 'liveview', // 'liveview' or 'config'
  gridExpandedCell: null, // index of maximized grid cell, or null
};

// ─── DOM refs ───────────────────────────────────────────────────────────────
const canvas = document.getElementById('drawCanvas');
const ctx = canvas.getContext('2d');

// ─── Init ───────────────────────────────────────────────────────────────────
function initGrid() {
  state.grid = Array.from({ length: state.gridRows }, () =>
    Array.from({ length: state.gridCols }, () => false)
  );
}
initGrid();

// Load saved connection details on startup
chrome.storage.local.get(['host', 'port', 'username', 'password', 'savePassword'], (data) => {
  if (data.host) document.getElementById('hostInput').value = data.host;
  if (data.port) document.getElementById('portInput').value = data.port;
  if (data.username) document.getElementById('userInput').value = data.username;
  if (data.savePassword) {
    document.getElementById('savePassCheck').checked = true;
    if (data.password) document.getElementById('passInput').value = data.password;
  }
});

// ─── Messaging helper ───────────────────────────────────────────────────────
function sendMsg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!response) {
        reject(new Error('No response from background'));
      } else if (!response.success) {
        reject(new Error(response.error || 'Unknown error'));
      } else {
        resolve(response);
      }
    });
  });
}

// ─── Toast Notifications ────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove('show'), 3000);
}

function setStatus(text, right = '') {
  document.getElementById('statusText').textContent = text;
  document.getElementById('statusRight').textContent = right;
}

// ─── Network Scanner ─────────────────────────────────────────────────────────

let scanProgressInterval = null;

/** Show the scan intro panel (default disconnected view). */
function showScanIntro() {
  document.getElementById('scanIntro').style.display = 'block';
  document.getElementById('scanProgress').style.display = 'none';
  document.getElementById('scanResults').style.display = 'none';
  document.getElementById('connectionForm').style.display = 'none';
}

/** Show the manual login form (hides all scan panels). */
function showConnectionForm() {
  document.getElementById('scanIntro').style.display = 'none';
  document.getElementById('scanProgress').style.display = 'none';
  document.getElementById('scanResults').style.display = 'none';
  document.getElementById('connectionForm').style.display = 'block';
}

/** Kick off a network scan, show the radar animation, then show results. */
async function startScan() {
  document.getElementById('scanIntro').style.display = 'none';
  document.getElementById('scanProgress').style.display = 'block';
  document.getElementById('scanResults').style.display = 'none';
  document.getElementById('connectionForm').style.display = 'none';

  // Animate the progress bar over ~10 seconds
  const fill = document.getElementById('scanProgressFill');
  const statusEl = document.getElementById('scanStatusText');
  fill.style.width = '0%';
  statusEl.innerHTML = 'Scanning your local network<br>for Hikvision devices…';

  const startTime = Date.now();
  const TOTAL_MS = 10000;
  scanProgressInterval = setInterval(() => {
    const pct = Math.min(100, ((Date.now() - startTime) / TOTAL_MS) * 100);
    fill.style.width = pct + '%';
    if (pct >= 100) clearInterval(scanProgressInterval);
  }, 100);

  try {
    const data = await sendMsg({ action: 'scanNetwork' });
    clearInterval(scanProgressInterval);
    fill.style.width = '100%';
    showScanResults(data.devices || []);
  } catch (err) {
    clearInterval(scanProgressInterval);
    // Surface the real error so it's not a mystery why results are empty
    showToast('Scan error: ' + err.message, 'error');
    showScanResults([]);
  }
}

/** Cancel an in-progress scan and return to the intro. */
function cancelScan() {
  clearInterval(scanProgressInterval);
  showScanIntro();
}

/** Render the results panel after a scan completes. */
function showScanResults(devices) {
  document.getElementById('scanProgress').style.display = 'none';
  document.getElementById('scanResults').style.display = 'block';

  const text = document.getElementById('scanResultsText');
  const list = document.getElementById('scanDeviceList');

  if (devices.length === 0) {
    text.textContent = 'No Hikvision devices found on your local network. Try entering the IP address manually.';
    list.innerHTML = '';
  } else {
    text.textContent = `Found ${devices.length} Hikvision device${devices.length > 1 ? 's' : ''}. Click one to connect:`;
    list.innerHTML = devices.map(d => `
      <div class="scan-device-card" data-ip="${d.ip}" data-port="${d.port || 80}">
        <div class="scan-device-ip">${d.ip}</div>
        <div class="scan-device-label">Hikvision NVR / Camera &bull; Port ${d.port || 80}</div>
      </div>
    `).join('');

    list.querySelectorAll('.scan-device-card').forEach(card => {
      card.addEventListener('click', () => {
        document.getElementById('hostInput').value = card.dataset.ip;
        document.getElementById('portInput').value = card.dataset.port;
        showConnectionForm();
      });
    });
  }
}

// ─── Connection ─────────────────────────────────────────────────────────────
async function connect() {
  const btn = document.getElementById('connectBtn');
  const host = document.getElementById('hostInput').value.trim();
  const port = document.getElementById('portInput').value.trim() || '80';
  const username = document.getElementById('userInput').value.trim();
  const password = document.getElementById('passInput').value;

  if (!host || !username || !password) {
    showToast('Please fill in all connection fields', 'error');
    return;
  }

  state.config = { host, port: parseInt(port), username, password };
  btn.innerHTML = '<span class="loading"></span> Connecting...';
  btn.disabled = true;
  setStatus('Connecting to ' + host + '...');

  // Save connection details
  const saveData = { host, port, username, savePassword: document.getElementById('savePassCheck').checked };
  if (saveData.savePassword) saveData.password = password;
  chrome.storage.local.set(saveData);

  try {
    const data = await sendMsg({ action: 'testConnection', config: state.config });

    state.connected = true;
    document.getElementById('statusDot').classList.add('connected');
    const dev = data.device;
    document.getElementById('deviceInfo').textContent =
      `${dev.deviceName || dev.model || 'Device'} • FW ${dev.firmwareVersion || 'N/A'}`;

    showToast('Connected successfully!', 'success');
    setStatus('Connected', host);

    // Collapse login form
    document.getElementById('connectionForm').style.display = 'none';
    document.getElementById('connectionStatus').style.display = 'flex';
    document.getElementById('connectedHost').textContent = host;

    await loadChannels();
  } catch (err) {
    showToast('Connection failed: ' + err.message, 'error');
    setStatus('Connection failed');
    document.getElementById('statusDot').classList.remove('connected');
  } finally {
    btn.disabled = false;
    if (btn.querySelector('.loading')) btn.textContent = 'Connect';
  }
}

/** Reset to disconnected state and re-show the login form. */
function disconnect() {
  // Stop all feeds
  if (state.snapshotInterval) clearInterval(state.snapshotInterval);
  state.gridSnapIntervals.forEach(id => id && clearInterval(id));
  state.gridSnapIntervals = [null, null, null, null];

  // Reset state
  state.connected = false;
  state.config = null;
  state.channels = [];
  state.activeChannel = null;
  state.viewMode = 'single';
  state.gridCellChannels = [null, null, null, null];
  state.activeSection = 'liveview';
  state.gridExpandedCell = null;
  initGrid();
  state.privacyRegions = [];

  // Collapse config section
  configExpanded = false;
  document.getElementById('configPanels').style.display = 'none';
  document.getElementById('configArrow').textContent = '▸';

  // Reset UI — return to the scan intro screen
  showScanIntro();
  document.getElementById('connectionStatus').style.display = 'none';
  document.getElementById('channelsSection').style.display = 'none';
  document.getElementById('toolConfigSection').style.display = 'none';
  document.getElementById('sectionTabs').style.display = 'none';
  document.getElementById('toolTabs').style.display = 'none';
  document.getElementById('statusDot').classList.remove('connected');
  document.getElementById('deviceInfo').textContent = 'Not connected';
  document.getElementById('noFeed').style.display = '';
  document.getElementById('canvasWrapper').style.display = 'none';
  document.getElementById('canvasContainer').style.display = '';
  document.getElementById('gridView').style.display = 'none';
  setStatus('Ready');
}

async function loadChannels() {
  try {
    const data = await sendMsg({ action: 'getChannels', config: state.config });

    state.channels = data.channels;
    const list = document.getElementById('channelList');
    list.innerHTML = '';

    state.channels.forEach((ch, i) => {
      const div = document.createElement('div');
      div.className = 'channel-item' + (i === 0 ? ' active' : '');
      div.innerHTML = `<div class="ch-num">${ch.id}</div><span>${ch.name || ch.inputPort || ('Channel ' + ch.id)}</span>`;
      div.addEventListener('click', () => selectChannel(ch.id, div));
      list.appendChild(div);
    });

    document.getElementById('channelsSection').style.display = 'block';
    document.getElementById('sectionTabs').style.display = 'flex';
    document.getElementById('toolTabs').style.display = 'flex';

    // Default to Live View after login
    switchSection('liveview');

    if (state.channels.length > 0) {
      selectChannel(state.channels[0].id, list.children[0]);
    }
  } catch (err) {
    showToast('Failed to load channels: ' + err.message, 'error');
  }
}

async function selectChannel(channelId, element) {
  // If in grid view, switch back to single camera mode
  if (state.viewMode === 'grid') {
    switchToSingleView();
  }

  document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
  if (element) element.classList.add('active');

  state.activeChannel = channelId;
  initGrid();
  state.privacyRegions = [];

  // Start the feed
  startSnapshotFeed(channelId);

  // Only load config and expand panel if in Configuration section
  if (state.activeSection === 'config') {
    expandConfig();
    loadMotionDetection();
  }
}

// ─── Section Navigation ──────────────────────────────────────────────────────

/** Switch between Live View and Configuration primary sections. */
function switchSection(section) {
  state.activeSection = section;

  // Update section tab active classes
  document.getElementById('liveViewSectionTab').classList.toggle('active', section === 'liveview');
  document.getElementById('configSectionTab').classList.toggle('active', section === 'config');

  // Toggle sub-tab visibility
  document.getElementById('liveViewTabs').style.display = section === 'liveview' ? 'flex' : 'none';
  document.getElementById('configTabs').style.display = section === 'config' ? 'flex' : 'none';

  if (section === 'liveview') {
    // Hide config sidebar section
    document.getElementById('toolConfigSection').style.display = 'none';

    // Canvas cursor: default (no drawing in live view)
    canvas.style.cursor = 'default';

    // Restore last view mode
    if (state.viewMode === 'grid') {
      switchToGridView();
    } else {
      switchToLiveViewSingle();
    }
  } else {
    // Configuration mode
    // Show config sidebar section
    document.getElementById('toolConfigSection').style.display = 'block';

    // Canvas cursor: crosshair for drawing
    canvas.style.cursor = 'crosshair';

    // Force single-cam view for configuration
    if (state.viewMode === 'grid') {
      // Stop grid feeds but remember we were in grid mode
      state.gridSnapIntervals.forEach(id => id && clearInterval(id));
      state.gridSnapIntervals = [null, null, null, null];
    }
    // Show single camera view
    document.getElementById('canvasContainer').style.display = '';
    document.getElementById('gridView').style.display = 'none';

    // Expand config panel and load config for active tool
    expandConfig();
    if (state.activeChannel) {
      startSnapshotFeed(state.activeChannel);
      if (state.activeTool === 'motion') {
        loadMotionDetection();
      } else {
        loadPrivacyMask();
      }
    }

    // Update config sub-tab active states
    document.getElementById('motionTab').classList.toggle('active', state.activeTool === 'motion');
    document.getElementById('privacyTab').classList.toggle('active', state.activeTool !== 'motion');
  }
}

/** Switch to single camera in Live View mode (no config tools). */
function switchToLiveViewSingle() {
  state.viewMode = 'single';

  // Stop grid feeds
  state.gridSnapIntervals.forEach(id => id && clearInterval(id));
  state.gridSnapIntervals = [null, null, null, null];

  // Show single view, hide grid
  document.getElementById('canvasContainer').style.display = '';
  document.getElementById('gridView').style.display = 'none';

  // Update live view sub-tab active states
  document.getElementById('singleViewTab').classList.toggle('active', true);
  document.getElementById('gridViewTab').classList.toggle('active', false);

  // Restart single-camera feed if we have an active channel
  if (state.activeChannel) {
    startSnapshotFeed(state.activeChannel);
  }

  setStatus('Live View', state.activeChannel ? `Channel ${state.activeChannel}` : '');
}

// ─── Video Feed ─────────────────────────────────────────────────────────────
function startSnapshotFeed(channelId) {
  if (state.snapshotInterval) clearInterval(state.snapshotInterval);

  document.getElementById('noFeed').style.display = 'none';
  document.getElementById('canvasWrapper').style.display = 'block';

  const img = document.getElementById('videoFeed');
  let frameCount = 0;

  const fetchSnapshot = async () => {
    try {
      const data = await sendMsg({
        action: 'getSnapshot',
        config: state.config,
        channelId,
      });

      img.onload = () => {
        resizeCanvas();
        redraw();
        frameCount++;
      };
      img.src = data.dataUrl;
    } catch (err) {
      if (frameCount === 0) {
        setStatus('Failed to get video feed: ' + err.message);
      }
    }
  };

  fetchSnapshot();
  state.snapshotInterval = setInterval(fetchSnapshot, 1000);
  setStatus('Streaming snapshots', `Channel ${channelId}`);
}

// ─── Canvas Drawing ─────────────────────────────────────────────────────────
function resizeCanvas() {
  const img = document.getElementById('videoFeed');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  canvas.style.width = img.clientWidth + 'px';
  canvas.style.height = img.clientHeight + 'px';
}

function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Only draw overlays in Configuration mode
  if (state.activeSection !== 'config') return;

  if (state.activeTool === 'motion') {
    drawMotionGrid();
  } else if (state.activeTool === 'privacy') {
    drawPrivacyMask();
  }
}

function drawMotionGrid() {
  const cellW = canvas.width / state.gridCols;
  const cellH = canvas.height / state.gridRows;

  // Draw grid cells
  for (let r = 0; r < state.gridRows; r++) {
    for (let c = 0; c < state.gridCols; c++) {
      const x = c * cellW;
      const y = r * cellH;

      if (state.grid[r][c]) {
        ctx.fillStyle = 'rgba(74, 108, 247, 0.35)';
        ctx.fillRect(x, y, cellW, cellH);
      }
    }
  }

  // Draw grid lines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.lineWidth = 0.3;
  for (let r = 0; r <= state.gridRows; r++) {
    ctx.beginPath();
    ctx.moveTo(0, r * cellH);
    ctx.lineTo(canvas.width, r * cellH);
    ctx.stroke();
  }
  for (let c = 0; c <= state.gridCols; c++) {
    ctx.beginPath();
    ctx.moveTo(c * cellW, 0);
    ctx.lineTo(c * cellW, canvas.height);
    ctx.stroke();
  }
}

function drawPrivacyMask() {
  state.privacyRegions.forEach((reg, i) => {
    ctx.fillStyle = 'rgba(239, 68, 68, 0.3)';
    ctx.fillRect(reg.x, reg.y, reg.w, reg.h);
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.8)';
    ctx.lineWidth = 2;
    ctx.strokeRect(reg.x, reg.y, reg.w, reg.h);

    ctx.fillStyle = 'rgba(239, 68, 68, 0.9)';
    ctx.font = 'bold 12px "JetBrains Mono", monospace';
    ctx.fillText(`Region ${i + 1}`, reg.x + 6, reg.y + 16);
  });

  // Draw in-progress rectangle
  if (state.isDrawing && state.drawStart && state.drawCurrent) {
    const x = Math.min(state.drawStart.x, state.drawCurrent.x);
    const y = Math.min(state.drawStart.y, state.drawCurrent.y);
    const w = Math.abs(state.drawCurrent.x - state.drawStart.x);
    const h = Math.abs(state.drawCurrent.y - state.drawStart.y);
    ctx.fillStyle = 'rgba(239, 68, 68, 0.2)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.6)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }
}

// ─── Canvas Events ──────────────────────────────────────────────────────────
function getCanvasPos(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  };
}

function getGridCell(pos) {
  const cellW = canvas.width / state.gridCols;
  const cellH = canvas.height / state.gridRows;
  return {
    col: Math.floor(pos.x / cellW),
    row: Math.floor(pos.y / cellH),
  };
}

// ─── Canvas Event Handlers ────────────────────────────────────────────────

canvas.addEventListener('mousedown', (e) => {
  // Block drawing in Live View
  if (state.activeSection !== 'config') return;
  e.preventDefault();
  const pos = getCanvasPos(e);

  if (state.activeTool === 'motion') {
    // Paint mode only
    state.isDrawing = true;
    const cell = getGridCell(pos);
    if (cell.row >= 0 && cell.row < state.gridRows && cell.col >= 0 && cell.col < state.gridCols) {
      state.paintValue = !state.grid[cell.row][cell.col];
      state.grid[cell.row][cell.col] = state.paintValue;
      redraw();
    }
  } else if (state.activeTool === 'privacy') {
    if (e.button === 2) {
      e.preventDefault();
      for (let i = state.privacyRegions.length - 1; i >= 0; i--) {
        const r = state.privacyRegions[i];
        if (pos.x >= r.x && pos.x <= r.x + r.w && pos.y >= r.y && pos.y <= r.y + r.h) {
          state.privacyRegions.splice(i, 1);
          updatePrivacyRegionList();
          redraw();
          break;
        }
      }
    } else {
      if (state.privacyRegions.length >= 4) {
        showToast('Maximum 4 privacy mask regions allowed', 'error');
        return;
      }
      state.isDrawing = true;
      state.drawStart = pos;
      state.drawCurrent = pos;
    }
  }
});

canvas.addEventListener('mousemove', (e) => {
  // Block drawing in Live View
  if (state.activeSection !== 'config') return;
  if (!state.isDrawing) return;

  const pos = getCanvasPos(e);

  if (state.activeTool === 'motion') {
    const cell = getGridCell(pos);
    if (cell.row >= 0 && cell.row < state.gridRows && cell.col >= 0 && cell.col < state.gridCols) {
      state.grid[cell.row][cell.col] = state.paintValue;
      redraw();
    }
  } else if (state.activeTool === 'privacy') {
    state.drawCurrent = pos;
    redraw();
  }
});

canvas.addEventListener('mouseup', (e) => {
  // Block drawing in Live View
  if (state.activeSection !== 'config') return;

  if (state.activeTool === 'privacy' && state.isDrawing && state.drawStart) {
    const pos = getCanvasPos(e);
    const x = Math.min(state.drawStart.x, pos.x);
    const y = Math.min(state.drawStart.y, pos.y);
    const w = Math.abs(pos.x - state.drawStart.x);
    const h = Math.abs(pos.y - state.drawStart.y);

    if (w > 10 && h > 10) {
      state.privacyRegions.push({ x, y, w, h });
      updatePrivacyRegionList();
    }
  }
  state.isDrawing = false;
  state.drawStart = null;
  state.drawCurrent = null;
  redraw();
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ─── Tool Switching ─────────────────────────────────────────────────────────
function switchTool(tool) {
  state.activeTool = tool;

  // Update config sub-tab active states
  document.getElementById('motionTab').classList.toggle('active', tool === 'motion');
  document.getElementById('privacyTab').classList.toggle('active', tool === 'privacy');

  // Update sidebar tool panels
  document.querySelectorAll('.tool-panel').forEach(el => el.classList.remove('active'));
  if (tool === 'motion') {
    document.getElementById('motionPanel').classList.add('active');
    document.getElementById('configToggleLabel').textContent = 'Motion Detection';
  } else {
    document.getElementById('privacyPanel').classList.add('active');
    document.getElementById('configToggleLabel').textContent = 'Privacy Mask';
  }

  // Auto-expand config when user switches to a configuration tab
  expandConfig();
  redraw();
}

// ─── Collapsible Config Section ──────────────────────────────────────────────

let configExpanded = false;

/** Expand the sidebar config panels (called when a tool tab is clicked). */
function expandConfig() {
  configExpanded = true;
  document.getElementById('configPanels').style.display = 'block';
  document.getElementById('configArrow').textContent = '▾';
}

/** Toggle the config panel open/closed. */
function toggleConfig() {
  configExpanded = !configExpanded;
  document.getElementById('configPanels').style.display = configExpanded ? 'block' : 'none';
  document.getElementById('configArrow').textContent = configExpanded ? '▾' : '▸';
}

// ─── 4-Camera Grid View ──────────────────────────────────────────────────────

/**
 * Start (or restart) the snapshot feed for a single grid cell.
 * Manages loading state, channel picker label, and interval bookkeeping.
 */
function startGridCellFeed(cellIdx, channelId) {
  // Clear existing interval for this cell
  if (state.gridSnapIntervals[cellIdx]) {
    clearInterval(state.gridSnapIntervals[cellIdx]);
    state.gridSnapIntervals[cellIdx] = null;
  }

  const cell = document.querySelectorAll('.grid-cell')[cellIdx];
  if (!cell) return;

  const img = cell.querySelector('.grid-feed');
  const noFeed = cell.querySelector('.grid-no-feed');

  img.classList.remove('loaded');
  img.src = '';

  if (!channelId) {
    // No channel assigned to this cell
    cell.classList.remove('is-loading');
    noFeed.textContent = 'No camera';
    noFeed.style.display = '';
    return;
  }

  // Show loading state
  cell.classList.add('is-loading');
  noFeed.style.display = 'none';

  const fetchSnap = async () => {
    try {
      const data = await sendMsg({
        action: 'getSnapshot',
        config: state.config,
        channelId,
      });
      img.onload = () => {
        cell.classList.remove('is-loading');
        img.classList.add('loaded');
      };
      img.src = data.dataUrl;
    } catch {
      // Keep showing loading state until next successful frame
    }
  };

  fetchSnap();
  state.gridSnapIntervals[cellIdx] = setInterval(fetchSnap, 1000);
}

/** Switch to the 2×2 grid showing all camera feeds simultaneously. */
function switchToGridView() {
  if (!state.connected || state.channels.length === 0) {
    showToast('Connect to an NVR first', 'error');
    return;
  }

  state.viewMode = 'grid';

  // Stop single-camera feed
  if (state.snapshotInterval) clearInterval(state.snapshotInterval);

  // Hide single view, show grid
  document.getElementById('canvasContainer').style.display = 'none';
  document.getElementById('gridView').style.display = 'grid';

  // Update live view sub-tab active states
  document.getElementById('singleViewTab').classList.toggle('active', false);
  document.getElementById('gridViewTab').classList.toggle('active', true);

  // Clear any maximized state
  const gridEl = document.getElementById('gridView');
  gridEl.classList.remove('maximized');
  document.querySelectorAll('.grid-cell').forEach(c => c.classList.remove('maximized'));
  state.gridExpandedCell = null;

  // Clear all existing grid intervals
  state.gridSnapIntervals.forEach(id => id && clearInterval(id));
  state.gridSnapIntervals = [null, null, null, null];

  // Assign default channels to cells (first N channels) if not already assigned
  for (let i = 0; i < 4; i++) {
    if (!state.gridCellChannels[i]) {
      state.gridCellChannels[i] = state.channels[i]?.id || null;
    }
  }

  // Populate channel pickers and start feeds
  const cells = document.querySelectorAll('.grid-cell');
  cells.forEach((cell, idx) => {
    const picker = cell.querySelector('.grid-channel-picker');

    // Populate picker options: blank + all channels
    picker.innerHTML = '<option value="">— empty —</option>' +
      state.channels.map(ch => {
        const name = ch.name || ch.inputPort || `Channel ${ch.id}`;
        const selected = state.gridCellChannels[idx] === ch.id ? ' selected' : '';
        return `<option value="${ch.id}"${selected}>${name}</option>`;
      }).join('');

    // Change handler
    picker.onchange = () => {
      state.gridCellChannels[idx] = picker.value || null;
      startGridCellFeed(idx, state.gridCellChannels[idx]);
    };

    // Maximize button handler
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

/** Switch back to single camera view. */
function switchToSingleView() {
  state.viewMode = 'single';

  // Stop all grid feeds
  state.gridSnapIntervals.forEach(id => id && clearInterval(id));
  state.gridSnapIntervals = [null, null, null, null];

  // Show single view, hide grid
  document.getElementById('canvasContainer').style.display = '';
  document.getElementById('gridView').style.display = 'none';

  // Restart single-camera feed if we have an active channel
  if (state.activeChannel) {
    startSnapshotFeed(state.activeChannel);
  }
}

// ─── Grid Cell Maximize ──────────────────────────────────────────────────────

/** Toggle maximize/restore for a single grid cell. */
function toggleMaximizeCell(cellIdx) {
  const gridEl = document.getElementById('gridView');
  const cells = document.querySelectorAll('.grid-cell');

  if (state.gridExpandedCell === cellIdx) {
    // Restore: remove maximized from grid + all cells
    gridEl.classList.remove('maximized');
    cells.forEach(c => c.classList.remove('maximized'));
    state.gridExpandedCell = null;
  } else {
    // Maximize: add maximized to grid + target cell
    gridEl.classList.add('maximized');
    cells.forEach(c => c.classList.remove('maximized'));
    cells[cellIdx].classList.add('maximized');
    state.gridExpandedCell = cellIdx;
  }
}

// ─── Motion Detection Grid <-> Hikvision Hex ────────────────────────────────
function gridToHex() {
  let hex = '';
  for (let r = 0; r < state.gridRows; r++) {
    let rowBits = '';
    for (let c = 0; c < state.gridCols; c++) {
      rowBits += state.grid[r][c] ? '1' : '0';
    }
    while (rowBits.length % 4 !== 0) rowBits += '0';
    for (let i = 0; i < rowBits.length; i += 4) {
      hex += parseInt(rowBits.substr(i, 4), 2).toString(16);
    }
  }
  return hex;
}

function hexToGrid(hexStr) {
  initGrid();
  if (!hexStr) return;

  const charsPerRow = Math.ceil(state.gridCols / 4);
  hexStr = hexStr.toLowerCase().replace(/[^0-9a-f]/g, '');

  for (let r = 0; r < state.gridRows; r++) {
    const rowHex = hexStr.substr(r * charsPerRow, charsPerRow);
    if (!rowHex) continue;

    let bits = '';
    for (let i = 0; i < rowHex.length; i++) {
      bits += parseInt(rowHex[i], 16).toString(2).padStart(4, '0');
    }
    for (let c = 0; c < state.gridCols; c++) {
      if (c < bits.length) {
        state.grid[r][c] = bits[c] === '1';
      }
    }
  }
}

function selectAllGrid() {
  for (let r = 0; r < state.gridRows; r++)
    for (let c = 0; c < state.gridCols; c++)
      state.grid[r][c] = true;
  redraw();
}

function clearAllGrid() {
  initGrid();
  redraw();
}

// ─── Toggles ────────────────────────────────────────────────────────────────
function toggleMotion() {
  state.motionEnabled = !state.motionEnabled;
  document.getElementById('motionToggle').classList.toggle('on', state.motionEnabled);
}

function togglePrivacy() {
  state.privacyEnabled = !state.privacyEnabled;
  document.getElementById('privacyToggle').classList.toggle('on', state.privacyEnabled);
}

// ─── Privacy Region List UI ─────────────────────────────────────────────────
function updatePrivacyRegionList() {
  const list = document.getElementById('privacyRegionList');
  list.innerHTML = state.privacyRegions.map((r, i) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:12px;font-family:var(--mono)">
      <span style="color:var(--text-dim)">Region ${i + 1}</span>
      <button class="btn btn-danger" style="padding:2px 8px;font-size:10px" data-delete="${i}">x</button>
    </div>
  `).join('');

  list.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.delete);
      state.privacyRegions.splice(idx, 1);
      updatePrivacyRegionList();
      redraw();
    });
  });
}

function clearAllPrivacy() {
  state.privacyRegions = [];
  updatePrivacyRegionList();
  redraw();
}

// ─── ISAPI: Load Motion Detection ───────────────────────────────────────────
async function loadMotionDetection() {
  if (!state.config || !state.activeChannel) return;
  setStatus('Loading motion detection config...');
  try {
    const data = await sendMsg({
      action: 'getMotionDetection',
      config: state.config,
      channelId: state.activeChannel,
    });

    const md = data.motionDetection;
    state.rawMotionXml = data.rawXml;

    state.motionEnabled = md.enabled === 'true';
    document.getElementById('motionToggle').classList.toggle('on', state.motionEnabled);

    const sensLayout = md.MotionDetectionLayout;
    if (sensLayout) {
      const sens = parseInt(sensLayout.sensitivityLevel) || 50;
      state.sensitivity = sens;
      document.getElementById('sensitivitySlider').value = sens;
      document.getElementById('sensitivityVal').textContent = sens;

      const gridMap = sensLayout.layout?.gridMap;
      if (gridMap) hexToGrid(gridMap);
    }

    if (md.Grid) {
      const rows = parseInt(md.Grid.rowGranularity);
      const cols = parseInt(md.Grid.columnGranularity);
      if (rows && cols) {
        state.gridRows = rows;
        state.gridCols = cols;
        if (sensLayout?.layout?.gridMap) {
          hexToGrid(sensLayout.layout.gridMap);
        }
      }
    }

    redraw();
    showToast('Motion detection config loaded', 'success');
    setStatus('Config loaded', `Channel ${state.activeChannel}`);
  } catch (err) {
    showToast('Failed to load motion config: ' + err.message, 'error');
    setStatus('Failed to load config');
  }
}

// ─── ISAPI: Save Motion Detection ───────────────────────────────────────────
async function saveMotionDetection() {
  if (!state.config || !state.activeChannel) return;

  const sensitivity = document.getElementById('sensitivitySlider').value;
  const hexGrid = gridToHex();

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<MotionDetection version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
  <enabled>${state.motionEnabled}</enabled>
  <enableHighlight>true</enableHighlight>
  <samplingInterval>2</samplingInterval>
  <startTriggerTime>500</startTriggerTime>
  <endTriggerTime>500</endTriggerTime>
  <regionType>grid</regionType>
  <Grid>
    <rowGranularity>${state.gridRows}</rowGranularity>
    <columnGranularity>${state.gridCols}</columnGranularity>
  </Grid>
  <MotionDetectionLayout version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
    <sensitivityLevel>${sensitivity}</sensitivityLevel>
    <layout>
      <gridMap>${hexGrid}</gridMap>
    </layout>
  </MotionDetectionLayout>
</MotionDetection>`;

  setStatus('Saving motion detection config...');
  try {
    await sendMsg({
      action: 'putMotionDetection',
      config: state.config,
      channelId: state.activeChannel,
      xml,
    });
    showToast('Motion detection saved successfully!', 'success');
    setStatus('Config saved', `Channel ${state.activeChannel}`);
  } catch (err) {
    showToast('Failed to save: ' + err.message, 'error');
    setStatus('Save failed');
  }
}

// ─── ISAPI: Load Privacy Mask ───────────────────────────────────────────────
async function loadPrivacyMask() {
  if (!state.config || !state.activeChannel) return;
  setStatus('Loading privacy mask config...');
  try {
    const data = await sendMsg({
      action: 'getPrivacyMask',
      config: state.config,
      channelId: state.activeChannel,
    });

    const pm = data.privacyMask;
    if (pm) {
      state.privacyEnabled = pm.enabled === 'true';
      document.getElementById('privacyToggle').classList.toggle('on', state.privacyEnabled);

      state.privacyRegions = [];
      let regions = pm.PrivacyMaskRegionList?.PrivacyMaskRegion;
      if (regions) {
        if (!Array.isArray(regions)) regions = [regions];
        regions.forEach(reg => {
          if (reg.enabled === 'true' && reg.RegionCoordinatesList) {
            let coords = reg.RegionCoordinatesList.RegionCoordinates;
            if (!Array.isArray(coords)) coords = coords ? [coords] : [];
            if (coords.length >= 2) {
              const xs = coords.map(c => parseInt(c.positionX) || 0);
              const ys = coords.map(c => parseInt(c.positionY) || 0);
              const minX = Math.min(...xs);
              const maxX = Math.max(...xs);
              const minY = Math.min(...ys);
              const maxY = Math.max(...ys);

              const normW = maxX > 1000 ? 10000 : 704;
              const normH = maxY > 1000 ? 10000 : 576;

              state.privacyRegions.push({
                x: (minX / normW) * canvas.width,
                y: (minY / normH) * canvas.height,
                w: ((maxX - minX) / normW) * canvas.width,
                h: ((maxY - minY) / normH) * canvas.height,
              });
            }
          }
        });
      }
    }

    updatePrivacyRegionList();
    redraw();
    showToast('Privacy mask config loaded', 'success');
    setStatus('Config loaded', `Channel ${state.activeChannel}`);
  } catch (err) {
    showToast('Failed to load privacy mask: ' + err.message, 'error');
    setStatus('Failed to load config');
  }
}

// ─── ISAPI: Save Privacy Mask ───────────────────────────────────────────────
async function savePrivacyMask() {
  if (!state.config || !state.activeChannel) return;

  const normW = 704;
  const normH = 576;

  let regionsXml = '';
  state.privacyRegions.forEach((reg, i) => {
    const x1 = Math.round((reg.x / canvas.width) * normW);
    const y1 = Math.round((reg.y / canvas.height) * normH);
    const x2 = Math.round(((reg.x + reg.w) / canvas.width) * normW);
    const y2 = Math.round(((reg.y + reg.h) / canvas.height) * normH);

    regionsXml += `
    <PrivacyMaskRegion>
      <id>${i + 1}</id>
      <enabled>true</enabled>
      <RegionCoordinatesList>
        <RegionCoordinates>
          <positionX>${x1}</positionX>
          <positionY>${y1}</positionY>
        </RegionCoordinates>
        <RegionCoordinates>
          <positionX>${x2}</positionX>
          <positionY>${y1}</positionY>
        </RegionCoordinates>
        <RegionCoordinates>
          <positionX>${x2}</positionX>
          <positionY>${y2}</positionY>
        </RegionCoordinates>
        <RegionCoordinates>
          <positionX>${x1}</positionX>
          <positionY>${y2}</positionY>
        </RegionCoordinates>
      </RegionCoordinatesList>
    </PrivacyMaskRegion>`;
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<PrivacyMask version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
  <enabled>${state.privacyEnabled}</enabled>
  <PrivacyMaskRegionList>
    ${regionsXml}
  </PrivacyMaskRegionList>
</PrivacyMask>`;

  setStatus('Saving privacy mask config...');
  try {
    await sendMsg({
      action: 'putPrivacyMask',
      config: state.config,
      channelId: state.activeChannel,
      xml,
    });
    showToast('Privacy mask saved successfully!', 'success');
    setStatus('Config saved', `Channel ${state.activeChannel}`);
  } catch (err) {
    showToast('Failed to save: ' + err.message, 'error');
    setStatus('Save failed');
  }
}

// ─── Event Listeners ────────────────────────────────────────────────────────

// Section tabs (primary navigation)
document.getElementById('liveViewSectionTab').addEventListener('click', () => switchSection('liveview'));
document.getElementById('configSectionTab').addEventListener('click', () => switchSection('config'));

// Live View sub-tabs
document.getElementById('singleViewTab').addEventListener('click', () => {
  state.viewMode = 'single';
  switchToLiveViewSingle();
});
document.getElementById('gridViewTab').addEventListener('click', switchToGridView);

// Config sub-tabs
document.getElementById('motionTab').addEventListener('click', () => switchTool('motion'));
document.getElementById('privacyTab').addEventListener('click', () => switchTool('privacy'));

// Config section collapse toggle
document.getElementById('configToggleBtn').addEventListener('click', toggleConfig);

// Scan flow
document.getElementById('startScanBtn').addEventListener('click', startScan);
document.getElementById('manualEntryBtn').addEventListener('click', showConnectionForm);
document.getElementById('cancelScanBtn').addEventListener('click', cancelScan);
document.getElementById('rescanBtn').addEventListener('click', startScan);
document.getElementById('manualAfterScanBtn').addEventListener('click', showConnectionForm);
document.getElementById('backToScanBtn').addEventListener('click', showScanIntro);

document.getElementById('connectBtn').addEventListener('click', connect);
document.getElementById('disconnectBtn').addEventListener('click', disconnect);
document.getElementById('motionToggle').addEventListener('click', toggleMotion);
document.getElementById('privacyToggle').addEventListener('click', togglePrivacy);
document.getElementById('selectAllBtn').addEventListener('click', selectAllGrid);
document.getElementById('clearAllBtn').addEventListener('click', clearAllGrid);
document.getElementById('loadMotionBtn').addEventListener('click', loadMotionDetection);
document.getElementById('saveMotionBtn').addEventListener('click', saveMotionDetection);
document.getElementById('clearPrivacyBtn').addEventListener('click', clearAllPrivacy);
document.getElementById('loadPrivacyBtn').addEventListener('click', loadPrivacyMask);
document.getElementById('savePrivacyBtn').addEventListener('click', savePrivacyMask);

document.getElementById('sensitivitySlider').addEventListener('input', function () {
  document.getElementById('sensitivityVal').textContent = this.value;
});

// Allow Enter key to connect
document.getElementById('passInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') connect();
});

window.addEventListener('resize', () => {
  resizeCanvas();
  redraw();
});

document.addEventListener('keydown', (e) => {
  // Don't capture shortcuts when typing in inputs
  if (e.target.tagName === 'INPUT') return;

  // Context-dependent number shortcuts
  if (e.key === '1') {
    if (state.activeSection === 'liveview') {
      state.viewMode = 'single';
      switchToLiveViewSingle();
    } else {
      switchTool('motion');
    }
  }
  if (e.key === '2') {
    if (state.activeSection === 'liveview') {
      switchToGridView();
    } else {
      switchTool('privacy');
    }
  }

  if (e.key === 'a' && e.ctrlKey) { e.preventDefault(); selectAllGrid(); }

  if (e.key === 'Escape') {
    // First: restore maximized grid cell
    if (state.gridExpandedCell !== null) {
      toggleMaximizeCell(state.gridExpandedCell);
    } else {
      clearAllGrid();
    }
  }
});

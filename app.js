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

    await loadChannels();
    btn.textContent = 'Reconnect';
  } catch (err) {
    showToast('Connection failed: ' + err.message, 'error');
    setStatus('Connection failed');
    document.getElementById('statusDot').classList.remove('connected');
  } finally {
    btn.disabled = false;
    if (btn.querySelector('.loading')) btn.textContent = 'Connect';
  }
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
    document.getElementById('toolConfigSection').style.display = 'block';
    document.getElementById('toolTabs').style.display = 'flex';

    if (state.channels.length > 0) {
      selectChannel(state.channels[0].id, list.children[0]);
    }
  } catch (err) {
    showToast('Failed to load channels: ' + err.message, 'error');
  }
}

async function selectChannel(channelId, element) {
  document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
  if (element) element.classList.add('active');

  state.activeChannel = channelId;
  initGrid();
  state.privacyRegions = [];

  startSnapshotFeed(channelId);
  loadMotionDetection();
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
  if (state.activeTool === 'motion') {
    drawMotionGrid();
  } else if (state.activeTool === 'privacy') {
    drawPrivacyMask();
  }
}

function drawMotionGrid() {
  const cellW = canvas.width / state.gridCols;
  const cellH = canvas.height / state.gridRows;

  for (let r = 0; r < state.gridRows; r++) {
    for (let c = 0; c < state.gridCols; c++) {
      const x = c * cellW;
      const y = r * cellH;

      if (state.grid[r][c]) {
        ctx.fillStyle = 'rgba(74, 108, 247, 0.4)';
        ctx.fillRect(x, y, cellW, cellH);
        ctx.strokeStyle = 'rgba(74, 108, 247, 0.7)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);
      } else {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(x, y, cellW, cellH);
      }
    }
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

canvas.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const pos = getCanvasPos(e);

  if (state.activeTool === 'motion') {
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
  document.querySelectorAll('.tool-tab').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tool-panel').forEach(el => el.classList.remove('active'));

  if (tool === 'motion') {
    document.getElementById('motionTab').classList.add('active');
    document.getElementById('motionPanel').classList.add('active');
  } else {
    document.getElementById('privacyTab').classList.add('active');
    document.getElementById('privacyPanel').classList.add('active');
  }
  redraw();
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
document.getElementById('connectBtn').addEventListener('click', connect);
document.getElementById('motionToggle').addEventListener('click', toggleMotion);
document.getElementById('privacyToggle').addEventListener('click', togglePrivacy);
document.getElementById('motionTab').addEventListener('click', () => switchTool('motion'));
document.getElementById('privacyTab').addEventListener('click', () => switchTool('privacy'));
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
  if (e.key === '1') switchTool('motion');
  if (e.key === '2') switchTool('privacy');
  if (e.key === 'a' && e.ctrlKey) { e.preventDefault(); selectAllGrid(); }
  if (e.key === 'Escape') clearAllGrid();
});

// ─── Config ────────────────────────────────────────────────────────────────
const SERVER_HOST    = window.location.hostname || "localhost";
const SERVER_URL_BASE = `http://${SERVER_HOST}:8000`;
const API_URL        = `${SERVER_URL_BASE}/data`;
const LOGIN_URL      = `${SERVER_URL_BASE}/login`;
const WS_BASE_URL    = `ws://${SERVER_HOST}:8000/ws`;

// Buffers for live charts
const MAX_CHART_POINTS = 40;
let liveTempHistory     = [];  // {time, temp}
let liveHotspotHistory  = [];  // {time, count}

let isConnected  = false;
let tempChart    = null;
let hotspotChart = null;
let zoneChart    = null;   // Zone temperature trend chart
let reconnectTimer = null;
let ws           = null;

// ─── Camera Connection Tracking ───────────────────────────────────────────
const CAMERA_TIMEOUT_MS  = 5000;   // 5 seconds without frames = disconnected
let lastFrameTime        = 0;      // timestamp of last received frame
let cameraConnected      = false;  // current camera state
let cameraWatchdogTimer  = null;   // interval ID for the watchdog
let authToken    = localStorage.getItem('dreamvision_token');

// ─── DOM Elements ─────────────────────────────────────────────────────────
const loginView    = document.getElementById('login-view');
const dashboardView = document.getElementById('dashboard-view');
const loginForm    = document.getElementById('login-form');
const loginError   = document.getElementById('login-error');
const logoutBtn    = document.getElementById('logout-btn');

// ─── Chart Initialisation ─────────────────────────────────────────────────
function initChart() {
    if (typeof Chart === 'undefined') {
        console.warn("Chart.js not loaded.");
        return;
    }

    // ── Temperature Trend ──────────────────────────────────────────
    const tempCanvas = document.getElementById('tempChart');
    if (tempCanvas) {
        const ctx = tempCanvas.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 0, 300);
        gradient.addColorStop(0, 'rgba(0, 210, 255, 0.5)');
        gradient.addColorStop(1, 'rgba(0, 210, 255, 0.02)');

        tempChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: 'Max Temp (°C)',
                    data: [],
                    borderColor: '#00d2ff',
                    backgroundColor: gradient,
                    borderWidth: 2,
                    pointBackgroundColor: '#00d2ff',
                    pointBorderColor: '#fff',
                    pointRadius: 3,
                    pointHoverRadius: 6,
                    fill: true,
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 250 },
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: c => c.parsed.y + '°C' } }
                },
                scales: {
                    x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#8b92a5', maxTicksLimit: 8 } },
                    y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#8b92a5' }, beginAtZero: false, suggestedMin: 25, suggestedMax: 100 }
                }
            }
        });
    }

    // ── Hotspot Count Trend ────────────────────────────────────────
    const hsCanvas = document.getElementById('hotspotChart');
    if (hsCanvas) {
        const hsCtx = hsCanvas.getContext('2d');
        const hsGrad = hsCtx.createLinearGradient(0, 0, 0, 300);
        hsGrad.addColorStop(0, 'rgba(255, 75, 75, 0.45)');
        hsGrad.addColorStop(1, 'rgba(255, 75, 75, 0.02)');

        hotspotChart = new Chart(hsCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: 'Hotspot Count',
                    data: [],
                    borderColor: '#ff4b4b',
                    backgroundColor: hsGrad,
                    borderWidth: 2,
                    pointBackgroundColor: '#ff4b4b',
                    pointBorderColor: '#fff',
                    pointRadius: 3,
                    pointHoverRadius: 6,
                    fill: true,
                    tension: 0.4,
                    stepped: false
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 250 },
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: c => `${c.parsed.y} hotspots` } }
                },
                scales: {
                    x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#8b92a5', maxTicksLimit: 8 } },
                    y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#8b92a5', precision: 0 }, beginAtZero: true }
                }
            }
        });
    }
}

// ─── Push one frame point into both live charts ───────────────────────────
function pushLivePoint(temp, hotspotCount, timeLabel) {
    liveTempHistory.push({ t: timeLabel, v: temp });
    liveHotspotHistory.push({ t: timeLabel, v: hotspotCount });

    if (liveTempHistory.length > MAX_CHART_POINTS)     liveTempHistory.shift();
    if (liveHotspotHistory.length > MAX_CHART_POINTS)  liveHotspotHistory.shift();

    if (tempChart) {
        tempChart.data.labels = liveTempHistory.map(p => p.t);
        tempChart.data.datasets[0].data = liveTempHistory.map(p => p.v);
        tempChart.update('none');   // 'none' = no animation for speed
    }

    if (hotspotChart) {
        hotspotChart.data.labels = liveHotspotHistory.map(p => p.t);
        hotspotChart.data.datasets[0].data = liveHotspotHistory.map(p => p.v);
        hotspotChart.update('none');
    }
}

// ─── Live Metrics Bar ─────────────────────────────────────────────────────
let lastLivePushTime = null;

function updateLiveMetrics(reading) {
    if (!reading) return;

    const maxTemp    = reading.temperature;
    const avgTemp    = reading.avg_temp || '--';
    const status     = reading.status || '--';

    // Parse hotspot count
    let hotspotCount = 0;
    if (reading.hotspots) {
        let hs = reading.hotspots;
        if (typeof hs === 'string') { try { hs = JSON.parse(hs); } catch(e) { hs = []; } }
        hotspotCount = Array.isArray(hs) ? hs.length : 0;
    }

    const elMax     = document.getElementById('metric-max-temp');
    const elAvg     = document.getElementById('metric-avg-temp');
    const elHs      = document.getElementById('metric-hotspots');
    const elStatus  = document.getElementById('metric-status');
    const elCard    = document.getElementById('metric-status-card');

    if (elMax)    elMax.textContent = `${maxTemp}°C`;
    if (elAvg)    elAvg.textContent = typeof avgTemp === 'number' ? `${avgTemp.toFixed(1)}°C` : avgTemp;
    if (elHs)     elHs.textContent  = hotspotCount;

    if (elStatus) {
        elStatus.textContent = status;
        let c = 'var(--ok)';
        if (status === 'FIRE RISK' || status === 'NOK') c = 'var(--alert)';
        else if (status === 'DANGER') c = '#ff4b4b';
        else if (status === 'WARNING') c = '#ffc107';
        
        elStatus.style.color = c;
    }
    if (elCard) {
        let bc = 'var(--ok)';
        if (status === 'FIRE RISK' || status === 'NOK') bc = 'var(--alert)';
        else if (status === 'DANGER') bc = '#ff4b4b';
        else if (status === 'WARNING') bc = '#ffc107';
        elCard.style.borderColor = bc;
    }

    // Time label for chart (HH:MM:SS)
    const now  = reading.timestamp ? reading.timestamp.split(' ')[1] : new Date().toLocaleTimeString();
    
    // Only append to chart if this is a NEW frame (filters out spam)
    if (now !== lastLivePushTime) {
        pushLivePoint(maxTemp, hotspotCount, now);
        lastLivePushTime = now;
    }
}

// ─── Historical charts + status list ──────────────────────────────────────
function updateStatus(data) {
    const statusList = document.getElementById("status-list");
    if (!statusList) return;
    statusList.innerHTML = "";

    // Grab latest reading per machine
    const machines = {};
    for (const entry of data) {
        if (!machines[entry.machine_name]) machines[entry.machine_name] = entry;
    }

    const latestEntries = Object.values(machines).sort((a, b) => a.machine_name.localeCompare(b.machine_name));

    if (latestEntries.length === 0) {
        statusList.innerHTML = "<li><p class='loading'>No data available yet...</p></li>";
        return;
    }

    latestEntries.forEach(entry => {
        const li = document.createElement("li");
        
        let color = 'var(--ok)';
        let badgeClass = 'status-ok';
        
        if (entry.status === 'FIRE RISK' || entry.status === 'NOK') { color = 'var(--alert)'; badgeClass = 'status-nok'; }
        else if (entry.status === 'DANGER') { color = '#ff4b4b'; badgeClass = 'status-nok'; }
        else if (entry.status === 'WARNING') { color = '#ffc107'; badgeClass = 'status-warning'; }
        
        li.style.borderLeftColor = color;
        li.innerHTML = `
            <div>
                <strong style="color:white;font-size:1.05rem;">${entry.machine_name}</strong>
                <div style="color:var(--text-muted);font-size:0.85rem;margin-top:0.3rem;">Last updated: ${entry.timestamp}</div>
            </div>
            <div style="display:flex;align-items:center;gap:1rem;">
                <span style="font-size:1.1rem;font-weight:500;">${entry.temperature}°C</span>
                <span class="${badgeClass}" ${entry.status === 'WARNING' ? 'style="background:rgba(255,193,7,0.1);color:#ffc107;border-color:rgba(255,193,7,0.3);"' : ''}>${entry.status}</span>
            </div>
        `;
        statusList.appendChild(li);
    });
}

// ─── Alert List ──────────────────────────────────────────────────────────
function updateAlerts(data) {
    const alertList = document.getElementById("alert-list");
    const badge     = document.getElementById("alert-badge");
    if (!alertList) return;

    alertList.innerHTML = "";
    // Filter out OK/SAFE
    const alerts = data.filter(d => ['NOK', 'WARNING', 'DANGER', 'FIRE RISK'].includes(d.status)).slice(0, 5);

    if (alerts.length > 0) {
        badge.innerText = alerts.length;
        badge.classList.remove("hidden");
    } else {
        badge.classList.add("hidden");
        alertList.innerHTML = "<li><p style='color:var(--ok);'>✓ No active alerts. All machines operating normally.</p></li>";
        return;
    }

    alerts.forEach(alert => {
        const li = document.createElement("li");
        let color = "var(--alert)";
        let bg = "var(--alert-bg)";
        let icon = "⚠️";
        
        if (alert.status === 'WARNING') {
            color = "#ffc107";
            bg = "rgba(255, 193, 7, 0.1)";
            icon = "🟡";
        } else if (alert.status === 'FIRE RISK') {
            icon = "🔥";
        }
        
        li.style.borderLeftColor = color;
        li.style.backgroundColor = bg;
        li.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;width:100%;">
                <div style="display:flex;align-items:center;gap:0.8rem;">
                    <span style="font-size:1.5rem;">${icon}</span>
                    <div>
                        <strong style="color:white;">${alert.machine_name} — ${alert.status}</strong>
                        <div style="color:var(--text-muted);font-size:0.85rem;margin-top:0.2rem;">${alert.timestamp}</div>
                    </div>
                </div>
                <div style="display:flex;align-items:center;gap:1rem;">
                    <span style="color:${color};font-weight:bold;font-size:1.1rem;">${alert.temperature}°C</span>
                    <button class="btn-small" onclick="downloadReport(${alert.id})" style="background:${color};padding:4px 8px;font-size:0.75rem;color:#000;">Export PDF</button>
                </div>
            </div>
        `;
        alertList.appendChild(li);
    });
}

// ─── Incident History Panel ────────────────────────────────────────────────
function updateIncidentHistory(data) {
    const list = document.getElementById('incident-list');
    if (!list) return;

    const nok = data.filter(d => d.status === 'NOK').slice(0, 10);

    if (nok.length === 0) {
        list.innerHTML = "<li><p style='color:var(--ok);'>✓ No overheating incidents recorded.</p></li>";
        return;
    }

    list.innerHTML = "";
    nok.forEach(entry => {
        const div = document.createElement('div');
        div.className = 'incident-item';

        const thumbHtml = entry.thermal_image && entry.thermal_image.startsWith('/images/')
            ? `<img class="incident-thumb" src="${SERVER_URL_BASE}${entry.thermal_image}" alt="thermal" onerror="this.style.display='none'" />`
            : `<div class="incident-thumb-placeholder">🔥</div>`;

        div.innerHTML = `
            ${thumbHtml}
            <div class="incident-info">
                <div class="incident-machine">${entry.machine_name}</div>
                <div class="incident-meta">${entry.timestamp} · ID #${entry.id}</div>
            </div>
            <div class="incident-temp">${entry.temperature}°C</div>
        `;
        list.appendChild(div);
    });
}

// ─── PDF Download ──────────────────────────────────────────────────────────
async function downloadReport(id) {
    if (!authToken) return;
    try {
        const response = await fetch(`${SERVER_URL_BASE}/report/${id}`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (!response.ok) throw new Error("Report failed");
        const blob = await response.blob();
        const url  = window.URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url;
        a.download = `incident_report_${id}.pdf`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        a.remove();
    } catch (e) {
        alert("Failed to generate PDF report.");
    }
}

// ─── Camera Connection Status ─────────────────────────────────────────────
function updateCameraStatus(connected) {
    const badge     = document.getElementById('camera-status');
    const text      = document.getElementById('camera-status-text');
    const container = document.getElementById('feed-container');

    if (!badge || !text) return;

    if (connected && !cameraConnected) {
        // Transition: disconnected → connected
        badge.className = 'camera-status connected';
        text.textContent = 'Connected';
        cameraConnected = true;

        // Remove disconnect overlay if present
        const overlay = container?.querySelector('.feed-disconnected-overlay');
        if (overlay) overlay.remove();
    } else if (!connected && cameraConnected) {
        // Transition: connected → disconnected
        badge.className = 'camera-status disconnected';
        text.textContent = 'No Connection';
        cameraConnected = false;

        // Add disconnect overlay on top of frozen feed
        if (container && !container.querySelector('.feed-disconnected-overlay')) {
            const overlay = document.createElement('div');
            overlay.className = 'feed-disconnected-overlay';
            overlay.innerHTML = `
                <span class="disconnect-icon">📡</span>
                <span class="disconnect-text">Camera Disconnected. Monitoring Stopped.</span>
            `;
            container.appendChild(overlay);
        }

        // Alert Worker automatically on disconnect
        speakAlert("Critical Warning! Thermal camera disconnected. Monitoring has stopped.");
        addTimelineEvent('📡', `SYSTEM ALERT`, `Thermal camera connection lost.`, 'alert');

        // Turn worker safety bar grey/disconnected state
        const bar = document.getElementById('worker-safety-bar');
        const icon = document.getElementById('safety-icon');
        const level = document.getElementById('safety-level');
        const detail = document.getElementById('safety-detail');
        if (bar) {
            bar.className = 'safety-bar'; // remove safe/warning/danger classes
            bar.style.background = 'rgba(255,255,255,0.05)';
            bar.style.borderColor = 'rgba(255,255,255,0.1)';
            if (icon) icon.textContent = '⚪';
            if (level) {
                level.textContent = 'MONITORING OFFLINE';
                level.style.color = '#fff';
            }
            if (detail) detail.textContent = 'Camera disconnected. Please check connection.';
        }
    }
}

function startCameraWatchdog() {
    if (cameraWatchdogTimer) clearInterval(cameraWatchdogTimer);
    cameraWatchdogTimer = setInterval(() => {
        if (lastFrameTime === 0) {
            // Never received a live frame — keep showing disconnected
            updateCameraStatus(false);
        } else if (Date.now() - lastFrameTime > CAMERA_TIMEOUT_MS) {
            // Frames stopped arriving for 5+ seconds
            updateCameraStatus(false);
        }
    }, 1000);
}

// ─── Check if incoming WebSocket data contains a live ESP32 frame ─────────
function checkForLiveESP32Frame(data) {
    // Look for ESP32_THERMAL_CAM entries with any image data
    // The camera reader uploads via thermal_image (base64) and the backend
    // attaches live_image_b64 to the latest entry in the broadcast.
    const liveFrame = data.findLast(d =>
        d.machine_name === "ESP32_THERMAL_CAM" &&
        (d.live_image_b64 || d.thermal_image)
    );
    if (liveFrame) {
        lastFrameTime = Date.now();
        updateCameraStatus(true);
        return true;
    }
    return false;
}

// ─── Live Feed Renderer ───────────────────────────────────────────────────
function updateLiveFeed(data) {
    // Only show live feed if camera is connected (receiving live frames)
    if (!cameraConnected) return;

    // Prioritize ESP32 hardware camera; fallback to latest any-machine reading
    const hardwareFeed = data.findLast(d => d.machine_name === "ESP32_THERMAL_CAM" && (d.thermal_image || d.live_image_b64));
    const latestReading = hardwareFeed || data[data.length - 1];

    if (latestReading && (latestReading.thermal_image || latestReading.live_image_b64)) {
        document.getElementById('feed-status-text').style.display = 'none';
        const img = document.getElementById('thermal-image');

        if (latestReading.live_image_b64) {
            img.src = "data:image/jpeg;base64," + latestReading.live_image_b64;
        } else if (latestReading.thermal_image && latestReading.thermal_image.startsWith('/images/')) {
            img.src = SERVER_URL_BASE + latestReading.thermal_image + `?t=${Date.now()}`;
        } else if (latestReading.thermal_image) {
            img.src = "data:image/jpeg;base64," + latestReading.thermal_image;
        }

        img.style.display = 'block';
        document.getElementById('feed-machine').innerText = `(${latestReading.machine_name})`;
        drawHotspots(latestReading);

        // Update live metrics from this frame
        updateLiveMetrics(latestReading);
    }
}

// ─── Hotspot Overlay Drawing ───────────────────────────────────────────────
function drawHotspots(reading) {
    const canvas = document.getElementById('hotspot-overlay');
    const img    = document.getElementById('thermal-image');
    const ctx    = canvas.getContext('2d');

    if (!reading.hotspots) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }

    let hotspots = reading.hotspots;
    if (typeof hotspots === 'string') {
        try { hotspots = JSON.parse(hotspots); } catch(e) { hotspots = []; }
    }

    if (!img.complete) { img.onload = () => drawHotspots(reading); return; }

    canvas.width  = img.clientWidth;
    canvas.height = img.clientHeight;
    canvas.style.left = img.offsetLeft + 'px';
    canvas.style.top  = img.offsetTop  + 'px';
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const camWidth  = 80;
    const camHeight = 62;
    const scaleX = canvas.width  / camWidth;
    const scaleY = canvas.height / camHeight;

    hotspots.forEach((hs, i) => {
        const x = hs.x * scaleX;
        const y = hs.y * scaleY;
        const w = hs.w * scaleX;
        const h = hs.h * scaleY;

        ctx.strokeStyle = i === 0 ? '#ff4b4b' : '#ffaa00';
        ctx.lineWidth   = i === 0 ? 2.5 : 1.5;
        ctx.strokeRect(x, y, w, h);

        ctx.fillStyle = i === 0 ? '#ff4b4b' : '#ffaa00';
        ctx.font      = `bold ${Math.max(9, scaleX * 6)}px Inter, sans-serif`;
        ctx.fillText(`${hs.max_val}°C`, x + 2, Math.max(y - 3, 10));
    });
}

// ─── Hotspot List Panel ────────────────────────────────────────────────────
function updateHotspotList(data) {
    const list = document.getElementById('hotspot-list');
    if (!list) return;

    // Show hotspots from the LATEST reading with any hotspots
    const latest = data.findLast(d => {
        let hs = d.hotspots;
        if (typeof hs === 'string') { try { hs = JSON.parse(hs); } catch(e) { hs = []; } }
        return Array.isArray(hs) && hs.length > 0;
    });

    if (!latest) {
        list.innerHTML = "<li><p style='color:var(--ok);'>✓ No active hotspots detected.</p></li>";
        return;
    }

    let hotspots = latest.hotspots;
    if (typeof hotspots === 'string') { try { hotspots = JSON.parse(hotspots); } catch(e) { hotspots = []; } }

    list.innerHTML = "";
    hotspots.slice(0, 5).forEach((hs, i) => {
        const li = document.createElement('li');
        const isHot = hs.max_val > 60;
        li.style.borderLeftColor = isHot ? 'var(--alert)' : '#ffaa00';
        li.innerHTML = `
            <div>
                <strong>Hotspot #${i + 1}</strong>
                <div style="font-size:0.8rem;color:var(--text-muted);margin-top:0.2rem;">
                    Loc: (${hs.x}, ${hs.y}) | Area: ${hs.area}px
                </div>
            </div>
            <span style="color:${isHot ? 'var(--alert)' : '#ffaa00'};font-weight:bold;font-size:1.05rem;">${hs.max_val}°C</span>
        `;
        list.appendChild(li);
    });
}

// ─── Factory Map ──────────────────────────────────────────────────────────
const machinePositions = {
    "Motor A":           { x: 20, y: 30 },
    "Motor B":           { x: 50, y: 20 },
    "Motor C":           { x: 80, y: 40 },
    "Conveyor Belt":     { x: 40, y: 70 },
    "Pump Unit":         { x: 75, y: 80 },
    "ESP32_THERMAL_CAM": { x: 15, y: 15 }
};

function updateFactoryMap(data) {
    const container = document.getElementById("map-nodes");
    if (!container) return;

    const machines = {};
    for (const entry of data) {
        if (!machines[entry.machine_name]) machines[entry.machine_name] = entry;
    }

    container.innerHTML = "";

    Object.keys(machinePositions).forEach(name => {
        const entry = machines[name];
        const pos   = machinePositions[name];

        const node = document.createElement('div');
        node.className = 'map-node';
        node.style.left = `${pos.x}%`;
        node.style.top  = `${pos.y}%`;

        const isSafe = !entry || ['OK', 'SAFE'].includes(entry.status);
        const isWarn = entry?.status === 'WARNING';
        const isDanger = entry?.status === 'DANGER' || entry?.status === 'FIRE RISK' || entry?.status === 'NOK';
        
        const cls = !entry ? 'node-unknown' : isDanger ? 'node-nok' : isWarn ? 'node-warning' : 'node-ok';
        const tip = entry ? `${name}\n${entry.temperature}°C — ${entry.status}` : `${name}: No Data`;

        node.classList.add(cls);
        const tooltip = document.createElement('div');
        tooltip.className = 'tooltip';
        tooltip.innerText = tip;
        node.appendChild(tooltip);
        container.appendChild(node);
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// ██  SMART DANGER ZONE DETECTION
// ═══════════════════════════════════════════════════════════════════════════

// Zone configuration — each zone is linked to a machine
const dangerZones = [
    { id: 'zone-motor-a',     name: 'Motor A Zone',       machine: 'Motor A',       threshold: 85,  x: 20, y: 30, radius: 55, currentTemp: 0, state: 'safe', lastAlertTime: 0, distance: 0, direction: '' },
    { id: 'zone-motor-b',     name: 'Motor B Zone',       machine: 'Motor B',       threshold: 85,  x: 50, y: 20, radius: 55, currentTemp: 0, state: 'safe', lastAlertTime: 0, distance: 0, direction: '' },
    { id: 'zone-motor-c',     name: 'Motor C Zone',       machine: 'Motor C',       threshold: 85,  x: 80, y: 40, radius: 55, currentTemp: 0, state: 'safe', lastAlertTime: 0, distance: 0, direction: '' },
    { id: 'zone-conveyor',    name: 'Conveyor Zone',      machine: 'Conveyor Belt', threshold: 80,  x: 40, y: 70, radius: 60, currentTemp: 0, state: 'safe', lastAlertTime: 0, distance: 0, direction: '' },
    { id: 'zone-pump',        name: 'Pump Unit Zone',     machine: 'Pump Unit',     threshold: 90,  x: 75, y: 80, radius: 55, currentTemp: 0, state: 'safe', lastAlertTime: 0, distance: 0, direction: '' },
];

const CAMERA_POS = { x: 50, y: 95 }; // Bottom-center reference

// ─── Spatial Helpers ──────────────────────────────────────────────────────
function calculateBearing(targetX, targetY) {
    const dx = targetX - CAMERA_POS.x;
    const dy = CAMERA_POS.y - targetY; // Invert Y as 0 is top
    const angle = (Math.atan2(dx, dy) * 180) / Math.PI;
    const normalized = (angle + 360) % 360;

    const directions = [
        { label: 'North', min: 337.5, max: 360 },
        { label: 'North', min: 0, max: 22.5 },
        { label: 'North-East', min: 22.5, max: 67.5 },
        { label: 'East', min: 67.5, max: 112.5 },
        { label: 'South-East', min: 112.5, max: 157.5 },
        { label: 'South', min: 157.5, max: 202.5 },
        { label: 'South-West', min: 202.5, max: 247.5 },
        { label: 'West', min: 247.5, max: 292.5 },
        { label: 'North-West', min: 292.5, max: 337.5 }
    ];

    const match = directions.find(d => normalized >= d.min && normalized < d.max);
    return match ? match.label : 'North';
}

function calculateDistance(targetX, targetY) {
    const dx = targetX - CAMERA_POS.x;
    const dy = targetY - CAMERA_POS.y;
    const pixelDist = Math.sqrt(dx * dx + dy * dy);
    return (pixelDist * 0.15).toFixed(1); // Rough mapping: 1% UI ≈ 0.15 meters
}

let zoneChartHistory = {};   // { zoneName: [{t, v}] }
const MAX_ZONE_POINTS = 30;
const ZONE_COLORS = ['#00d2ff', '#ff4b4b', '#00e676', '#ffaa00', '#a855f7'];
let userRole = 'operator';   // set on login

// ─── Determine zone state from temperature ────────────────────────────────
function getZoneState(temp, threshold) {
    if (temp >= threshold)            return 'danger';
    if (temp >= threshold * 0.70)     return 'warning';
    return 'safe';
}

// ─── Render danger zone circles on the map ────────────────────────────────
function renderDangerZoneCircles() {
    const container = document.getElementById('danger-zones');
    if (!container) return;
    container.innerHTML = '';

    dangerZones.forEach(zone => {
        const el = document.createElement('div');
        el.className = `danger-zone-circle zone-${zone.state}`;
        el.id = zone.id;
        el.style.left   = `${zone.x}%`;
        el.style.top    = `${zone.y}%`;
        el.style.width   = `${zone.radius}px`;
        el.style.height  = `${zone.radius}px`;

        el.innerHTML = `
            <span class="zone-temp">${zone.currentTemp > 0 ? zone.currentTemp.toFixed(1) + '°C' : '--'}</span>
            <span class="zone-label">${zone.name}</span>
        `;
        container.appendChild(el);
    });
}

// ─── Render zone status cards ─────────────────────────────────────────────
function renderZoneStatusCards() {
    const container = document.getElementById('zone-cards');
    if (!container) return;
    container.innerHTML = '';

    dangerZones.forEach(zone => {
        const pct = zone.threshold > 0 ? Math.min((zone.currentTemp / zone.threshold) * 100, 120) : 0;
        const barColor = zone.state === 'danger' ? 'var(--alert)' :
                         zone.state === 'warning' ? '#ffaa00' : 'var(--ok)';

        // Calculate spatial metrics
        zone.direction = calculateBearing(zone.x, zone.y);
        zone.distance = calculateDistance(zone.x, zone.y);

        const card = document.createElement('div');
        card.className = `zone-card ${zone.state}`;
        card.innerHTML = `
            <div class="zone-card-header">
                <span class="zone-card-name">${zone.name}</span>
                <span class="zone-card-badge ${zone.state}">
                    ${zone.state === 'danger' ? '🔴 DANGER' : zone.state === 'warning' ? '🟡 WARNING' : '🟢 SAFE'}
                </span>
            </div>
            <div class="zone-card-body">
                <span class="label">Current</span>
                <span class="value" style="color:${barColor}">${zone.currentTemp > 0 ? zone.currentTemp.toFixed(1) + '°C' : '--'}</span>
                <span class="label">Orientation</span>
                <span class="value">${zone.direction}</span>
                <span class="label">Distance</span>
                <span class="value">${zone.distance}m</span>
                <span class="label">Machine</span>
                <span class="value">${zone.machine}</span>
            </div>
            <div class="zone-temp-bar">
                <div class="zone-temp-bar-fill" style="width:${Math.min(pct, 100)}%;background:${barColor};"></div>
            </div>
        `;
        container.appendChild(card);
    });
}

// ─── Fire danger toast notification ───────────────────────────────────────
function fireDangerToast(zone) {
    const container = document.getElementById('danger-toast-container');
    if (!container) return;

    // Rate-limit: max 1 toast per zone per 15 seconds
    const now = Date.now();
    if (now - zone.lastAlertTime < 15000) return;
    zone.lastAlertTime = now;

    const toast = document.createElement('div');
    toast.className = 'danger-toast';
    toast.innerHTML = `
        <span class="toast-icon">🚨</span>
        <div class="toast-body">
            <div class="toast-title">⚠️ DANGER ZONE: ${zone.name}</div>
            <div class="toast-detail">${zone.machine} at ${zone.currentTemp.toFixed(1)}°C (limit: ${zone.threshold}°C)</div>
        </div>
    `;
    container.appendChild(toast);

    // Play alert beep
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.frequency.value = 880;
        osc.type = 'square';
        gain.gain.value = 0.1;
        osc.start();
        osc.stop(audioCtx.currentTime + 0.15);
    } catch (e) { /* audio not available */ }

    // Auto-remove after animation completes
    setTimeout(() => { if (toast.parentElement) toast.remove(); }, 5500);
}

// ─── Main danger zone update — called on every data push ──────────────────
function updateDangerZones(data) {
    // Build latest temps per machine
    const machines = {};
    for (const entry of data) {
        if (!machines[entry.machine_name]) machines[entry.machine_name] = entry;
    }

    let dangerCount = 0;
    const timeLabel = new Date().toLocaleTimeString();
    
    // Attempt to compute ROI-specific temperatures based on backend Hotspots
    const cameraEntry = machines["ESP32_THERMAL_CAM"];
    let camHotspots = [];
    if (cameraEntry && cameraEntry.hotspots) {
        try {
            camHotspots = typeof cameraEntry.hotspots === 'string' ? JSON.parse(cameraEntry.hotspots) : cameraEntry.hotspots;
        } catch(e) { camHotspots = []; }
    }
    // Scale for ROI calculations
    const scaleX = 800 / 80;   // Assumed frontend overlay width/camera width
    const scaleY = 600 / 62;

    dangerZones.forEach((zone, i) => {
        let localMaxTemp = 0;

        // ROI Spatial Calculation (if using live feed hotspots)
        if (camHotspots.length > 0) {
            // Map percentage based UI coordinates to rough pixel spatial coordinates
            const zx = (zone.x / 100) * 800; // rough px mapping
            const zy = (zone.y / 100) * 600;
            
            camHotspots.forEach(hs => {
                const hx = hs.x * scaleX;
                const hy = hs.y * scaleY;
                const hw = hs.w * scaleX;
                const hh = hs.h * scaleY;
                
                // Simple bounding box intersection with zone circle
                // If rect center is near circle center
                const cx = hx + hw/2;
                const cy = hy + hh/2;
                const dist = Math.sqrt(Math.pow(cx - zx, 2) + Math.pow(cy - zy, 2));
                
                if (dist < zone.radius * 2) {
                    localMaxTemp = Math.max(localMaxTemp, hs.max_val);
                }
            });
        }
        
        // Fallback: If no spatial data matches, use the machine's global temp (simulator behavior)
        if (localMaxTemp === 0) {
            const entry = machines[zone.machine];
            if (entry) localMaxTemp = entry.temperature;
        }

        if (localMaxTemp > 0) {
            zone.currentTemp = localMaxTemp;
        }

        const newState = getZoneState(zone.currentTemp, zone.threshold);

        // Fire toast on transition TO danger
        if (newState === 'danger' && zone.state !== 'danger') {
            fireDangerToast(zone);
        }

        zone.state = newState;
        if (newState === 'danger') dangerCount++;

        // Track history for zone chart
        if (!zoneChartHistory[zone.name]) zoneChartHistory[zone.name] = [];
        // Only append if it's a new timeLabel
        const hist = zoneChartHistory[zone.name];
        if (hist.length === 0 || hist[hist.length-1].t !== timeLabel) {
            hist.push({ t: timeLabel, v: zone.currentTemp });
            if (hist.length > MAX_ZONE_POINTS) hist.shift();
        }
    });

    // Update zone alert count badge
    const badge = document.getElementById('zone-alert-count');
    if (badge) {
        if (dangerCount > 0) {
            badge.textContent = dangerCount;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }

    renderDangerZoneCircles();
    renderZoneStatusCards();
    updateZoneChart();
    renderDirectionalLayer();
}

function renderDirectionalLayer() {
    const layer = document.getElementById('directional-layer');
    if (!layer) return;
    
    // Clear existing arrows
    const existing = layer.querySelectorAll('.guide-arrow');
    existing.forEach(e => e.remove());

    // Only draw arrows for warning/danger zones
    dangerZones.forEach(zone => {
        if (zone.state === 'safe') return;

        const x1 = `${CAMERA_POS.x}%`;
        const y1 = `${CAMERA_POS.y}%`;
        const x2 = `${zone.x}%`;
        const y2 = `${zone.y}%`;

        const arrow = document.createElementNS("http://www.w3.org/2000/svg", "line");
        arrow.setAttribute("x1", x1);
        arrow.setAttribute("y1", y1);
        arrow.setAttribute("x2", x2);
        arrow.setAttribute("y2", y2);
        arrow.setAttribute("class", "guide-arrow");
        arrow.setAttribute("marker-end", "url(#arrowhead)");
        
        // Change color based on severity
        if (zone.state === 'warning') {
            arrow.style.stroke = '#ffaa00';
            arrow.style.filter = 'drop-shadow(0 0 5px rgba(255,170,0,0.5))';
        }

        layer.appendChild(arrow);
    });
}

// ─── Zone Temperature Trend Chart ─────────────────────────────────────────
function initZoneChart() {
    const canvas = document.getElementById('zoneChart');
    if (!canvas || typeof Chart === 'undefined') return;

    const ctx = canvas.getContext('2d');
    const datasets = dangerZones.map((zone, i) => ({
        label: zone.name,
        data: [],
        borderColor: ZONE_COLORS[i % ZONE_COLORS.length],
        backgroundColor: 'transparent',
        borderWidth: 2,
        pointRadius: 2,
        pointHoverRadius: 5,
        tension: 0.4
    }));

    zoneChart = new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 200 },
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: { color: '#8b92a5', boxWidth: 12, font: { size: 11 } }
                },
                tooltip: {
                    callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y.toFixed(1)}°C` }
                }
            },
            scales: {
                x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#8b92a5', maxTicksLimit: 8 } },
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#8b92a5' }, beginAtZero: false, suggestedMin: 25, suggestedMax: 100 }
            }
        }
    });
}

function updateZoneChart() {
    if (!zoneChart) return;

    // Use labels from the first zone
    const firstZone = dangerZones[0];
    const history   = zoneChartHistory[firstZone.name] || [];
    zoneChart.data.labels = history.map(p => p.t);

    dangerZones.forEach((zone, i) => {
        const h = zoneChartHistory[zone.name] || [];
        zoneChart.data.datasets[i].data = h.map(p => p.v);
    });

    zoneChart.update('none');
}

// ─── Admin Threshold Controls ─────────────────────────────────────────────
function initAdminControls() {
    const controlsDiv = document.getElementById('admin-zone-controls');
    const slidersDiv  = document.getElementById('threshold-sliders');
    if (!controlsDiv || !slidersDiv) return;

    // Only show for admin role
    if (userRole !== 'admin') {
        controlsDiv.classList.add('hidden');
        return;
    }
    controlsDiv.classList.remove('hidden');
    slidersDiv.innerHTML = '';

    dangerZones.forEach(zone => {
        const row = document.createElement('div');
        row.className = 'threshold-row';
        row.innerHTML = `
            <label>${zone.name}</label>
            <input type="range" min="50" max="150" value="${zone.threshold}"
                   data-zone-id="${zone.id}" />
            <span class="threshold-val">${zone.threshold}°C</span>
        `;

        const slider = row.querySelector('input[type="range"]');
        const valSpan = row.querySelector('.threshold-val');
        slider.addEventListener('input', () => {
            const newVal = parseInt(slider.value);
            zone.threshold = newVal;
            valSpan.textContent = `${newVal}°C`;
        });

        slidersDiv.appendChild(row);
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// ██  ADVANCED HACKATHON FEATURES
// ═══════════════════════════════════════════════════════════════════════════

// ─── Voice Alarm System ───────────────────────────────────────────────────
let voiceEnabled = false;
let lastVoiceAlert = 0;

function speakAlert(message) {
    if (!voiceEnabled) return;
    if (Date.now() - lastVoiceAlert < 10000) return; // Rate limit: 10s
    lastVoiceAlert = Date.now();
    try {
        const utterance = new SpeechSynthesisUtterance(message);
        utterance.rate = 1.1;
        utterance.pitch = 0.9;
        utterance.volume = 1;
        speechSynthesis.cancel(); // Stop any current speech
        speechSynthesis.speak(utterance);
    } catch (e) { /* Speech not available */ }
}

function toggleVoice() {
    voiceEnabled = !voiceEnabled;
    const btn = document.getElementById('voice-toggle');
    if (btn) {
        btn.textContent = voiceEnabled ? '🔊 Voice ON' : '🔇 Voice OFF';
        btn.className = `btn-small voice-btn ${voiceEnabled ? 'active' : 'muted'}`;
    }
    if (voiceEnabled) speakAlert('Voice alerts activated.');
}

// ─── AI Predictive Maintenance ────────────────────────────────────────────
// Uses historical trend delta to predict overheating patterns reliably
let tempHistoryPerMachine = {};   // { machineName: [temp1, temp2, ...] }
const PRED_HISTORY_SIZE = 15;     // How many data points to track
const PRED_UPDATE_INTERVAL = 2;   // Update interval in seconds (from simulator)

// Keep linearRegression for updateForecastLine (zone chart)
function linearRegression(values) {
    const n = values.length;
    if (n < 3) return { slope: 0, intercept: values[n - 1] || 0, r2: 0 };
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    for (let i = 0; i < n; i++) {
        sumX  += i;
        sumY  += values[i];
        sumXY += i * values[i];
        sumX2 += i * i;
        sumY2 += values[i] * values[i];
    }
    const slope     = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    const denom     = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    const r2        = denom === 0 ? 0 : Math.pow((n * sumXY - sumX * sumY) / denom, 2);
    return { slope, intercept, r2 };
}

function predictOverheating(machineHistory, threshold) {
    const n = machineHistory.length;
    const currentTemp = machineHistory[n - 1];
    
    // Ensure we have enough history to make a stable claim
    if (n < 5) {
        return { trend: 'stable', predictedTime: null, currentTemp, slope: 0, delta: 0 };
    }

    // Historical trend delta (compare current to oldest tracked point)
    const oldestTemp = machineHistory[0];
    const trendDelta = currentTemp - oldestTemp;
    
    // Average step size (slope proxy)
    const avgStep = trendDelta / n;

    // Determine trend
    let trend = 'stable';
    if (trendDelta > 5) trend = 'rising';     // Increased by 5+ degrees over history window
    else if (trendDelta < -5) trend = 'falling';

    // Predict time to reach threshold (if rising significantly)
    let predictedTime = null;
    if (trend === 'rising' && currentTemp < threshold && avgStep > 0) {
        const stepsToThreshold = (threshold - currentTemp) / avgStep;
        if (stepsToThreshold > 0 && stepsToThreshold < 500) {
            predictedTime = Math.round(stepsToThreshold * PRED_UPDATE_INTERVAL / 60); // minutes
        }
    }

    return { trend, predictedTime, currentTemp, slope: avgStep.toFixed(2), delta: trendDelta.toFixed(1) };
}

function updatePredictions(data) {
    // Update history per machine
    const machines = {};
    for (const entry of data) {
        if (entry.machine_name && entry.temperature) {
            machines[entry.machine_name] = entry;
        }
    }

    Object.entries(machines).forEach(([name, entry]) => {
        if (!tempHistoryPerMachine[name]) tempHistoryPerMachine[name] = [];
        tempHistoryPerMachine[name].push(entry.temperature);
        if (tempHistoryPerMachine[name].length > PRED_HISTORY_SIZE) {
            tempHistoryPerMachine[name].shift();
        }
    });

    // Render prediction cards
    const container = document.getElementById('prediction-cards');
    if (!container) return;
    container.innerHTML = '';

    dangerZones.forEach(zone => {
        const history = tempHistoryPerMachine[zone.machine];
        if (!history || history.length < 3) return;

        const pred = predictOverheating(history, zone.threshold);
        const card = document.createElement('div');
        card.className = 'pred-card';

        let predictionHtml = '';
        if (pred.predictedTime !== null && pred.predictedTime > 0) {
            const timeStr = pred.predictedTime < 60
                ? `${pred.predictedTime} min`
                : `${(pred.predictedTime / 60).toFixed(1)} hrs`;
            predictionHtml = `<div class="pred-warning">⚠️ Possible overheating in ${timeStr}</div>`;

            // Voice alert for imminent overheating
            if (pred.predictedTime <= 5) {
                speakAlert(`Warning! ${zone.machine} predicted to overheat in ${pred.predictedTime} minutes.`);
            }
        } else if (pred.trend === 'falling') {
            predictionHtml = `<div class="pred-safe">✓ Temperature decreasing</div>`;
        } else {
            predictionHtml = `<div class="pred-safe">✓ Operating within safe range</div>`;
        }

        card.innerHTML = `
            <div class="pred-card-header">
                <span class="pred-card-name">${zone.machine}</span>
                <span class="pred-card-trend ${pred.trend}">
                    ${pred.trend === 'rising' ? '↑ Rising' : pred.trend === 'falling' ? '↓ Falling' : '→ Stable'}
                </span>
            </div>
            <div class="pred-card-body">
                <span class="pred-temp">${pred.currentTemp.toFixed(1)}°C</span>
                <span style="color:var(--text-muted);"> / ${zone.threshold}°C limit</span>
                <br>Delta: ${pred.delta > 0 ? '+' : ''}${pred.delta}°C over history (${pred.slope}°C/Step)
                ${predictionHtml}
            </div>
        `;
        container.appendChild(card);
    });
}

// ─── Automatic Fire Detection ─────────────────────────────────────────────
let previousTemps = {};   // Track previous temps to detect spikes
const FIRE_SPIKE_THRESHOLD = 30;   // °C increase = fire risk

let firePersistTicks = {};         // { machine: contiguous frames above threshold }
let lastFireAlerts = {};           // { machine: timestamp of last fired popup }
const FIRE_ABS_THRESHOLD = 120;
const FIRE_PERSIST_REQUIRED = 3;   // Must be above threshold for 3 consecutive updates
const FIRE_COOLDOWN_MS = 15000;    // Don't show popup again for 15s per machine

let fireAlertActive = false;

function detectFireRisk(data) {
    const machines = {};
    for (const entry of data) {
        if (entry.machine_name && entry.temperature) machines[entry.machine_name] = entry;
    }
    
    const now = Date.now();

    Object.entries(machines).forEach(([name, entry]) => {
        const prevTemp = previousTemps[name] || entry.temperature;
        const spike = entry.temperature - prevTemp;
        previousTemps[name] = entry.temperature;

        // Count persistence
        if (entry.temperature >= FIRE_ABS_THRESHOLD) {
            firePersistTicks[name] = (firePersistTicks[name] || 0) + 1;
        } else {
            firePersistTicks[name] = 0; // reset
        }
        
        // Check cooldown
        const lastAlert = lastFireAlerts[name] || 0;
        const isCooldownOver = (now - lastAlert) > FIRE_COOLDOWN_MS;

        if (isCooldownOver && !fireAlertActive) {
            // Trigger if huge sudden spike OR persistent extreme temperature
            if (spike >= FIRE_SPIKE_THRESHOLD || firePersistTicks[name] >= FIRE_PERSIST_REQUIRED) {
                lastFireAlerts[name] = now;
                triggerFireAlert(name, entry.temperature, spike);
            }
        }
    });
}

function triggerFireAlert(machineName, temp, spike) {
    fireAlertActive = true;
    const overlay = document.getElementById('fire-alert-overlay');
    const details = document.getElementById('fire-details');
    if (overlay && details) {
        details.innerHTML = `
            <strong>Location:</strong> ${machineName}<br>
            <strong>Temperature:</strong> ${temp.toFixed(1)}°C
            ${spike > 0 ? `<br><strong>Spike:</strong> +${spike.toFixed(1)}°C rapid increase` : ''}
        `;
        overlay.classList.remove('hidden');
    }

    speakAlert(`Fire risk detected! ${machineName} at ${Math.round(temp)} degrees. Evacuate the area immediately.`);

    addTimelineEvent('🔥', `FIRE RISK: ${machineName}`, `Temperature: ${temp.toFixed(1)}°C`, 'fire');

    // Auto-dismiss after 15 seconds
    setTimeout(() => { dismissFireAlert(); }, 15000);
}

function dismissFireAlert() {
    fireAlertActive = false;
    const overlay = document.getElementById('fire-alert-overlay');
    if (overlay) overlay.classList.add('hidden');
}

// ─── Thermal Event Timeline ───────────────────────────────────────────────
let timelineEvents = [];
const MAX_TIMELINE_EVENTS = 50;
let lastTimelineTemp = {};  // debounce per machine

function addTimelineEvent(icon, title, detail, type) {
    const time = new Date().toLocaleTimeString();
    timelineEvents.unshift({ icon, title, detail, time, type });
    if (timelineEvents.length > MAX_TIMELINE_EVENTS) timelineEvents.pop();
    renderTimeline();
}

function renderTimeline() {
    const container = document.getElementById('timeline-container');
    const countBadge = document.getElementById('timeline-count');
    if (!container) return;

    if (timelineEvents.length === 0) {
        container.innerHTML = '<p class="loading">No thermal events recorded yet...</p>';
        return;
    }

    container.innerHTML = timelineEvents.map(e => `
        <div class="timeline-event">
            <span class="timeline-icon">${e.icon}</span>
            <div class="timeline-body">
                <div class="timeline-title">${e.title}</div>
                <div class="timeline-detail">${e.detail}</div>
            </div>
            <span class="timeline-time">${e.time}</span>
        </div>
    `).join('');

    if (countBadge) {
        countBadge.textContent = timelineEvents.length;
        countBadge.classList.remove('hidden');
    }
}

function updateTimeline(data) {
    const machines = {};
    for (const entry of data) {
        if (entry.machine_name) machines[entry.machine_name] = entry;
    }

    Object.entries(machines).forEach(([name, entry]) => {
        const prevTemp = lastTimelineTemp[name];
        lastTimelineTemp[name] = entry.temperature;

        // Log significant events only (debounce similar temps)
        if (prevTemp !== undefined && Math.abs(entry.temperature - prevTemp) < 2) return;

        if (entry.status === 'NOK' || entry.temperature >= 80) {
            const icon = entry.temperature >= 100 ? '🔴' : entry.temperature >= 80 ? '🟡' : '⚠️';
            addTimelineEvent(icon, `${name} — ${entry.temperature.toFixed(1)}°C`,
                `Status: ${entry.status} | Avg: ${entry.avg_temp || '—'}°C`, 'alert');
        }
    });
}

// ─── Maintenance Recommendations ──────────────────────────────────────────
const MAINTENANCE_RULES = [
    { minTemp: 90,  actions: ['🔴 Shut down immediately', '🔧 Emergency inspection required', '❄️ Deploy cooling systems'] },
    { minTemp: 80,  actions: ['🟡 Schedule maintenance within 24h', '🔧 Check lubrication levels', '🔍 Inspect bearings and belts'] },
    { minTemp: 70,  actions: ['📋 Monitor closely', '🔧 Routine maintenance recommended', '🧴 Check coolant levels'] },
    { minTemp: 0,   actions: ['✅ Normal operation', '📅 Next scheduled maintenance on time'] },
];

function updateRecommendations(data) {
    const container = document.getElementById('recommendation-list');
    if (!container) return;

    const machines = {};
    for (const entry of data) {
        if (entry.machine_name) machines[entry.machine_name] = entry;
    }

    const entries = Object.entries(machines).filter(([n]) => n !== 'ESP32_THERMAL_CAM');
    if (entries.length === 0) {
        container.innerHTML = '<p class="loading">Waiting for data...</p>';
        return;
    }

    container.innerHTML = '';
    entries.forEach(([name, entry]) => {
        const temp = entry.temperature || 0;
        const rule = MAINTENANCE_RULES.find(r => temp >= r.minTemp);
        const severity = temp >= 90 ? 'urgent' : temp >= 80 ? 'moderate' : 'normal';

        const card = document.createElement('div');
        card.className = `rec-card rec-${severity}`;
        card.innerHTML = `
            <div class="rec-machine">${name} — ${temp.toFixed(1)}°C</div>
            <ul class="rec-items">
                ${rule.actions.map(a => `<li>${a}</li>`).join('')}
            </ul>
        `;
        container.appendChild(card);
    });
}

// ─── Worker Safety Status Bar ─────────────────────────────────────────────
function updateWorkerSafety() {
    const bar     = document.getElementById('worker-safety-bar');
    const icon    = document.getElementById('safety-icon');
    const level   = document.getElementById('safety-level');
    const detail  = document.getElementById('safety-detail');
    const sSafe   = document.getElementById('stat-safe');
    const sWarn   = document.getElementById('stat-warning');
    const sDanger = document.getElementById('stat-danger');
    if (!bar) return;

    let safe = 0, warning = 0, danger = 0;
    dangerZones.forEach(z => {
        if (z.state === 'danger') danger++;
        else if (z.state === 'warning') warning++;
        else safe++;
    });

    sSafe.textContent   = safe;
    sWarn.textContent   = warning;
    sDanger.textContent = danger;

    if (danger > 0) {
        bar.className = 'safety-bar safety-danger';
        icon.textContent = '🔴';
        level.textContent = '⚠️ DANGER — STAY AWAY FROM AREA';
        detail.textContent = `${danger} zone(s) exceeded temperature threshold. Worker safety at risk.`;
        speakAlert(`Danger! ${danger} zone${danger > 1 ? 's' : ''} in critical condition. Stay away from the area.`);
    } else if (warning > 0) {
        bar.className = 'safety-bar safety-warning';
        icon.textContent = '🟡';
        level.textContent = 'WARNING — MACHINES OVERHEATING';
        detail.textContent = `${warning} zone(s) approaching temperature threshold. Exercise caution.`;
    } else {
        bar.className = 'safety-bar safety-safe';
        icon.textContent = '🟢';
        level.textContent = 'ALL SYSTEMS SAFE';
        detail.textContent = 'All zones operating within normal parameters.';
    }
}

// ─── Heat Trend Forecast on Zone Chart ────────────────────────────────────
function updateForecastLine() {
    if (!zoneChart || !zoneChart.data.datasets.length) return;

    // Add/update a forecast dataset for each zone
    dangerZones.forEach((zone, i) => {
        const history = zoneChartHistory[zone.name] || [];
        if (history.length < 5) return;

        const temps = history.map(h => h.v);
        const { slope, intercept } = linearRegression(temps);
        const n = temps.length;

        // Predict 5 future points
        const forecastDatasetIndex = dangerZones.length + i;
        let forecastDataset = zoneChart.data.datasets[forecastDatasetIndex];

        if (!forecastDataset) {
            forecastDataset = {
                label: `${zone.name} (forecast)`,
                data: [],
                borderColor: ZONE_COLORS[i % ZONE_COLORS.length],
                backgroundColor: 'transparent',
                borderWidth: 1.5,
                borderDash: [5, 5],
                pointRadius: 0,
                tension: 0.4
            };
            zoneChart.data.datasets.push(forecastDataset);
        }

        // Fill with nulls for existing points, then forecast values
        const forecastPoints = new Array(n).fill(null);
        for (let f = 0; f < 5; f++) {
            const predicted = slope * (n + f) + intercept;
            forecastPoints.push(Math.max(0, Math.min(predicted, 200)));
        }
        forecastDataset.data = forecastPoints;
    });

    // Extend labels for forecast points
    const currentLabels = zoneChart.data.labels.length;
    const neededLabels = (zoneChartHistory[dangerZones[0]?.name]?.length || 0) + 5;
    while (zoneChart.data.labels.length < neededLabels) {
        zoneChart.data.labels.push('→');
    }
}

// ─── Master update function for all advanced features ─────────────────────
function updateAdvancedFeatures(data) {
    if (!cameraConnected) return; // Halt analytics if camera is offline

    updatePredictions(data);
    detectFireRisk(data);
    updateTimeline(data);
    updateRecommendations(data);
    updateWorkerSafety();
    updateForecastLine();
}

// ─── Connection Status ─────────────────────────────────────────────────────
function updateConnectionStatus(connected) {
    const indicator = document.querySelector('.status-indicator');
    const text      = document.getElementById('connection-status');
    if (!indicator || !text) return;

    if (connected) {
        indicator.className = 'status-indicator connected';
        text.innerText = 'Server Connected (Live Stream)';
        text.style.color = 'var(--ok)';
        isConnected = true;
        if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
    } else {
        indicator.className = 'status-indicator disconnected';
        isConnected = false;

        // Show countdown until next reconnect attempt
        let secs = 3;
        text.innerText = `Disconnected — Reconnecting in ${secs}s...`;
        text.style.color = 'var(--alert)';
        if (reconnectTimer) clearInterval(reconnectTimer);
        reconnectTimer = setInterval(() => {
            secs--;
            if (secs <= 0) {
                clearInterval(reconnectTimer);
                reconnectTimer = null;
                text.innerText = 'Reconnecting...';
            } else {
                text.innerText = `Disconnected — Reconnecting in ${secs}s...`;
            }
        }, 1000);
    }
}

// ─── Data Load (initial REST fetch) ───────────────────────────────────────
async function loadData() {
    if (!authToken) return;
    try {
        const res = await fetch(API_URL, { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (res.status === 401) { handleLogout(); return; }
        if (!res.ok) throw new Error("Fetch failed");

        const data = await res.json();
        updateConnectionStatus(true);
        updateStatus(data);
        updateAlerts(data);
        // NOTE: Do NOT call updateLiveFeed here — historical data should not
        // trigger "Connected" status.  The live feed only starts when real-time
        // WebSocket frames arrive from the ESP32 camera.
        updateFactoryMap(data);
        updateHotspotList(data);
        // Initialize danger zones from historical data
        updateDangerZones(data);
        
        // Ensure UI reflects initial disconnected state
        updateCameraStatus(false);
    } catch (e) {
        console.error("Load data error:", e);
        updateConnectionStatus(false);
    }
}

// ─── WebSocket ────────────────────────────────────────────────────────────
function initWebSocket() {
    if (!authToken) return;
    const wsUrl = `${WS_BASE_URL}?token=${authToken}`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => { updateConnectionStatus(true); };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        // Check if this WebSocket push contains a live ESP32 camera frame
        // This is the ONLY place that can mark the camera as "Connected"
        checkForLiveESP32Frame(data);

        // ONLY process real-time analytics and monitoring if the camera is actually sending frames
        if (cameraConnected) {
            updateStatus(data);
            updateAlerts(data);
            updateLiveFeed(data);        // Renders visual feed and hotspots
            updateFactoryMap(data);
            updateHotspotList(data);
            updateIncidentHistory(data);
            updateDangerZones(data);     // Update danger zones with live data
            updateAdvancedFeatures(data); // Run AI predictions, fire detection, timeline, etc
        }
    };

    ws.onclose = () => {
        updateConnectionStatus(false);
        setTimeout(initWebSocket, 3000);   // Auto-reconnect after 3s
    };

    ws.onerror = () => { ws.close(); };
}

// ─── Auth ──────────────────────────────────────────────────────────────────
function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const formData = new URLSearchParams();
    formData.append('username', username);
    formData.append('password', password);

    fetch(LOGIN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: formData })
        .then(r => { if (!r.ok) throw new Error('Invalid'); return r.json(); })
        .then(d => {
            authToken = d.access_token;
            localStorage.setItem('dreamvision_token', authToken);
            userRole = d.role;   // Store role for admin detection
            document.getElementById('user-role').innerText = d.role.toUpperCase();
            showDashboard();
        })
        .catch(() => loginError.classList.remove('hidden'));
}

function showDashboard() {
    loginView.style.display  = 'none';
    dashboardView.style.display = 'block';
    try { initChart(); } catch (e) { console.error("Chart init error:", e); }
    try { initZoneChart(); } catch (e) { console.error("Zone chart init error:", e); }
    renderDangerZoneCircles();  // Initial render of zones
    renderZoneStatusCards();    // Initial render of zone cards
    initAdminControls();       // Show threshold sliders for admin
    loadData();
    initWebSocket();
    startCameraWatchdog();     // Begin monitoring frame arrivals
}

function handleLogout() {
    localStorage.removeItem('dreamvision_token');
    authToken = null;
    if (ws) ws.close();
    if (reconnectTimer) clearInterval(reconnectTimer);
    if (cameraWatchdogTimer) clearInterval(cameraWatchdogTimer);
    cameraConnected = false;
    lastFrameTime = 0;
    voiceEnabled = false;
    timelineEvents = [];
    tempHistoryPerMachine = {};
    previousTemps = {};
    dashboardView.style.display = 'none';
    loginView.style.display     = 'flex';
}

// ─── Boot ──────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
    loginForm.addEventListener('submit', handleLogin);
    logoutBtn.addEventListener('click', handleLogout);
    // Voice toggle button
    const voiceBtn = document.getElementById('voice-toggle');
    if (voiceBtn) voiceBtn.addEventListener('click', toggleVoice);
    if (authToken) showDashboard();
});

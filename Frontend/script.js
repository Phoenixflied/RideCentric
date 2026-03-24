const API_BASE = "";
let map;

function getAuthToken() {
    return localStorage.getItem('ridecentric_token');
}

function requireAuth() {
    const token = getAuthToken();
    if (!token) {
        window.location.href = '/app/login.html';
        return null;
    }
    return token;
}

document.addEventListener("DOMContentLoaded", () => {
    if (!requireAuth()) return;
    initClock();
    initMap();
    setupEventListeners();
    fetchFlights("ALL");
});

function initClock() {
    setInterval(() => {
        const el = document.getElementById('clock');
        if (el) el.innerText = new Date().toLocaleTimeString('en-US', { hour12: false });
    }, 1000);
}

function initMap() {
    // Ensuring the map div exists before loading
    const mapDiv = document.getElementById('map');
    if (mapDiv) {
        map = L.map('map').setView([25.7617, -80.1918], 12); 
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '© OpenStreetMap'
        }).addTo(map);
    }
}

function setupEventListeners() {
    // Manual Flight Form Submission
    const form = document.getElementById('manual-flight-form');
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const payload = {
                id: `M-${Date.now()}`,
                flight: document.getElementById('m-flight').value,
                arrival_time: document.getElementById('m-arrival').value,
                date: document.getElementById('m-date').value,
                ride_no: `MAN-${Math.floor(Math.random() * 9000)}`,
                terminal: document.getElementById('m-term').value || "TBD",
                gate: document.getElementById('m-gate').value || "TBD",
                status: "SCHEDULED"
            };

            try {
                const token = getAuthToken();
                const res = await fetch(`${API_BASE}/api/add_manual?token=${token}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (!res.ok) {
                    let errText = res.statusText;
                    try {
                        const errJson = await res.json();
                        errText = errJson.detail || errText;
                    } catch (e) {
                        // If not JSON
                    }
                    throw new Error(errText);
                }
                document.getElementById('manual-modal-v3').style.display = 'none';
                form.reset();
                fetchFlights("ALL");
            } catch (err) {
                console.error("Submission failed", err);
                alert("Add flight failed: " + err.message);
            }
        });
    }

    // Date Picker
    const datePicker = document.getElementById('date-picker');
    if (datePicker) {
        datePicker.addEventListener('change', () => {
            const selectedDate = datePicker.value;
            if (selectedDate) {
                fetchFlights(selectedDate);
            } else {
                fetchFlights("ALL");
            }
        });
    }
}

async function fetchFlights(date = "ALL") {
    const panel = document.getElementById('data-panel');
    if (panel) panel.classList.add('loading');
    try {
        const token = requireAuth();
        if (!token) return;
        const res = await fetch(`${API_BASE}/api/flights?date=${date}&token=${token}`);
        if (!res.ok) {
            let errText = res.statusText;
            try {
                const errJson = await res.json();
                errText = errJson.detail || errText;
            } catch (e) {
                // If not JSON, use statusText
            }
            throw new Error(errText);
        }
        const data = await res.json();
        renderDashboard(data);
    } catch (err) {
        console.error("Connection to API failed.", err);
        alert("Flight load failed: " + err.message);
    } finally {
        if (panel) panel.classList.remove('loading');
    }
}

function renderDashboard(rides) {
    const panel = document.getElementById('data-panel');
    if (!panel) return;
    panel.innerHTML = '';

    const grouped = {};
    rides.forEach(r => {
        if (!grouped[r.date]) grouped[r.date] = [];
        grouped[r.date].push(r);
    });

    for (const [date, list] of Object.entries(grouped)) {
        const block = document.createElement('div');
        block.className = 'station-block';
        block.innerHTML = `<div class="station-header">📅 ${date}</div><div class="flight-list"></div>`;
        
        list.forEach(ride => {
            const card = document.createElement('div');
            card.className = 'flight-card search-target';
            card.innerHTML = `
                <div style="padding:15px;">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span style="color:#10ffbe; font-weight:800; font-size:1.1rem;">✈️ ${ride.flight}</span>
                        <span style="color:#666; font-size:0.75rem;">#${ride.ride_no}</span>
                    </div>
                    <div style="margin:10px 0;">Arrival: ${ride.arrival_time}</div>
                    <div style="display:grid; grid-template-columns:1fr 1fr; font-size:0.7rem; color:#888; border-top:1px solid #222; padding-top:8px;">
                        <span>Term: ${ride.terminal}</span>
                        <span>Gate: ${ride.gate}</span>
                    </div>
                    <div style="margin-top:5px; color:#10ffbe; font-weight:bold; font-size:0.65rem;">STATUS: ${ride.status}</div>
                </div>`;
            card.addEventListener('click', () => showFlightDetails(ride));
            block.querySelector('.flight-list').appendChild(card);
        });
        panel.appendChild(block);
    }
}

async function forceScan() {
    const status = document.getElementById('scan-status');
    if (!requireAuth()) return;
    if (status) status.innerText = "⚡ Scanning...";
    const token = getAuthToken();
    await fetch(`${API_BASE}/api/scan_manifests?token=${token}`, { method: 'POST' });
    if (status) status.innerText = "✅ Updated";
    fetchFlights("ALL");
}

function filterSearch() {
    const q = document.getElementById('search-bar').value.toLowerCase();
    document.querySelectorAll('.search-target').forEach(c => {
        const text = c.innerText.toLowerCase();
        c.style.display = text.includes(q) ? 'block' : 'none';
    });
}

function logout() {
    localStorage.removeItem('ridecentric_token');
    window.location.href = '/app/login.html';
}

function showAllFlights() {
    const datePicker = document.getElementById('date-picker');
    if (datePicker) datePicker.value = '';
    fetchFlights("ALL");
}

function showFlightDetails(ride) {
    const modal = document.getElementById('flight-details-modal');
    if (!modal) return;
    modal.querySelector('.detail-flight').innerText = ride.flight;
    modal.querySelector('.detail-ride').innerText = ride.ride_no;
    modal.querySelector('.detail-date').innerText = ride.date;
    modal.querySelector('.detail-arrival').innerText = ride.arrival_time;
    modal.querySelector('.detail-terminal').innerText = ride.terminal;
    modal.querySelector('.detail-gate').innerText = ride.gate;
    modal.querySelector('.detail-status').innerText = ride.status;
    modal.querySelector('.detail-passenger').innerText = ride.passenger || 'N/A';
    modal.style.display = 'flex';
}

function closeFlightDetails() {
    const modal = document.getElementById('flight-details-modal');
    if (modal) modal.style.display = 'none';
}
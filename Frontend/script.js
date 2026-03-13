// ----------------------
// Authentication
// ----------------------
if (!localStorage.getItem('ridecentric_token')) {
    window.location.href = 'login.html';
}

function logout() {
    localStorage.removeItem('ridecentric_token');
    window.location.href = 'login.html';
}

// ----------------------
// Map & Flight Data
// ----------------------
let map;
let allData = {};
let activeRouteLayers = [];

// ----------------------
// On Page Load
// ----------------------
document.addEventListener("DOMContentLoaded", async () => {
    initMap();
    startClock();

    const datePicker = document.getElementById('date-picker');
    datePicker.valueAsDate = new Date();
    datePicker.addEventListener('change', fetchFlights);

    await fetchFlights(); // Load today's flights automatically
});

// ----------------------
// Initialize Map
// ----------------------
function initMap() {
    map = L.map('map', { zoomControl: false }).setView([35.0, -95.0], 4);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png').addTo(map);
}

// ----------------------
// Clock
// ----------------------
function startClock() {
    setInterval(() => {
        document.getElementById('clock').innerText = new Date().toLocaleTimeString('en-US', { hour12: false });
    }, 1000);
}

// ----------------------
// Format Date
// ----------------------
function getFormattedDate() {
    const dateValue = document.getElementById('date-picker').value;
    if (!dateValue) return ""; 
    const parts = dateValue.split('-'); // yyyy-mm-dd
    return `${parts[1]}/${parts[2]}/${parts[0]}`; // mm/dd/yyyy
}

// ----------------------
// Fetch Flights
// ----------------------
async function fetchFlights() {
    const targetDate = getFormattedDate() || "ALL";
    try {
        const res = await fetch(`/api/flights?date=${encodeURIComponent(targetDate)}`);
        if (!res.ok) throw new Error("Network error");
        allData = await res.json();
        renderStations(allData);
    } catch (e) {
        console.error("System Offline", e);
        const panel = document.getElementById('data-panel');
        panel.innerHTML = '<div style="color:var(--muted); padding:20px; font-weight: 600;">System Offline or No Flights Found.</div>';
    }
}

// ----------------------
// Render Flights by Station
// ----------------------
function renderStations(dataObject) {
    const panel = document.getElementById('data-panel');
    panel.innerHTML = '';

    if (!dataObject || Object.keys(dataObject).length === 0) {
        panel.innerHTML = '<div style="color:var(--muted); padding:20px; font-weight: 600;">No flights found for selected date.</div>';
        return;
    }

    for (const [station, flights] of Object.entries(dataObject)) {
        if (!flights || flights.length === 0) continue;

        const block = document.createElement('div');
        block.className = 'station-block';
        block.innerHTML = `
            <div class="station-header">
                <div class="station-title">📍 Station: ${station}</div>
                <div class="weather-chip" id="weather-${station}">Loading...</div>
            </div>
            <div class="flight-list"></div>
        `;
        panel.appendChild(block);

        const listContainer = block.querySelector('.flight-list');
        flights.forEach(f => {
            const card = document.createElement('div');
            card.className = 'flight-card search-target';
            card.setAttribute('data-flight', f.flight.toLowerCase());

            const details = f.live_details || { status_text: "OFFLINE", terminal: "TBD", gate: "TBD", baggage: "TBD", aircraft: "UNK", eta: "TBD", accuracy: "N/A" };

            let badgeColor = "rgba(255,255,255,0.1)";
            let textColor = "white";
            let statusLabel = details.status_text;

            if(statusLabel.includes("LANDED")) { badgeColor = "rgba(148, 163, 184, 0.2)"; textColor = "#94a3b8"; }
            if(statusLabel.includes("EN ROUTE")) { badgeColor = "rgba(73, 119, 255, 0.2)"; textColor = "#4977ff"; }
            if(statusLabel.includes("ON TIME")) { badgeColor = "rgba(16, 255, 190, 0.2)"; textColor = "#10ffbe"; }
            if(statusLabel.includes("DELAYED")) { badgeColor = "rgba(239, 68, 68, 0.2)"; textColor = "#ef4444"; }
            if(statusLabel.includes("OFFLINE")) { badgeColor = "rgba(255, 165, 0, 0.2)"; textColor = "#ffa500"; }

            card.innerHTML = `
                <div style="width:100%">
                    <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:10px; margin-bottom:15px;">
                        <div>
                            <div class="flight-no">✈️ ${f.flight}</div>
                            <div class="flight-airline">${f.airline} • ${f.run_type}</div>
                        </div>
                        <div style="text-align:right; padding-right:30px;">
                            <div class="status-badge" style="background:${badgeColor}; color:${textColor};">${statusLabel}</div>
                            <div style="font-size:0.85rem; margin-top:8px; color:var(--muted); font-weight:600;">Pickup: ${f.arrival}</div>
                        </div>
                    </div>

                    <div class="flight-details-grid">
                        <div class="detail-box"><span class="detail-label">TERMINAL</span><span class="detail-value">${details.terminal}</span></div>
                        <div class="detail-box"><span class="detail-label">GATE</span><span class="detail-value" style="color: var(--success);">${details.gate}</span></div>
                        <div class="detail-box"><span class="detail-label">BAGGAGE</span><span class="detail-value" style="color:#f59e0b;">💼 ${details.baggage}</span></div>
                        <div class="detail-box"><span class="detail-label">AIRCRAFT</span><span class="detail-value" style="color: var(--muted);">${details.aircraft}</span></div>
                        <div class="detail-box"><span class="detail-label">EST. LANDING</span><span class="detail-value" style="color: var(--accent);">${details.eta}</span></div>
                        <div class="detail-box"><span class="detail-label">ACCURACY</span><span class="detail-value" style="color: var(--text);">${details.accuracy}</span></div>
                    </div>
                </div>
            `;

            const removeBtn = document.createElement('button');
            removeBtn.innerText = "✕";
            removeBtn.className = "remove-flight-btn";
            removeBtn.onclick = (event) => { event.stopPropagation(); deleteFlight(f.id); };
            card.appendChild(removeBtn);

            card.onclick = () => pinOnMap(f);
            listContainer.appendChild(card);
        });
    }
}

// ----------------------
// Filter Flights by Search
// ----------------------
function filterSearch() {
    const query = document.getElementById('search-bar').value.toLowerCase();
    document.querySelectorAll('.search-target').forEach(card => {
        card.style.display = card.getAttribute('data-flight').includes(query) ? 'flex' : 'none';
    });
}

// ----------------------
// Map Pinning
// ----------------------
function pinOnMap(flightData) {
    activeRouteLayers.forEach(layer => map.removeLayer(layer));
    activeRouteLayers = [];

    const route = flightData.route;
    if (!route) return;

    const originCoords = [route.origin.lat, route.origin.lng];
    const destCoords = [route.destination.lat, route.destination.lng];

    const routeLine = L.polyline([originCoords, destCoords], { color:'#4977ff', weight:3, dashArray:'5,10', opacity:0.8 }).addTo(map);
    activeRouteLayers.push(routeLine);

    const originMarker = L.circleMarker(originCoords, { color:'#ef4444', radius:5, fillOpacity:0.5 }).addTo(map).bindPopup(`<b>DEP: ${route.origin_code}</b><br>${route.origin.city || 'Unknown'}`);
    const destMarker = L.circleMarker(destCoords, { color:'#10ffbe', radius:8, fillOpacity:0.9 }).addTo(map).bindPopup(`<b>ARR: ${route.dest_code}</b><br>Flight: ${flightData.flight}`).openPopup();

    activeRouteLayers.push(originMarker, destMarker);
    map.fitBounds(routeLine.getBounds(), { padding:[50,50], maxZoom:6 });
}

// ----------------------
// Flight Delete
// ----------------------
async function deleteFlight(id) {
    if(confirm("Stop tracking this flight?")) {
        const targetDate = getFormattedDate() || "ALL";
        await fetch(`/api/flights/${encodeURIComponent(targetDate)}/${id}`, { method: 'DELETE' });
        await fetchFlights();
    }
}
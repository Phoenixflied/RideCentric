const API_BASE = window.location.origin;

document.addEventListener("DOMContentLoaded", () => {
    // 1. Restore the Clock
    startClock();
    
    // 2. Setup the Date Picker with default "ALL" view
    const datePicker = document.getElementById('date-picker');
    if (datePicker) {
        datePicker.addEventListener('change', () => fetchFlights(datePicker.value));
    }

    // 3. Initial Load
    fetchFlights("ALL");
});

function startClock() {
    setInterval(() => {
        const el = document.getElementById('clock');
        if (el) {
            el.innerText = new Date().toLocaleTimeString('en-US', { hour12: false });
        }
    }, 1000);
}

async function fetchFlights(targetDate = "ALL") {
    try {
        const res = await fetch(`${API_BASE}/api/flights?date=${targetDate}`);
        const data = await res.json();
        renderDashboard(data);
    } catch (e) {
        console.error("Connection to API failed.");
    }
}

function renderDashboard(rides) {
    const panel = document.getElementById('data-panel');
    if (!panel) return;
    panel.innerHTML = '';

    if (!rides || rides.length === 0) {
        panel.innerHTML = `
            <div style="padding:40px; text-align:center; color:#888; border:2px dashed #333; border-radius:15px; margin:20px;">
                No ARRIVAL flights found. <br> 
                <small>Ensure the PDF contains "Run Type: ARRIVAL".</small>
            </div>`;
        return;
    }

    // Organize by Date for better UI grouping
    const grouped = {};
    rides.forEach(r => {
        if (!grouped[r.date]) grouped[r.date] = [];
        grouped[r.date].push(r);
    });

    for (const [date, flightList] of Object.entries(grouped)) {
        const section = document.createElement('div');
        section.className = 'station-block';
        section.innerHTML = `
            <div class="station-header" style="display:flex; justify-content:space-between; align-items:center;">
                <div class="station-title">📅 Date: ${date}</div>
                <div style="font-size:0.8rem; color:#10ffbe;">${flightList.length} Arrivals</div>
            </div>
            <div class="flight-list"></div>
        `;
        panel.appendChild(section);

        const list = section.querySelector('.flight-list');

        flightList.forEach(ride => {
            const card = document.createElement('div');
            card.className = 'flight-card search-target';
            card.setAttribute('data-search', `${ride.flight} ${ride.passenger}`.toLowerCase());

            // RESTORED ORIGINAL COMPLEX LAYOUT
            card.innerHTML = `
                <div style="padding: 15px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                        <span style="font-weight:800; color:var(--accent); font-size:1.1rem;">✈️ ${ride.flight}</span>
                        <span style="font-size:0.7rem; color:#888; background:#222; padding:2px 6px; border-radius:4px;">RID# ${ride.ride_no}</span>
                    </div>
                    
                    
                    
                    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-bottom:12px; border-top:1px solid #333; padding-top:10px;">
                        <div>
                            <div style="font-size:0.65rem; color:#888; text-transform:uppercase;">Arrival Time</div>
                            <div style="font-size:0.9rem; color:#fff; font-weight:bold;">🕒 ${ride.arrival_time}</div>
                        </div>
                        <div>
                            <div style="font-size:0.65rem; color:#888; text-transform:uppercase;">Run Type</div>
                            <div style="font-size:0.8rem; color:#10ffbe; font-weight:bold;">${ride.run_type}</div>
                        </div>
                    </div>
                    
                    <div style="display:flex; align-items:center; gap:6px; margin-top:5px;">
                        <div style="width:8px; height:8px; background:#10ffbe; border-radius:50%; box-shadow: 0 0 8px #10ffbe;"></div>
                        <span style="font-size:0.7rem; color:#10ffbe; font-weight:700; text-transform:uppercase;">${ride.status}</span>
                    </div>
                </div>
            `;
            list.appendChild(card);
        });
    }
}

async function forceScan() {
    const status = document.getElementById('scan-status');
    if (status) status.innerText = "⚡ Analyzing PDF Blocks...";
    
    try {
        const res = await fetch(`${API_BASE}/api/scan_manifests`, { method: 'POST' });
        const result = await res.json();
        
        if (status) status.innerText = `✅ Success: ${result.added} Arrivals Stored.`;
        
        // Show all results immediately
        fetchFlights("ALL");
    } catch (err) {
        if (status) status.innerText = "❌ Scan Failed.";
    }
}

function filterSearch() {
    const query = document.getElementById('search-bar').value.toLowerCase();
    document.querySelectorAll('.search-target').forEach(card => {
        const content = card.getAttribute('data-search');
        card.style.display = content.includes(query) ? 'block' : 'none';
    });
}
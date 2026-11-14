const API_BASE = "";
const TOKEN_KEY = 'ridecentric_token';
const THEME_KEY = 'rc-theme';
const DEFAULT_VIEW = { center: [25.7617, -80.1918], zoom: 12 }; // Miami area
const TILE_URLS = {
    light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
};

// Airline names by 2-letter code (used for the Airline column). Add more as needed.
const AIRLINES = {
    AA: 'American Airlines', DL: 'Delta Air Lines', UA: 'United Airlines', WN: 'Southwest Airlines', AS: 'Alaska Airlines',
    B6: 'JetBlue', NK: 'Spirit Airlines', AC: 'Air Canada', AM: 'Aeromexico', AF: 'Air France', BF: 'French Bee',
    BA: 'British Airways', VS: 'Virgin Atlantic', LH: 'Lufthansa', KL: 'KLM', IB: 'Iberia', TP: 'TAP Air Portugal',
    TB: 'TUI fly Belgium', QR: 'Qatar Airways', EK: 'Emirates', EY: 'Etihad Airways', TK: 'Turkish Airlines',
    CX: 'Cathay Pacific', JL: 'Japan Airlines', NH: 'ANA', KE: 'Korean Air', SQ: 'Singapore Airlines'
};

let map = null;
let tileLayer = null;
let rides = [];          // flights currently loaded from the API (normalized)
let selectedId = null;   // id of the flight shown in the details card
const S = { date: 'ALL', q: '', status: null, sort: { k: 'when', dir: 1 }, auto: true };

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// =============================================================================
// AUTH
// =============================================================================

function getAuthToken() {
    return localStorage.getItem(TOKEN_KEY);
}

function redirectToLogin() {
    window.location.href = '/app/login.html';
}

function requireAuth() {
    const token = getAuthToken();
    if (!token) {
        redirectToLogin();
        return null;
    }
    return token;
}

// Calls the backend with the session token. Throws an Error with the server's message on failure.
// A 401 means the session is gone (the backend keeps sessions in memory, so a restart logs everyone out):
// clear the stale token and send the user back to the login page.
async function apiFetch(path, options) {
    const token = requireAuth();
    if (!token) {
        const e = new Error('Not signed in');
        e.auth = true;
        throw e;
    }
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${API_BASE}${path}${sep}token=${encodeURIComponent(token)}`, options);
    if (res.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        redirectToLogin();
        const e = new Error('Session expired, please log in again');
        e.auth = true;
        throw e;
    }
    if (!res.ok) {
        let errText = res.statusText || `HTTP ${res.status}`;
        try {
            const errJson = await res.json();
            if (Array.isArray(errJson.detail)) errText = errJson.detail.map((d) => d.msg).join(', ');
            else errText = errJson.detail || errJson.message || errText;
        } catch (e) {
            // not JSON, keep statusText
        }
        throw new Error(errText);
    }
    return res.json();
}

function logout() {
    localStorage.removeItem(TOKEN_KEY);
    try { localStorage.removeItem('ridecentric_user'); } catch (e) { /* storage blocked */ }
    redirectToLogin();
}

// =============================================================================
// SMALL HELPERS
// =============================================================================

let toastTimer;
function toast(msg, kind) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ''; }, 3600);
}

function iso(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
// "Today" is the date at the dispatch station (see the time-zone selector), not necessarily the date on this computer.
function todayStr() { const p = stationParts(Date.now()); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; }
function dayOffset(n) { return n ? addDays(todayStr(), n) : todayStr(); }
function addDays(s, n) {
    const p = s.split('-');
    const d = new Date(+p[0], +p[1] - 1, +p[2], 12);
    d.setDate(d.getDate() + n);
    return iso(d);
}
function relDay(date) {
    return date === dayOffset(0) ? 'Today' : date === dayOffset(1) ? 'Tomorrow' : date === dayOffset(-1) ? 'Yesterday' : '';
}
function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

// Fills in the fields the backend may not have stored (terminal/gate/passenger) and derives display values.
function normalize(r) {
    const flight = String(r.flight || '').trim();
    const code = flight.replace(/\s+/g, '').slice(0, 2).toUpperCase();
    const status = String(r.status || 'SCHEDULED').toUpperCase();
    const parts = String(r.arrival_time || '').split(':').map(Number);
    const mins = Number.isFinite(parts[0]) ? parts[0] * 60 + (parts[1] || 0) : 0;
    const dp = String(r.date || '').split('-').map(Number);
    const whenTs = dp.length === 3 && dp.every(Number.isFinite) ? zonedTs(dp[0], dp[1], dp[2], mins) : 0;
    return Object.assign({}, r, {
        flight,
        airline: AIRLINES[code] || '',
        status,
        statusSlug: slug(status),
        terminal: r.terminal || 'TBD',
        gate: r.gate || 'TBD',
        passenger: r.passenger || 'N/A',
        run_type: r.run_type || 'ARRIVAL',
        whenTs,
        mins
    });
}

// =============================================================================
// STARTUP
// =============================================================================

document.addEventListener("DOMContentLoaded", () => {
    if (!requireAuth()) return;
    initTheme();
    initStation();
    initUser();
    initClock();
    initMap();
    setupEventListeners();
    setupExtras();
    renderDetail();
    renderPulse();
    // after a fresh login the cover from fx.js stays up for a moment, then lifts to show the dashboard
    const minHold = new Promise((r) => setTimeout(r, 450));
    Promise.all([fetchFlights("ALL"), minHold]).then(() => { if (window.RC) RC.introReveal(); });
    setInterval(() => {
        if (S.auto && !document.hidden && $('manual-modal-v3').hidden) fetchFlights(S.date, { silent: true });
    }, 30000);
});

function initClock() {
    const tick = () => {
        const el = $('clock');
        if (!el) return;
        const p = stationParts(Date.now());
        el.innerText = `${pad(p.h % 12 || 12)}:${pad(p.mi)}:${pad(p.s)} ${p.h < 12 ? 'AM' : 'PM'}`;
        tickNext();
        if (p.s % 30 === 0) refreshClockDriven();
    };
    tick();
    window.updateClock = tick;   // the station selector calls this so the clock changes at once
    setInterval(tick, 1000);
}

// ---------- theme ----------

const SUN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    $('theme-btn').innerHTML = t === 'dark' ? SUN : MOON;
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* storage blocked */ }
    if (tileLayer) tileLayer.setUrl(TILE_URLS[t]);
}

function initTheme() {
    $('theme-btn').innerHTML = currentTheme() === 'dark' ? SUN : MOON;
}

// ---------- map ----------

function initMap() {
    if (!$('map')) return;
    if (typeof L === 'undefined') {
        $('map-hint').textContent = 'The map could not be loaded. Check the internet connection and reload.';
        return;
    }
    map = L.map('map').setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
    tileLayer = L.tileLayer(TILE_URLS[currentTheme()], {
        attribution: '© OpenStreetMap © CARTO',
        subdomains: 'abcd',
        maxZoom: 19
    }).addTo(map);
    $('map-hint').textContent = 'Select a flight, then press “Track on map” to follow it.';
    if (window.ResizeObserver) new ResizeObserver(() => map.invalidateSize()).observe($('map'));
}

// ---------- events ----------

function setupEventListeners() {
    // Manual flight form
    const form = $('manual-flight-form');
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const payload = {
                id: `M-${Date.now()}`,
                flight: $('m-flight').value.trim(),
                arrival_time: $('m-arrival').value,
                date: $('m-date').value,
                ride_no: `MAN-${Math.floor(Math.random() * 9000)}`,
                terminal: $('m-term').value || "TBD",
                gate: $('m-gate').value || "TBD",
                status: "SCHEDULED"
            };

            try {
                await apiFetch('/api/add_manual', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                closeManualModal();
                form.reset();
                toast(`Added ${payload.flight} to ${payload.date}`, 'ok');
                // make sure the new flight is visible, then select it
                if (S.date !== 'ALL' && S.date !== payload.date) setDateControls(payload.date);
                S.q = '';
                S.status = null;
                $('search-bar').value = '';
                await fetchFlights(S.date);
                select(payload.id);
            } catch (err) {
                if (!err.auth) {
                    console.error("Submission failed", err);
                    toast("Add flight failed: " + err.message, 'err');
                }
            }
        });
    }

    $('add-btn').addEventListener('click', () => {
        $('m-date').value = S.date === 'ALL' ? dayOffset(0) : S.date;
        $('manual-modal-v3').hidden = false;
        setTimeout(() => $('m-flight').focus(), 30);
    });
    document.addEventListener('click', (e) => {
        const t = e.target;
        if ((t.hasAttribute && t.hasAttribute('data-close')) || (t.classList && t.classList.contains('overlay'))) closeOverlays();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverlays(); });

    // Date picker, stepper and "show all"
    $('date-picker').addEventListener('change', () => setDateControls($('date-picker').value, true));
    $('show-all').addEventListener('click', showAllFlights);
    $('d-today').addEventListener('click', () => setDateControls(dayOffset(0), true));
    $('d-prev').addEventListener('click', () => setDateControls(addDays(S.date === 'ALL' ? dayOffset(0) : S.date, -1), true));
    $('d-next').addEventListener('click', () => setDateControls(addDays(S.date === 'ALL' ? dayOffset(0) : S.date, 1), true));

    // Search, scan, auto-refresh, theme, logout
    $('search-bar').addEventListener('input', () => { S.q = $('search-bar').value; render(); });
    $('scan-btn').addEventListener('click', forceScan);
    $('auto').addEventListener('change', () => {
        S.auto = $('auto').checked;
        toast(S.auto ? 'Auto-refresh on (every 30 seconds)' : 'Auto-refresh paused');
    });
    $('theme-btn').addEventListener('click', () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
    $('logout-btn').addEventListener('click', logout);

    // Status chips
    $('summary').addEventListener('click', (e) => {
        const b = e.target.closest('[data-st]');
        if (!b) return;
        const v = b.getAttribute('data-st') || null;
        S.status = S.status === v ? null : v;
        render();
    });

    // Table: sorting + selecting a row
    $('grid').addEventListener('click', (e) => {
        const th = e.target.closest('th[data-sort]');
        if (th) {
            const k = th.getAttribute('data-sort');
            S.sort = { k, dir: S.sort.k === k ? -S.sort.dir : 1 };
            render();
            return;
        }
        const tr = e.target.closest('tr.row');
        if (tr) select(tr.getAttribute('data-id'));
    });
    $('grid').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const tr = e.target.closest('tr.row');
        if (tr) { e.preventDefault(); select(tr.getAttribute('data-id')); }
    });

    // Details card buttons
    $('detail-card').addEventListener('click', (e) => {
        const id = e.target.id;
        if (id === 'd-close') { selectedId = null; render(); }
        else if (id === 'd-list') $('list-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
        else if (id === 'd-track') {
            const r = getRide(selectedId);
            if (r) startFlightTracking(r, live.id === r.id ? live.data : null);
        }
    });
}

function closeManualModal() {
    $('manual-modal-v3').hidden = true;
}

function closeOverlays() {
    document.querySelectorAll('.overlay').forEach((o) => { o.hidden = true; });
}

function setDateControls(d, reload) {
    S.date = d || 'ALL';
    $('date-picker').value = d || '';
    S.status = null;
    if (reload) fetchFlights(S.date);
}

function showAllFlights() {
    setDateControls('', true);
}

// =============================================================================
// FLIGHT LIST
// =============================================================================

let refreshFailed = false;

async function fetchFlights(date = "ALL", opts = {}) {
    const panel = $('data-panel');
    if (panel && !opts.silent) panel.classList.add('loading');
    try {
        const data = await apiFetch(`/api/flights?date=${encodeURIComponent(date)}`);
        refreshFailed = false;
        rides = data.map(normalize);
        render();
    } catch (err) {
        if (err.auth) return;
        console.error("Connection to API failed.", err);
        // a silent background refresh only complains once until it works again
        if (!opts.silent || !refreshFailed) toast("Flight load failed: " + err.message, 'err');
        refreshFailed = true;
    } finally {
        if (panel) panel.classList.remove('loading');
    }
}

function getRide(id) {
    return rides.find((r) => r.id === id);
}

function visibleRides() {
    const toks = S.q.toLowerCase().split(/\s+/).filter(Boolean);
    const list = rides.filter((r) => {
        if (S.status && r.status !== S.status) return false;
        if (toks.length) {
            const hay = [r.flight, r.airline, r.ride_no, r.terminal, r.gate, r.status, r.passenger, r.date, r.arrival_time].join(' ').toLowerCase();
            for (const t of toks) if (!hay.includes(t)) return false;
        }
        return true;
    });
    const keys = {
        when: (r) => r.whenTs,
        status: (r) => r.status,
        flight: (r) => r.flight,
        airline: (r) => r.airline,
        term: (r) => r.terminal,
        gate: (r) => r.gate,
        ride: (r) => r.ride_no
    };
    const key = keys[S.sort.k] || keys.when;
    const cmp = (a, b) => {
        const x = key(a), y = key(b);
        return typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
    };
    list.sort((a, b) => (cmp(a, b) || a.whenTs - b.whenTs) * S.sort.dir);
    return list;
}

const STATUS_ORDER = ['ARRIVING', 'SCHEDULED', 'DELAYED', 'LANDED', 'COMPLETED', 'CANCELLED'];

function renderSummary() {
    const counts = {};
    rides.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
    const statuses = Object.keys(counts).sort((a, b) => {
        const ia = STATUS_ORDER.indexOf(a), ib = STATUS_ORDER.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
    const intro = !!(window.RC && RC.introActive());   // numbers count up once, right after login
    let n = 0;
    const chip = (st, label, cnt, cls) =>
        `<button type="button" class="sum ${cls}${(S.status || '') === st ? ' on' : ''}" data-st="${esc(st)}" style="--n:${n++}"><i></i><b class="num"${intro ? ` data-to="${cnt}"` : ''}>${cnt}</b>${esc(label)}</button>`;
    $('summary').innerHTML = chip('', 'All flights', rides.length, '') +
        statuses.map((st) => chip(st, st, counts[st], 'st-' + slug(st))).join('');
}

const COLS = [
    { t: 'Status', k: 'status', td: (r) => `<span class="st st-${esc(r.statusSlug)}"><i></i>${esc(r.status)}</span>` },
    { t: 'Flight', k: 'flight', td: (r) => `<span class="fno">${esc(r.flight)}</span>` },
    { t: 'Airline', k: 'airline', td: (r) => esc(r.airline || '—') },
    { t: 'Date', k: 'when', td: (r) => esc(String(r.date || '').slice(5).replace('-', '/')) },
    { t: 'Arrival', k: 'when', arrow: true, td: (r) => `<span class="num">${esc(r.arrival_time || '—')}</span>${dueBadge(r)}` },
    { t: 'Term', k: 'term', cell: true, td: (r) => esc(r.terminal) },
    { t: 'Gate', k: 'gate', cell: true, td: (r) => esc(r.gate) },
    { t: 'Ride #', k: 'ride', td: (r) => `<span class="num muted">${esc(r.ride_no)}</span>` },
    { t: 'Passenger', td: (r) => `<span class="muted">${esc(r.passenger)}</span>` },
    { t: 'Type', td: (r) => `<span class="muted">${esc(r.run_type)}</span>` }
];

function render() {
    renderSummary();
    if (S.status && !rides.some((r) => r.status === S.status)) S.status = null; // chip disappeared after a refresh
    if (selectedId && !getRide(selectedId)) selectedId = null;
    renderTable();
    renderDetail();
    renderPulse();
}

function renderTable() {
    const list = visibleRides();
    $('grid').querySelector('thead').innerHTML = '<tr>' + COLS.map((c) => {
        const on = c.k && S.sort.k === c.k && (c.k !== 'when' || c.arrow);
        return `<th scope="col"${c.k ? ` data-sort="${c.k}"` : ''}>${c.t}${on ? `<span class="arr">${S.sort.dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`;
    }).join('') + '</tr>';

    let body = '', lastDate = null;
    const grouped = S.sort.k === 'when';
    list.forEach((r, idx) => {
        if (grouped && r.date !== lastDate) {
            lastDate = r.date;
            const rel = relDay(r.date);
            body += `<tr class="sep"><td colspan="${COLS.length}">📅 ${esc(r.date)}${rel ? `<small>${rel}</small>` : ''}</td></tr>`;
        }
        body += `<tr class="row${selectedId === r.id ? ' sel' : ''}" data-id="${esc(r.id)}" tabindex="0" style="--i:${Math.min(idx, 24)}">` +
            COLS.map((c) => `<td${c.cell ? ' class="cell-t"' : ''}>${c.td(r)}</td>`).join('') + '</tr>';
    });
    const emptyMsg = rides.length === 0 && S.date === 'ALL'
        ? 'No flights yet. Put manifest PDFs in the manifests folder and press “Scan PDF”, or use “+ Add flight”.'
        : 'No flights match. Try another date, status or search.';
    $('grid').querySelector('tbody').innerHTML = body ||
        `<tr><td class="empty" colspan="${COLS.length}">${emptyMsg}</td></tr>`;
    $('foot').textContent = list.length
        ? `Showing ${list.length} of ${rides.length} flight${rides.length === 1 ? '' : 's'}${S.date === 'ALL' ? '' : ' on ' + S.date}`
        : 'Showing 0 flights';
    lastDue = dueSignature();
}

// =============================================================================
// PDF SCAN
// =============================================================================

async function forceScan() {
    const statusEl = $('scan-status');
    const scanBtn = $('scan-btn');

    if (!requireAuth()) return;

    // Disable button and show loading state
    scanBtn.disabled = true;
    scanBtn.innerText = "⏳ Scanning...";
    if (statusEl) statusEl.innerText = "Processing PDFs...";

    try {
        const result = await apiFetch('/api/scan_manifests', { method: 'POST' });

        if (result.status === 'success') {
            const addedCount = result.added || 0;
            if (addedCount > 0) {
                if (statusEl) statusEl.innerText = `✅ Added ${addedCount} new flights`;
                fetchFlights(S.date); // Refresh the flight list
            } else {
                if (statusEl) statusEl.innerText = `ℹ️ No new flights found`;
            }
        } else {
            if (statusEl) statusEl.innerText = `⚠️ ${result.message || 'Scan completed with issues'}`;
        }

    } catch (error) {
        if (error.auth) return;
        console.error('Scan failed:', error);
        if (statusEl) statusEl.innerText = `❌ Scan failed: ${error.message}`;
        toast(`PDF scan failed: ${error.message}`, 'err');
    } finally {
        // Re-enable button and reset text
        scanBtn.disabled = false;
        scanBtn.innerHTML = "&#8635; Scan PDF";

        // Clear status after 5 seconds
        setTimeout(() => {
            if (statusEl) statusEl.innerText = "";
        }, 5000);
    }
}

// =============================================================================
// FLIGHT DETAILS
// =============================================================================

let live = { id: null, loading: false, data: null };
let liveReq = 0;
let liveTimer = null;

// Selects a flight: highlights its row, fills the details card and asks the airline API for live status.
function select(id) {
    const ride = getRide(id);
    if (!ride) return;
    selectedId = id;
    renderTable();
    renderPulse();
    showFlightDetails(ride);
    if (window.matchMedia && window.matchMedia('(max-width: 1180px)').matches) {
        $('detail-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

function showFlightDetails(ride) {
    selectedId = ride.id;
    live = { id: ride.id, loading: true, data: null };
    const req = ++liveReq;
    renderDetail();

    // Fetch live flight data from external API (after a short pause: skimming through flights must not burn API quota)
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => fetchLiveFlightData(ride.flight, ride.date)
        .then((data) => {
            if (req !== liveReq) return; // another flight was selected meanwhile
            live = { id: ride.id, loading: false, data: data || { status: 'API unavailable', map_url: null } };
            renderDetail();
        })
        .catch((error) => {
            console.error('Error fetching live flight data:', error);
            if (req !== liveReq) return;
            live = { id: ride.id, loading: false, data: { status: 'Error loading status', map_url: null } };
            renderDetail();
        }), 250);
}

function closeFlightDetails() {
    selectedId = null;
    render();
}

function liveClass(status) {
    const s = String(status || '').toLowerCase();
    if (s.startsWith('on time')) return 'live-ok';
    if (s.startsWith('landed')) return 'live-ok';
    if (s.startsWith('in air')) return 'live-air';
    if (s.startsWith('delayed')) return 'live-late';
    if (s.startsWith('cancel') || s.includes('error') || s.includes('unavailable')) return 'live-bad';
    return '';
}

function fact(label, value) {
    return `<div class="fact"><label>${esc(label)}</label><div>${esc(value)}</div></div>`;
}

function renderDetail() {
    const c = $('detail-card');
    if (!c) return;
    const r = selectedId ? getRide(selectedId) : null;
    if (!r) {
        c.innerHTML = '<div class="dtitle">Flight details</div><div class="placeholder"><span class="big">✈️</span>Select a flight from the list<br>to see its details and live status.</div>';
        return;
    }
    const ld = (live.id === r.id && live.data) || {};   // live data for this flight (may be empty)
    let liveHtml;
    if (live.id === r.id && live.loading) {
        liveHtml = '<span class="muted">Loading…</span>';
    } else if (live.id === r.id && live.data) {
        const d = live.data;
        liveHtml = `<span class="pill ${liveClass(d.status)}">${esc(d.status || 'Unknown')}</span>` +
            (d.map_url ? '<button type="button" class="tbtn" id="d-track">🗺️ Track on map</button>' : '<span class="muted">Map not available</span>');
    } else {
        liveHtml = '<span class="muted">—</span>';
    }
    c.innerHTML =
        '<div class="dtitle"><span>Flight details</span><span><button type="button" class="to-list" id="d-list">↑ List</button> ' +
        '<button type="button" id="d-close" aria-label="Clear selection" title="Clear selection">&times;</button></span></div>' +
        `<div class="d-flight">${esc(r.flight)}</div><div class="d-air">${esc(r.airline)}</div>` +
        `<div class="d-chips"><span class="pill st-${esc(r.statusSlug)}">${esc(r.status)}</span></div>` +
        '<div class="facts">' +
        fact('Date', r.date) + fact('Arrival', r.arrival_time || '—') + fact('Ride #', r.ride_no) +
        fact('Terminal', ld.terminal && r.terminal === 'TBD' ? ld.terminal : r.terminal) +
        fact('Gate', ld.gate && r.gate === 'TBD' ? ld.gate : r.gate) + fact('Type', r.run_type) +
        fact('Passenger', r.passenger) +
        (ld.eta ? fact('ETA', ld.eta) : '') + (ld.baggage ? fact('Baggage', ld.baggage) : '') + (ld.aircraft ? fact('Aircraft', ld.aircraft) : '') +
        '</div>' +
        `<div class="apistate"><span class="muted">Live status</span>${liveHtml}</div>` +
        (ld.detail ? `<div class="apihint">${esc(ld.detail)}</div>` : '');
}

// =============================================================================
// LIVE FLIGHT STATUS
// =============================================================================
// Looked up by the backend (live.py) with the airline API key from the server's .env file,
// so the key never reaches the browser.

async function fetchLiveFlightData(flightNumber, date) {
    const path = `/api/live?flight=${encodeURIComponent(flightNumber)}&date=${encodeURIComponent(date || '')}`;
    try {
        const data = await apiFetch(path);
        // map_url is the same backend call: while the plane is airborne it also carries its position
        return Object.assign({}, data, { map_url: data.position ? path : null });
    } catch (error) {
        if (!error.auth) console.error('Live status error:', error);
        return { status: 'API Error', detail: error.message, map_url: null };
    }
}

// =============================================================================
// LIVE FLIGHT TRACKING ON DASHBOARD MAP
// =============================================================================

// Global variables for flight tracking
let currentFlightMarker = null;
let currentFlightPath = null;
let flightTrackingInterval = null;

// Start live flight tracking on the dashboard map
async function startFlightTracking(ride, flightData) {
    try {
        if (!map) {
            toast('The map is not available', 'warn');
            return;
        }

        // Clear any existing flight tracking
        clearFlightTracking(false);

        // Fetch initial flight data (re-use what the details card already loaded)
        flightData = flightData || await fetchLiveFlightData(ride.flight, ride.date);

        if (!flightData || !flightData.map_url) {
            toast('Flight tracking data not available', 'warn');
            return;
        }

        // map_url is the backend's /api/live call, which includes the plane's position while it is airborne
        const trackingData = await apiFetch(flightData.map_url);

        // Extract flight position (adjust based on your API response structure)
        const flightPosition = extractFlightPosition(trackingData);

        if (flightPosition) {
            // Add flight marker to map
            addFlightMarkerToMap(flightPosition, ride);

            // Optionally add flight path if available
            if (trackingData.flightPath || trackingData.path) {
                addFlightPathToMap(trackingData.flightPath || trackingData.path);
            }

            // Center map on flight
            map.setView([flightPosition.lat, flightPosition.lng], 8);

            // Start periodic updates (every 30 seconds)
            flightTrackingInterval = setInterval(async () => {
                try {
                    const updatedData = await apiFetch(flightData.map_url);
                    const newPosition = extractFlightPosition(updatedData);
                    if (newPosition) {
                        updateFlightMarker(newPosition, ride);
                    }
                } catch (error) {
                    console.error('Error updating flight position:', error);
                }
            }, 30000);

            // Show tracking info panel
            showTrackingInfoPanel(ride, flightData);
        } else {
            toast('Unable to locate flight position', 'warn');
        }

    } catch (error) {
        console.error('Error starting flight tracking:', error);
        toast('Error loading flight tracking: ' + error.message, 'err');
    }
}

// Extract flight position from API response (customize based on your API)
function extractFlightPosition(trackingData) {
    // Adjust these paths based on your airline API response structure
    // Common patterns:
    if (trackingData.position) {
        return {
            lat: trackingData.position.latitude || trackingData.position.lat,
            lng: trackingData.position.longitude || trackingData.position.lng,
            altitude: trackingData.position.altitude,
            heading: trackingData.position.heading,
            speed: trackingData.position.speed
        };
    }

    if (trackingData.latitude && trackingData.longitude) {
        return {
            lat: trackingData.latitude,
            lng: trackingData.longitude,
            altitude: trackingData.altitude,
            heading: trackingData.heading,
            speed: trackingData.speed
        };
    }

    // If the API returns an array of positions, use the latest one
    if (Array.isArray(trackingData) && trackingData.length > 0) {
        const latest = trackingData[trackingData.length - 1];
        return {
            lat: latest.lat || latest.latitude,
            lng: latest.lng || latest.longitude,
            altitude: latest.altitude,
            heading: latest.heading,
            speed: latest.speed
        };
    }

    return null;
}

// Plane icon, rotated to the flight's heading
function planeIcon(heading) {
    return L.divIcon({
        html: `<svg class="plane-ico" viewBox="-14 -14 28 28" style="transform:rotate(${Number(heading) || 0}deg)"><path d="M0,-12 L3,-4 L12,2 L12,5 L3,3 L2,9 L5,11 L5,13 L0,12 L-5,13 L-5,11 L-2,9 L-3,3 L-12,5 L-12,2 L-3,-4 Z"/></svg>`,
        className: 'flight-plane-icon',
        iconSize: [30, 30],
        iconAnchor: [15, 15]
    });
}

function popupHtml(position, ride) {
    return `<div style="font-family: 'Montserrat', sans-serif; text-align: center;">
        <strong>${esc(ride.flight)}</strong><br>
        Alt: ${esc(position.altitude || 'N/A')} ft<br>
        Speed: ${esc(position.speed || 'N/A')} kts<br>
        Heading: ${esc(position.heading || 'N/A')}°
    </div>`;
}

// Add flight marker to map
function addFlightMarkerToMap(position, ride) {
    currentFlightMarker = L.marker([position.lat, position.lng], {
        icon: planeIcon(position.heading)
    }).addTo(map);

    // Add popup with flight info
    currentFlightMarker.bindPopup(popupHtml(position, ride)).openPopup();
}

// Add flight path to map
function addFlightPathToMap(pathData) {
    if (!pathData || !Array.isArray(pathData)) return;

    const pathCoords = pathData.map(point => [point.lat || point.latitude, point.lng || point.longitude]);

    currentFlightPath = L.polyline(pathCoords, {
        color: '#1fa64a',
        weight: 3,
        opacity: 0.85
    }).addTo(map);
}

// Update flight marker position
function updateFlightMarker(newPosition, ride) {
    if (currentFlightMarker) {
        currentFlightMarker.setLatLng([newPosition.lat, newPosition.lng]);
        currentFlightMarker.setIcon(planeIcon(newPosition.heading));

        // Update popup content
        currentFlightMarker.setPopupContent(popupHtml(newPosition, ride));
    }

    // Update path if new segment available
    if (currentFlightPath && newPosition.path) {
        // Add new point to path
        const newCoords = [newPosition.lat, newPosition.lng];
        currentFlightPath.addLatLng(newCoords);
    }
}

// Show tracking info panel
function showTrackingInfoPanel(ride, flightData) {
    const host = $('map').parentElement;
    let panel = $('flight-tracking-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'flight-tracking-panel';
        panel.className = 'track-panel';
        host.appendChild(panel);
    }
    panel.innerHTML = `
        <button type="button" class="x" id="clear-tracking-btn" aria-label="Stop tracking">&times;</button>
        <strong>${esc(ride.flight)}</strong>
        <div class="meta">${esc(ride.date)} • ${esc(flightData.status || 'Tracking')}<br>Updates every 30 seconds</div>`;
    panel.style.display = 'block';
    $('clear-tracking-btn').addEventListener('click', () => clearFlightTracking());
    $('map-hint').textContent = `Following ${ride.flight}.`;
}

// Clear flight tracking (resetView=false when a new tracking session is about to start)
function clearFlightTracking(resetView = true) {
    if (map && currentFlightMarker) map.removeLayer(currentFlightMarker);
    currentFlightMarker = null;

    if (map && currentFlightPath) map.removeLayer(currentFlightPath);
    currentFlightPath = null;

    if (flightTrackingInterval) {
        clearInterval(flightTrackingInterval);
        flightTrackingInterval = null;
    }

    // Remove tracking info panel if it exists
    const trackingPanel = $('flight-tracking-panel');
    if (trackingPanel) trackingPanel.remove();

    if (map && resetView) {
        // Reset map view to default (Miami area)
        map.setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
        $('map-hint').textContent = 'Select a flight, then press “Track on map” to follow it.';
    }
}


// =============================================================================
// DISPATCH TIME ZONE
// =============================================================================
// The dispatcher may sit in a different time zone from the airport. Flight times in the list are airport
// times, so "Today", the clock and all countdowns use the time zone picked here (saved in this browser).

const STATION_KEY = 'rc-station';
const STATIONS = [
    { id: 'America/New_York', label: 'Miami / New York' },
    { id: 'America/Chicago', label: 'Chicago / Dallas' },
    { id: 'America/Denver', label: 'Denver' },
    { id: 'America/Los_Angeles', label: 'Los Angeles' },
    { id: 'Europe/London', label: 'London' },
    { id: 'Asia/Kathmandu', label: 'Kathmandu' },
    { id: 'UTC', label: 'UTC' },
    { id: '', label: 'This computer' }
];
let stationTz = 'America/New_York';   // the map starts on Miami, so Miami time is the default
const _dtf = {};

function dtf(tz) {
    return _dtf[tz] || (_dtf[tz] = new Intl.DateTimeFormat('en-US', Object.assign(
        { hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' },
        tz ? { timeZone: tz } : {})));
}

// Wall-clock parts of a moment in the station's time zone.
function stationParts(ts) {
    const o = {};
    dtf(stationTz).formatToParts(new Date(ts)).forEach((p) => { if (p.type !== 'literal') o[p.type] = +p.value; });
    return { y: o.year, m: o.month, d: o.day, h: o.hour === 24 ? 0 : o.hour, mi: o.minute, s: o.second };
}

// The moment (ms since 1970) at which the station's wall clock shows the given date and minutes-after-midnight.
function zonedTs(y, m, d, mins) {
    if (!stationTz) return new Date(y, m - 1, d, 0, mins).getTime();
    const guess = Date.UTC(y, m - 1, d, 0, mins);
    const off = (t) => { const p = stationParts(t); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000; };
    return guess - off(guess - off(guess));   // second pass settles daylight-saving edges
}

function initStation() {
    let saved = null;
    try { saved = localStorage.getItem(STATION_KEY); } catch (e) { /* storage blocked */ }
    if (saved !== null && STATIONS.some((x) => x.id === saved)) stationTz = saved;
    const sel = $('station');
    sel.innerHTML = STATIONS.map((x) => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join('');
    sel.value = stationTz;
    sel.addEventListener('change', () => {
        stationTz = sel.value;
        try { localStorage.setItem(STATION_KEY, stationTz); } catch (e) { /* storage blocked */ }
        rides = rides.map(normalize);          // flight moments depend on the zone
        if (window.updateClock) window.updateClock();
        render();
        toast('Dispatch time: ' + (STATIONS.find((x) => x.id === stationTz) || {}).label);
    });
}

function initUser() {
    let u = '';
    try { u = localStorage.getItem('ridecentric_user') || ''; } catch (e) { /* storage blocked */ }
    if ($('whoami')) $('whoami').textContent = u;
    if ($('avatar')) $('avatar').textContent = (u.trim().charAt(0) || '?').toUpperCase();
    const chip = document.querySelector('.user-chip');
    if (chip && !u) chip.hidden = true;
}

// =============================================================================
// NEXT ARRIVAL, TIMELINE, DUE-SOON BADGES
// =============================================================================

const DONE = ['LANDED', 'COMPLETED', 'CANCELLED', 'CANCELED'];

function isOpen(r) { return r.whenTs && DONE.indexOf(r.status) < 0; }

function fmtCountdown(ms) {
    const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h >= 48) return `${Math.floor(h / 24)} days`;
    if (h >= 1) return `${h}h ${pad(m)}m`;
    return `${m}m ${pad(s % 60)}s`;
}

function nextRide() {
    const floor = Date.now() - 10 * 60000;     // stays "next" for 10 minutes after its scheduled time
    let best = null;
    rides.forEach((r) => { if (isOpen(r) && r.whenTs >= floor && (!best || r.whenTs < best.whenTs)) best = r; });
    return best;
}

// A small badge on flights due within the hour.
function dueBadge(r) {
    if (!isOpen(r)) return '';
    const diff = r.whenTs - Date.now();
    if (diff < -10 * 60000 || diff > 60 * 60000) return '';
    if (diff <= 60000) return '<span class="due now">NOW</span>';
    return `<span class="due">in ${Math.round(diff / 60000)}m</span>`;
}

function dueSignature() {
    return rides.map((r) => dueBadge(r)).join('|');
}

function renderNext() {
    const el = $('nextarr');
    if (!el) return;
    const label = '<div class="na-label"><span class="na-live"></span>NEXT ARRIVAL</div>';
    const r = nextRide();
    if (!r) {
        const last = rides.filter((x) => x.whenTs).sort((a, b) => b.whenTs - a.whenTs)[0];
        el.className = 'nextarr idle';
        el.removeAttribute('data-ts');
        el.innerHTML = label + '<div class="na-idle">No upcoming arrivals</div>' +
            `<div class="na-sub">${last ? `Latest on this board: ${esc(last.flight)}, ${esc(last.date)} ${esc(last.arrival_time)}` : 'Scan manifests or add a flight to get started.'}</div>`;
        return;
    }
    el.setAttribute('data-ts', r.whenTs);
    el.innerHTML = label +
        `<div class="na-main"><button type="button" class="na-flight" data-id="${esc(r.id)}" title="Show this flight">${esc(r.flight)}</button><span class="na-air">${esc(r.airline)}</span></div>` +
        '<div class="na-count" id="na-count"></div>' +
        `<div class="na-sub">${esc(r.arrival_time)} · ${esc(relDay(r.date) || r.date)} · Term ${esc(r.terminal)} · Gate ${esc(r.gate)}</div>`;
    tickNext();
}

// Called every second: only the countdown text and the colour change.
function tickNext() {
    const el = $('nextarr'), c = $('na-count');
    if (!el || !c || !el.getAttribute('data-ts')) return;
    const diff = +el.getAttribute('data-ts') - Date.now();
    c.textContent = diff <= 60000 ? 'Arriving now' : 'in ' + fmtCountdown(diff);
    el.className = 'nextarr' + (diff <= 60000 ? ' now' : diff <= 30 * 60000 ? ' soon' : '');
}

// Which day the timeline shows: the chosen date; with "all dates" today if it has flights, else the next one, else the latest.
function timelineDay() {
    if (S.date && S.date !== 'ALL') return S.date;
    const today = todayStr();
    if (rides.some((r) => r.date === today)) return today;
    const nx = nextRide();
    if (nx) return nx.date;
    const dates = rides.map((r) => r.date).filter(Boolean).sort();
    return dates.length ? dates[dates.length - 1] : today;
}

function dayLabel(date) {
    const p = String(date).split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2], 12).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function renderTimeline() {
    const el = $('timeline');
    if (!el) return;
    const day = timelineDay(), isToday = day === todayStr();
    const list = rides.filter((r) => r.date === day && r.whenTs).sort((a, b) => a.mins - b.mins);
    const hours = new Array(24).fill(0);
    list.forEach((r) => { hours[Math.min(23, Math.floor(r.mins / 60))]++; });
    const peak = Math.max.apply(null, hours);
    const peakH = hours.indexOf(peak);
    const head = `<div class="tl-head"><span>ARRIVALS</span><b>${esc(dayLabel(day))}</b>${isToday ? '<span>Today</span>' : relDay(day) ? `<span>${esc(relDay(day))}</span>` : ''}` +
        `<span>${list.length} flight${list.length === 1 ? '' : 's'}</span>` +
        (peak > 1 ? `<em>Busiest: ${pad(peakH)}:00 (${peak})</em>` : '') + '</div>';

    let ticks = '';
    for (let h = 0; h <= 24; h += 3) ticks += `<span class="tl-tick${h === 0 ? ' first' : h === 24 ? ' last' : ''}" style="left:${h / 24 * 100}%">${pad(h)}</span>`;

    let body;
    if (!list.length) {
        body = `<div class="tl-empty">No arrivals on this day.</div>`;
    } else {
        const lastAt = [-99, -99, -99, -99];   // staggers dots that would overlap into 4 rows
        const now = Date.now();
        const dots = list.map((r, k) => {
            const pct = r.mins / 1440 * 100;
            let lane = lastAt.findIndex((x) => pct - x > 2);
            if (lane < 0) lane = k % 4;
            lastAt[lane] = pct;
            return `<button type="button" class="tl-dot st-${esc(r.statusSlug)}${r.whenTs < now ? ' past' : ''}${selectedId === r.id ? ' sel' : ''}" data-id="${esc(r.id)}" ` +
                `style="left:${pct.toFixed(2)}%;--lane:${lane};--k:${Math.min(k, 40)}" title="${esc(r.flight)} · ${esc(r.arrival_time)} · ${esc(r.status)}" aria-label="${esc(r.flight)} at ${esc(r.arrival_time)}"></button>`;
        }).join('');
        let nowMark = '';
        if (isToday) {
            const p = stationParts(now);
            nowMark = `<span class="tl-now" style="left:${((p.h * 60 + p.mi) / 1440 * 100).toFixed(2)}%"></span>`;
        }
        body = `<div class="tl-track"><div class="tl-line"></div>${ticks}${nowMark}${dots}</div>`;
    }
    el.innerHTML = head + body;
}

function renderPulse() {
    renderNext();
    renderTimeline();
}

// Called every 30 seconds by the clock: refresh the parts of the page that depend on the current time.
let lastDue = '';
function refreshClockDriven() {
    renderNext();
    renderTimeline();
    const sig = dueSignature();
    if (sig !== lastDue) { lastDue = sig; renderTable(); }
}

// Select a flight from anywhere (next-arrival card, timeline, keyboard) and bring its row into view.
function revealAndSelect(id) {
    const r = getRide(id);
    if (!r) return;
    if (!visibleRides().some((x) => x.id === id)) {        // hidden by the search or a status chip: clear those first
        S.q = ''; S.status = null; $('search-bar').value = '';
        render();
    }
    select(id);
    const row = Array.prototype.find.call(document.querySelectorAll('tr.row'), (tr) => tr.getAttribute('data-id') === id);
    if (row) row.scrollIntoView({ block: 'nearest', behavior: window.RC && RC.reduced() ? 'auto' : 'smooth' });
}

// =============================================================================
// CSV EXPORT + KEYBOARD SHORTCUTS
// =============================================================================

function csvCell(v) {
    let t = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;               // stops spreadsheets from running a cell as a formula
    return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

function exportCsv() {
    const list = visibleRides();
    if (!list.length) { toast('Nothing to export', 'warn'); return; }
    const head = ['Date', 'Arrival', 'Flight', 'Airline', 'Status', 'Terminal', 'Gate', 'Ride #', 'Passenger', 'Type'];
    const rows = list.map((r) => [r.date, r.arrival_time, r.flight, r.airline, r.status, r.terminal, r.gate, r.ride_no, r.passenger, r.run_type]);
    const text = '﻿' + [head].concat(rows).map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    a.download = `ridecentric-${S.date === 'ALL' ? 'all-flights' : S.date}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast(`Exported ${list.length} flight${list.length === 1 ? '' : 's'}`, 'ok');
}

function moveSelection(step) {
    const list = visibleRides();
    if (!list.length) return;
    let i = list.findIndex((r) => r.id === selectedId);
    i = i < 0 ? (step > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, i + step));
    revealAndSelect(list[i].id);
}

function setupExtras() {
    $('csv-btn').addEventListener('click', exportCsv);
    $('help-btn').addEventListener('click', () => { $('help-modal').hidden = !$('help-modal').hidden; });
    $('nextarr').addEventListener('click', (e) => {
        const b = e.target.closest('.na-flight');
        if (b) revealAndSelect(b.getAttribute('data-id'));
    });
    $('timeline').addEventListener('click', (e) => {
        const b = e.target.closest('.tl-dot');
        if (b) revealAndSelect(b.getAttribute('data-id'));
    });

    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target, typing = !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
        if (e.key === 'Escape' && t && t.id === 'search-bar') { t.blur(); return; }
        if (typing) return;
        const anyOpen = Array.prototype.some.call(document.querySelectorAll('.overlay'), (o) => !o.hidden);
        if (e.key === '?') { e.preventDefault(); $('help-modal').hidden = !$('help-modal').hidden; return; }
        if (anyOpen) return;
        const k = e.key.toLowerCase();
        const act = {
            '/': () => $('search-bar').focus(),
            j: () => moveSelection(1),
            k: () => moveSelection(-1),
            n: () => { const r = nextRide(); if (r) revealAndSelect(r.id); else toast('No upcoming arrivals'); },
            t: () => $('d-today').click(),
            '[': () => $('d-prev').click(),
            ']': () => $('d-next').click(),
            a: () => $('add-btn').click(),
            r: () => { fetchFlights(S.date); toast('Refreshed'); },
            e: exportCsv,
            d: () => $('theme-btn').click()
        }[k];
        if (act) { e.preventDefault(); act(); }
    });
}

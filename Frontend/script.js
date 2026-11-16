const API_BASE = "";
const TOKEN_KEY = 'ridecentric_token';

// Airline names by 2-letter code (used for the Airline column). Add more as needed.
const AIRLINES = {
    AA: 'American Airlines', DL: 'Delta Air Lines', UA: 'United Airlines', WN: 'Southwest Airlines', AS: 'Alaska Airlines',
    B6: 'JetBlue', NK: 'Spirit Airlines', AC: 'Air Canada', AM: 'Aeromexico', AF: 'Air France', BF: 'French Bee',
    BA: 'British Airways', VS: 'Virgin Atlantic', LH: 'Lufthansa', KL: 'KLM', IB: 'Iberia', TP: 'TAP Air Portugal',
    TB: 'TUI fly Belgium', QR: 'Qatar Airways', EK: 'Emirates', EY: 'Etihad Airways', TK: 'Turkish Airlines',
    CX: 'Cathay Pacific', JL: 'Japan Airlines', NH: 'ANA', KE: 'Korean Air', SQ: 'Singapore Airlines',
    // regional carriers that fly under the big airlines' names
    OO: 'SkyWest Airlines', '9E': 'Endeavor Air', YX: 'Republic Airways', MQ: 'Envoy Air', OH: 'PSA Airlines',
    PT: 'Piedmont Airlines', YV: 'Mesa Airlines', G7: 'GoJet Airlines', C5: 'CommuteAir', QX: 'Horizon Air',
    ZW: 'Air Wisconsin', CP: 'Compass Airlines', '9K': 'Cape Air',
    F9: 'Frontier Airlines', G4: 'Allegiant Air', SY: 'Sun Country', HA: 'Hawaiian Airlines', WS: 'WestJet',
    '5X': 'UPS Airlines', FX: 'FedEx Express', QF: 'Qantas', NZ: 'Air New Zealand', AI: 'Air India', BR: 'EVA Air',
    CI: 'China Airlines', LX: 'Swiss', EI: 'Aer Lingus', AZ: 'ITA Airways', Y4: 'Volaris', VB: 'Viva Aerobus',
    AV: 'Avianca', LA: 'LATAM Airlines', CM: 'Copa Airlines'
};

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
    initStation();
    initUser();
    initClock();
    RouteView.init();
    setupEventListeners();
    setupExtras();
    renderDetail();
    renderPulse();
    // after a fresh login the cover from fx.js stays up for a moment, then lifts to show the dashboard
    const minHold = new Promise((r) => setTimeout(r, 450));
    Promise.all([fetchFlights("ALL"), minHold]).then(() => { if (window.RC) RC.introReveal(); });
    loadStatus();
    setInterval(() => {
        if (S.auto && !document.hidden && $('manual-modal-v3').hidden) { fetchFlights(S.date, { silent: true }); loadStatus(); }
    }, 30000);
});

function initClock() {
    const tick = () => {
        const el = $('clock');
        if (!el) return;
        const p = stationParts(Date.now());
        el.innerText = `${pad(p.h % 12 || 12)}:${pad(p.mi)}:${pad(p.s)} ${p.h < 12 ? 'AM' : 'PM'}`;
        tickNext();
        if (window.RouteView) RouteView.tick();      // the plane on the route diagram moves with the clock
        if (p.s % 30 === 0) refreshClockDriven();
    };
    tick();
    window.updateClock = tick;   // the station selector calls this so the clock changes at once
    setInterval(tick, 1000);
}

// Bright / Dark mode and the time-of-day sky: see sky.js (RCSky)

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

    // Search, scan, auto-refresh, logout
    $('search-bar').addEventListener('input', () => { S.q = $('search-bar').value; render(); });
    $('scan-btn').addEventListener('click', forceScan);
    $('upload-btn').addEventListener('click', () => $('upload-input').click());
    $('upload-input').addEventListener('change', () => uploadManifests($('upload-input').files));
    const dz = $('data-panel');   // PDFs can also be dropped on the flight list
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
        if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); dz.classList.add('dropping'); }
    }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove('dropping')));
    dz.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files.length) { e.preventDefault(); uploadManifests(e.dataTransfer.files); } });
    $('auto').addEventListener('change', () => {
        S.auto = $('auto').checked;
        toast(S.auto ? 'Auto-refresh on (every 30 seconds)' : 'Auto-refresh paused');
    });
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
        else if (id === 'd-refresh') {
            const r = getRide(selectedId);
            if (!r) return;
            const req = ++liveReq;
            live = { id: r.id, loading: true, data: null };
            renderDetail();
            fetchLiveFlightData(r, true).then((data) => {
                if (req !== liveReq) return;
                live = { id: r.id, loading: false, data: data || { status: 'API unavailable' } };
                renderDetail();
            });
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
        ? 'No flights yet. Press “Upload PDFs” and choose this month’s manifests (or drop them in the manifests folder), or use “+ Add flight”.'
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

let statusTimer = null;   // one timer for the scan/upload message, so an old one never wipes a newer message
function holdStatus(ms) {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { const el = $('scan-status'); if (el) el.innerText = ''; }, ms);
}

let sysStatus = null;   // numbers from /api/status (rides kept, next automatic delete, API requests this month)

async function loadStatus() {
    try {
        sysStatus = await apiFetch('/api/status');
    } catch (e) {
        if (e.auth) return;
        sysStatus = null;
    }
    renderStoreChip();
    if (!selectedId) renderDetail();     // the card shows the station airport until a flight is picked
}

function renderStoreChip() {
    const el = $('store-chip');
    if (!el) return;
    const s = sysStatus;
    if (!s) { el.textContent = ''; return; }
    const parts = [`📦 ${s.rides} ride${s.rides === 1 ? '' : 's'} stored`];
    if (s.purge_after_minutes && s.next_purge_ts) {
        const p = stationParts(s.next_purge_ts * 1000);
        parts.push(`next auto-delete ${pad(p.h)}:${pad(p.mi)}`);
    }
    const u = s.live || {};
    if (u.configured) parts.push(`✈ API ${u.calls}${u.budget ? '/' + u.budget : ''} this month`);
    el.textContent = parts.join(' · ');
    el.title = (s.purge_after_minutes
        ? `Rides are kept for the whole month and deleted ${s.purge_after_minutes} minutes after their arrival. `
        : 'Rides are kept: nothing is deleted automatically. ') +
        'The flight API is only asked about flights arriving today, and only when you open the flight.';
}

function scanMessage(r) {
    const bits = [];
    if (r.added) bits.push(`${r.added} new ride${r.added === 1 ? '' : 's'} added`);
    if (r.updated) bits.push(`${r.updated} updated`);
    if (r.expired) bits.push(`${r.expired} already over (skipped)`);
    return bits;
}

async function forceScan() {
    const statusEl = $('scan-status');
    const scanBtn = $('scan-btn');

    if (!requireAuth()) return;

    scanBtn.disabled = true;
    scanBtn.innerText = "⏳ Scanning...";
    clearTimeout(statusTimer);
    if (statusEl) statusEl.innerText = "Reading the manifests folder...";

    try {
        const result = await apiFetch('/api/scan_manifests', { method: 'POST' });
        if (result.status === 'success') {
            const bits = scanMessage(result);
            if (result.added || result.updated) {
                if (statusEl) statusEl.innerText = `✅ ${bits.join(', ')} (${result.files} file${result.files === 1 ? '' : 's'})`;
                fetchFlights(S.date);
            } else if (result.errors && result.errors.length) {
                if (statusEl) statusEl.innerText = `⚠️ ${result.errors[0]}`;
            } else {
                if (statusEl) statusEl.innerText = result.already ? `ℹ️ Nothing new: ${result.already} file${result.already === 1 ? ' is' : 's are'} already loaded` : 'ℹ️ No new PDFs in the manifests folder';
            }
        } else {
            if (statusEl) statusEl.innerText = `⚠️ ${result.message || 'Scan completed with issues'}`;
        }
        loadStatus();
    } catch (error) {
        if (error.auth) return;
        console.error('Scan failed:', error);
        if (statusEl) statusEl.innerText = `❌ Scan failed: ${error.message}`;
        toast(`PDF scan failed: ${error.message}`, 'err');
    } finally {
        scanBtn.disabled = false;
        scanBtn.innerHTML = "&#8635; Scan folder";
        holdStatus(8000);
    }
}

// Manifest PDFs chosen (or dropped) by the dispatcher: sent one by one; a whole month of rides is stored at once.
async function uploadManifests(fileList) {
    const files = Array.from(fileList || []).filter((f) => /\.pdf$/i.test(f.name));
    const statusEl = $('scan-status');
    const btn = $('upload-btn');
    if (!files.length) { toast('Choose one or more manifest PDF files', 'warn'); return; }
    if (!requireAuth()) return;
    btn.disabled = true;
    clearTimeout(statusTimer);
    const total = { added: 0, updated: 0, expired: 0, already: 0, ok: 0, errors: [] };
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (statusEl) statusEl.innerText = `Reading ${f.name} (${i + 1}/${files.length})...`;
        try {
            const r = await apiFetch(`/api/upload_manifest?name=${encodeURIComponent(f.name)}`, {
                method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: f
            });
            total.ok++;
            if (r.already_loaded) total.already++;
            total.added += r.added || 0; total.updated += r.updated || 0; total.expired += r.expired || 0;
        } catch (e) {
            if (e.auth) return;
            total.errors.push(`${f.name}: ${e.message}`);
        }
    }
    btn.disabled = false;
    $('upload-input').value = '';
    const bits = scanMessage(total);
    if (total.already) bits.push(`${total.already} file${total.already === 1 ? '' : 's'} already loaded`);
    const msg = (bits.length ? bits.join(', ') : (total.ok ? 'nothing new' : '')) + (total.errors.length ? (bits.length || total.ok ? ' · ' : '') + total.errors[0] : '');
    if (statusEl) statusEl.innerText = (total.errors.length ? '⚠️ ' : '✅ ') + msg;
    toast(msg || 'Upload finished', total.errors.length ? 'warn' : 'ok');
    holdStatus(10000);
    fetchFlights(S.date);
    loadStatus();
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
    liveTimer = setTimeout(() => fetchLiveFlightData(ride)
        .then((data) => {
            if (req !== liveReq) return; // another flight was selected meanwhile
            live = { id: ride.id, loading: false, data: data || { status: 'API unavailable' } };
            renderDetail();
        })
        .catch((error) => {
            console.error('Error fetching live flight data:', error);
            if (req !== liveReq) return;
            live = { id: ride.id, loading: false, data: { status: 'Error loading status' } };
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
    if (s.startsWith('delayed') || s.includes('budget')) return 'live-late';
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
        showRoute(null);
        return;
    }
    const ld = (live.id === r.id && live.data) || {};   // live data for this flight (may be empty)
    let liveHtml;
    if (live.id === r.id && live.loading) {
        liveHtml = '<span class="muted">Loading…</span>';
    } else if (live.id === r.id && live.data) {
        const d = live.data;
        liveHtml = `<span class="pill ${liveClass(d.status)}">${esc(d.status || 'Unknown')}</span>`;
    } else {
        liveHtml = '<span class="muted">—</span>';
    }
    const meta = [];
    if (live.id === r.id && live.data && !live.loading) {
        if (ld.checked_as) meta.push('Checked as ' + ld.checked_as);
        if (ld.operator) meta.push('Operated by ' + ld.operator);
        if (ld.saved) meta.push('saved on the day of the flight');
        else if (ld.cached) meta.push('saved copy from ' + (ld.age_s >= 90 ? Math.round(ld.age_s / 60) + ' min' : 'moments') + ' ago');
        else if (ld.configured !== false && !ld.not_today && ld.status !== 'API Error') meta.push('checked just now');
    }
    const canRefresh = live.id === r.id && live.data && !live.loading && ld.configured !== false && !ld.not_today && ld.status !== 'API Error' &&
        !/^(landed|cancelled)/i.test(ld.status || '');
    const removeAt = (() => {
        const mins = sysStatus && sysStatus.purge_after_minutes;       // 0 = nothing is deleted automatically
        if (!r.whenTs || !mins) return '';
        const p = stationParts(r.whenTs + mins * 60000), d = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
        return `${d === r.date ? '' : d + ' '}${pad(p.h)}:${pad(p.mi)}`;
    })();
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
        (r.pax != null ? fact('Pax', r.pax) : '') + (r.bags != null ? fact('Bags', r.bags) : '') +
        (removeAt ? fact('Auto-removes', removeAt) : '') +
        (ld.arrived ? fact('Landed at', ld.arrived) : '') + (ld.eta ? fact('ETA', ld.eta) : '') + (ld.baggage ? fact('Baggage', ld.baggage) : '') + (ld.aircraft ? fact('Aircraft', ld.aircraft) : '') +
        '</div>' +
        `<div class="apistate"><span class="muted">Live status</span>${liveHtml}</div>` +
        (meta.length ? `<div class="apimeta">${esc(meta.join(' · '))}${canRefresh ? ' <button type="button" class="tbtn" id="d-refresh">↻ Refresh now</button>' : ''}</div>` : '') +
        (ld.detail ? `<div class="apihint">${esc(ld.detail)}</div>` : '');
    showRoute(r);
}

// The airport the weather card and the map show when nothing is selected: STATION_AIRPORT, else the most common airport in the list.
function defaultAirport() {
    if (sysStatus && sysStatus.station_airport) return sysStatus.station_airport;
    const n = {};
    rides.forEach((r) => { if (r.airport) n[r.airport] = (n[r.airport] || 0) + 1; });
    const top = Object.keys(n).sort((a, b) => n[b] - n[a])[0];
    return top || null;
}

// The airports where the flights in view land (most flights first, at most 6): the weather card shows each one.
function stationList() {
    const day = S.date === 'ALL' ? null : S.date, n = {};
    rides.forEach((x) => { if (x.airport && (!day || x.date === day)) n[x.airport] = (n[x.airport] || 0) + 1; });
    const def = defaultAirport();
    if (def) n[def] = (n[def] || 0) + 0.5;                 // the station airport counts a little, so it is listed even on an empty day
    return Object.keys(n).sort((a, b) => n[b] - n[a] || (a < b ? -1 : 1)).slice(0, 6);
}

// Hands the selected flight (and what the flight API said about it) to the route diagram and the weather card.
function showRoute(r) {
    if (window.RouteView) RouteView.update(r, r ? live : null, defaultAirport(), stationList());
}

// =============================================================================
// LIVE FLIGHT STATUS
// =============================================================================
// Looked up by the backend (live.py) with the airline API key from the server's .env file,
// so the key never reaches the browser.

function livePath(ride, extra) {
    const q = [`flight=${encodeURIComponent(ride.flight)}`, `date=${encodeURIComponent(ride.date || '')}`,
        `time=${encodeURIComponent(ride.arrival_time || '')}`];
    if (ride.airport) q.push(`airport=${encodeURIComponent(ride.airport)}`);
    return `/api/live?${q.join('&')}${extra || ''}`;
}

// force = the "Refresh now" button (the server still keeps its 2-minute minimum between requests).
// The server only asks the flight service about flights arriving today; other days come back as a saved copy or "Scheduled".
async function fetchLiveFlightData(ride, force) {
    try {
        return await apiFetch(livePath(ride, force ? '&force=1' : ''));
    } catch (error) {
        if (!error.auth) console.error('Live status error:', error);
        return { status: 'API Error', detail: error.message };
    } finally {
        if (!force) setTimeout(loadStatus, 0); else loadStatus();
    }
}


// =============================================================================
// DISPATCH TIME ZONE
// =============================================================================
// The dispatcher may sit in a different time zone from the airport. Flight times in the list are airport
// times, so "Today", the clock and all countdowns use the time zone picked here (saved in this browser).

const STATION_KEY = 'rc-station';
const STATIONS = [
    { id: 'America/Chicago', label: 'Dallas / Chicago' },
    { id: 'America/New_York', label: 'Miami / New York' },
    { id: 'America/Denver', label: 'Denver' },
    { id: 'America/Los_Angeles', label: 'Los Angeles' },
    { id: 'Europe/London', label: 'London' },
    { id: 'Asia/Kathmandu', label: 'Kathmandu' },
    { id: 'UTC', label: 'UTC' },
    { id: '', label: 'This computer' }
];
let stationTz = 'America/Chicago';   // Dallas time is the default
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
    if (window.RCSky) RCSky.setZone(stationTz);
    sel.addEventListener('change', () => {
        stationTz = sel.value;
        if (window.RCSky) RCSky.setZone(stationTz);
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
            `<div class="na-sub">${last ? `Latest on this board: ${esc(last.flight)}, ${esc(last.date)} ${esc(last.arrival_time)}` : 'Upload the month’s manifests or add a flight to get started.'}</div>`;
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
    const txt = diff <= 60000 ? 'Arriving now' : 'in ' + fmtCountdown(diff);
    const cls = 'nextarr' + (diff <= 60000 ? ' now' : diff <= 30 * 60000 ? ' soon' : '');
    if (c.textContent !== txt) c.textContent = txt;      // write only what changed
    if (el.className !== cls) el.className = cls;
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
            d: () => $('theme-btn').click(),
            s: () => $('sky-btn').click()
        }[k];
        if (act) { e.preventDefault(); act(); }
    });
}

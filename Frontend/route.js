/* =============================================================================
   RideCentric LIVE: route diagram + airport weather card.
   Plain browser script, no libraries and no map tiles.

   Route diagram: a world map (world.js) with the flight's route drawn as an arc, e.g. CDG -> MIA. The plane sits
   where the clock says it should be between the departure and the arrival time, and moves every second. It is an
   estimate from the schedule, not a GPS position, so no position data is ever requested from the flight API.

   Weather card: current weather and the forecast for the hour the flight lands, from the server's /api/weather
   (Open-Meteo, free, no key).
   Used by script.js:  RouteView.init(), RouteView.update(ride, live, defaultAirport), RouteView.tick()
   ============================================================================= */
(function () {
    'use strict';

    const RAD = Math.PI / 180, EARTH_KM = 6371, MI_PER_KM = 0.621371;
    const CRUISE_KMH = 800, GROUND_MIN = 25;          // used only when the departure time is unknown
    const PLANE = 'M0,-12 L3,-4 L12,2 L12,5 L3,3 L2,9 L5,11 L5,13 L0,12 L-5,13 L-5,11 L-2,9 L-3,3 L-12,5 L-12,2 L-3,-4 Z';
    const WX_FRESH_MS = 10 * 60 * 1000;

    const pad = (n) => String(n).padStart(2, '0');
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const $ = (id) => document.getElementById(id);

    let airports = null;                 // { IATA: {name, lat, lng} }, from /api/airports
    let airportsState = 'idle';          // idle | loading | ready | failed
    let model = null;                    // what the card currently shows (see resolve())
    let scene = null;                    // the drawn geometry (see layout())
    let inputs = { ride: null, live: null, def: null };
    let W = 0, H = 0, layoutQueued = false, lastAngle = null, lastPaint = '';

    // ---------------------------------------------------------------- small helpers

    function dur(ms) {
        const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
        if (h >= 48) return Math.floor(h / 24) + ' days';
        if (h >= 1) return h + 'h ' + pad(m) + 'm';
        return m + 'm ' + pad(s % 60) + 's';
    }

    function clock(ms) {
        const sp = window.stationParts;
        if (!sp) return '';
        const p = sp(ms), t = sp(Date.now());
        const day = p.d === t.d && p.m === t.m ? '' : ` · ${p.m}/${p.d}`;
        return `${pad(p.h % 12 || 12)}:${pad(p.mi)} ${p.h < 12 ? 'AM' : 'PM'}${day}`;
    }

    function title(s) {
        return String(s || '').toLowerCase().replace(/(^|[\s-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
    }

    function miles(km) { return Math.round(km * MI_PER_KM).toLocaleString('en-US'); }

    function short(name, n) {
        name = String(name || '');
        return name.length > n ? name.slice(0, n - 1).trimEnd() + '…' : name;
    }

    // Great-circle arc between two airports as n+1 points, longitudes unwrapped so the arc never jumps over the date line.
    function arc(a, b, n) {
        const p1 = a.lat * RAD, l1 = a.lng * RAD, p2 = b.lat * RAD, l2 = b.lng * RAD;
        const d = 2 * Math.asin(Math.min(1, Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2)));
        const pts = [];
        let prev = a.lng;
        for (let i = 0; i <= n; i++) {
            const f = i / n;
            let lat, lng;
            if (d < 1e-6 || Math.abs(Math.sin(d)) < 1e-4) {                 // same spot or exactly opposite: straight line
                lat = a.lat + (b.lat - a.lat) * f; lng = a.lng + (b.lng - a.lng) * f;
            } else {
                const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
                const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
                const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
                const z = A * Math.sin(p1) + B * Math.sin(p2);
                lat = Math.atan2(z, Math.sqrt(x * x + y * y)) / RAD; lng = Math.atan2(y, x) / RAD;
            }
            while (lng - prev > 180) lng -= 360;
            while (lng - prev < -180) lng += 360;
            prev = lng;
            pts.push({ lat, lng });
        }
        return { pts, km: d * EARTH_KM };
    }

    // ---------------------------------------------------------------- what to show

    function resolve(ride, liveState, defCode) {
        const A = airports || {};
        const ap = (code) => (code && A[code]) ? Object.assign({ code }, A[code]) : null;
        const m = { mode: 'idle', rideId: null, flight: '', from: null, to: null, status: '', landed: false, cancelled: false,
            live: false, depMs: 0, arrMs: 0, estimated: false, km: 0, note: '', arrived: '', terminal: '' };
        if (!ride) {
            m.to = ap(defCode);
            m.note = airportsState === 'failed' ? 'The airport list could not be loaded.' : 'Select a flight to see its route.';
            return m;
        }
        const ld = liveState && liveState.id === ride.id && liveState.data && !liveState.loading ? liveState.data : null;
        const loading = !!(liveState && liveState.id === ride.id && liveState.loading);
        const route = ld && ld.route;
        m.rideId = ride.id;
        m.flight = ride.flight;
        const st = ld && ld.status && !/^(not found|api |invalid|no live)/i.test(ld.status) ? ld.status : ride.status;
        m.status = title(st);
        m.cancelled = /cancel/i.test(st) || /cancel/i.test(ride.status);
        m.landed = /^landed/i.test(st) || /^(landed|completed)$/i.test(ride.status);
        m.live = !!(ld && !ld.not_today && !ld.saved && route);
        m.arrived = ld && ld.arrived ? ld.arrived : '';
        const to = ap((route && route.dest) || ride.airport || defCode);
        const from = route && route.origin ? ap(route.origin) : null;
        m.to = to;
        m.arrMs = route && route.arr_ts ? route.arr_ts * 1000 : (ride.whenTs || 0);
        if (from && to && from.code !== to.code) {
            const g = arc(from, to, 80);
            m.mode = 'route'; m.from = from; m.km = g.km;
            m.depMs = route.dep_ts ? route.dep_ts * 1000 : 0;
            if (!m.depMs || m.depMs >= m.arrMs) {
                m.depMs = m.arrMs - (g.km / CRUISE_KMH * 3600 + GROUND_MIN * 60) * 1000;
                m.estimated = true;
            }
        } else {
            m.mode = to ? 'dest' : 'idle';
            if (loading) m.note = 'Looking up the route…';
            else if (!ld) m.note = 'The route appears once the flight is looked up.';
            else if (ld.not_today) m.note = 'The route is only looked up for today’s flights.';
            else if (ld.configured === false) m.note = 'Add the flight API key to see the route.';
            else if (route && route.origin && !from) m.note = `Departure airport ${route.origin} is not in the airport list.`;
            else m.note = 'The flight service has not reported the route for this flight yet.';
        }
        if (!to && m.mode !== 'route') { m.mode = 'idle'; m.note = airportsState === 'loading' ? 'Loading airports…' : 'The arrival airport of this flight is not known.'; }
        return m;
    }

    // 0..1: how far along the route the plane is right now.
    function progress(m, now) {
        if (m.cancelled) return 0;
        if (m.landed) return 1;
        let f = (now - m.depMs) / Math.max(1, m.arrMs - m.depMs);
        f = clamp(f, 0, 1);
        if (f >= 1 && m.live) f = 0.985;        // the clock says it should have landed but the flight service has not said so yet
        return f;
    }

    // ---------------------------------------------------------------- the diagram

    function build() {
        const host = $('route-card');
        if (!host || host.dataset.built) return;
        host.dataset.built = '1';
        const land = (window.RC_WORLD && window.RC_WORLD.land) || '';
        host.innerHTML =
            '<div class="rt-wrap" id="rt-wrap" data-mode="idle">' +
            '<svg id="rt-svg" class="rt-svg" role="img" aria-label="Flight route diagram" preserveAspectRatio="none">' +
            `<defs><path id="rt-land" d="${land}"/></defs>` +
            '<g id="rt-grat"></g>' +
            '<g id="rt-landg"><use href="#rt-land" x="-360"/><use href="#rt-land"/><use href="#rt-land" x="360"/></g>' +
            '<g id="rt-dyn"></g></svg>' +
            '<div class="rt-head" id="rt-head"></div>' +
            '<div class="rt-hint" id="rt-hint"></div>' +
            '<div class="rt-foot" id="rt-foot"></div></div>';
        if (window.ResizeObserver) new ResizeObserver(() => queueLayout()).observe(host);
        else window.addEventListener('resize', queueLayout);
    }

    function queueLayout() {
        if (layoutQueued) return;
        layoutQueued = true;
        requestAnimationFrame(() => { layoutQueued = false; layout(); });
    }

    // Draws the parts that only change when the route or the size changes: graticule, land position, arc, airports, plane.
    function layout() {
        const host = $('route-card'), svg = $('rt-svg');
        if (!host || !svg || !model) return;
        W = Math.round(host.clientWidth); H = Math.round(host.clientHeight);
        if (W < 40 || H < 40) return;
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

        const m = model;
        let pts = [], arcPts = null;
        if (m.mode === 'route') { arcPts = arc(m.from, m.to, 80).pts; pts = arcPts; }
        else if (m.to && m.mode === 'dest') pts = [{ lat: m.to.lat, lng: m.to.lng }];

        // room for the header on top and the info bar at the bottom (fixed estimates: the bar is not drawn yet on first layout)
        const padT = Math.min(H * 0.32, 96), padB = Math.min(H * 0.42, m.mode === 'idle' ? 24 : m.mode === 'dest' ? 104 : (W < 520 ? 172 : 124));
        const padX = Math.min(W * 0.18, 64);
        const uw = Math.max(40, W - 2 * padX), uh = Math.max(40, H - padT - padB);
        let minLng, maxLng, minLat, maxLat, s, k;
        if (pts.length) {
            minLng = Math.min(...pts.map((p) => p.lng)); maxLng = Math.max(...pts.map((p) => p.lng));
            minLat = Math.min(...pts.map((p) => p.lat)); maxLat = Math.max(...pts.map((p) => p.lat));
            k = Math.max(0.3, Math.cos(clamp((minLat + maxLat) / 2, -75, 75) * RAD));
            const minSpan = m.mode === 'route' ? 20 : 60;               // short hops keep some surrounding map
            s = Math.max(((maxLng - minLng) * k) / uw, (maxLat - minLat) / uh, (minSpan * k) / uw);
        } else {
            minLng = -180; maxLng = 180; minLat = -5; maxLat = 55;
            k = 0.85; s = (360 * k) / W;                                // nothing selected: the whole world
        }
        const Xc = (((minLng + maxLng) / 2) + 180) * k, Yc = 90 - (minLat + maxLat) / 2;
        const ucx = padX + uw / 2, ucy = padT + uh / 2;
        const vx0 = Xc - ucx * s, vy0 = Yc - ucy * s;
        const P = (lng, lat) => ({ x: ((lng + 180) * k - vx0) / s, y: ((90 - lat) - vy0) / s });

        // graticule: a line every N degrees, N chosen so the lines are at least ~64 px apart
        let step = 30;
        for (const c of [1, 2, 5, 10, 15, 30]) { if (c * Math.min(k, 1) / s >= 64) { step = c; break; } }
        const lo = vx0 / k - 180, hi = (vx0 + W * s) / k - 180, top = 90 - vy0, bot = 90 - (vy0 + H * s);
        let g = '';
        for (let lg = Math.ceil(lo / step) * step; lg <= hi; lg += step) { const x = P(lg, 0).x; g += `M${x.toFixed(1)} 0V${H}`; }
        for (let lt = Math.ceil(Math.max(bot, -90) / step) * step; lt <= Math.min(top, 90); lt += step) { const y = P(0, lt).y; g += `M0 ${y.toFixed(1)}H${W}`; }
        $('rt-grat').innerHTML = `<path class="rt-grat" d="${g}"/>`;
        $('rt-landg').setAttribute('transform', `translate(${(-vx0 / s).toFixed(2)} ${(-vy0 / s).toFixed(2)}) scale(${(k / s).toFixed(5)} ${(1 / s).toFixed(5)})`);

        // route + airports + plane
        let h = '';
        let arcPx = null;
        if (arcPts) {
            arcPx = arcPts.map((p) => P(p.lng, p.lat));
            h += `<path class="rt-arc" d="${'M' + arcPx.map((p) => p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join('L')}"/>`;
            h += '<path class="rt-trail" id="rt-trail" d=""/>';
        }
        // in route mode the ends come from the arc, whose longitudes are unwrapped (a route over the date line)
        const pFrom = arcPx ? arcPx[0] : null;
        const pTo = arcPx ? arcPx[arcPx.length - 1] : (m.to ? P(m.to.lng, m.to.lat) : null);
        const label = (ap, p, other, role, cls) => {
            const right = other ? p.x <= other.x : p.x < W / 2;
            let anchor = right ? 'end' : 'start';
            if (anchor === 'end' && p.x < 118) anchor = 'start';
            if (anchor === 'start' && p.x > W - 118) anchor = 'end';
            const dx = anchor === 'end' ? -22 : 22;       // clear of the plane when it sits on the airport
            return `<g class="rt-ap ${cls}" transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})">` +
                '<circle class="rt-ring" r="9"/><circle class="rt-dot" r="4.5"/>' +
                `<text class="rt-role" x="${dx}" y="-22" text-anchor="${anchor}">${role}</text>` +
                `<text class="rt-code" x="${dx}" y="-6" text-anchor="${anchor}">${esc(ap.code)}</text>` +
                `<text class="rt-name" x="${dx}" y="9" text-anchor="${anchor}">${esc(short(ap.name, 26))}</text></g>`;
        };
        if (pFrom) h += label(m.from, pFrom, pTo, 'DEPARTURE', 'from');
        if (pTo) h += label(m.to, pTo, pFrom, m.mode === 'route' ? 'ARRIVAL' : 'ARRIVING AT', 'to');
        if (arcPx) {
            h += '<g class="rt-plane" id="rt-plane"><g class="rt-rot" id="rt-rot"><circle class="rt-halo" r="17"/>' +
                `<path class="rt-jet" d="${PLANE}" transform="scale(1.2)"/></g></g>`;
        }
        $('rt-dyn').innerHTML = h;
        scene = { arcPx, W, H };
        lastAngle = null; lastPaint = '';
        paint(true);
    }

    // Moves the plane and fills the text. Cheap enough to run every second.
    function paint(force) {
        const wrap = $('rt-wrap');
        if (!wrap || !model) return;
        const m = model, now = Date.now();
        const f = m.mode === 'route' ? progress(m, now) : 0;
        const state = m.cancelled ? 'cancelled' : m.landed ? 'landed' : m.mode === 'route' ? (now < m.depMs ? 'waiting' : 'air') : 'none';
        wrap.dataset.mode = m.mode; wrap.dataset.state = state; wrap.dataset.progress = f.toFixed(4);

        if (m.mode === 'route' && scene && scene.arcPx) {
            const a = scene.arcPx, n = a.length - 1, t = f * n, i = Math.min(n - 1, Math.floor(t)), u = t - i;
            const x = a[i].x + (a[i + 1].x - a[i].x) * u, y = a[i].y + (a[i + 1].y - a[i].y) * u;
            const j0 = Math.max(0, i - 1), j1 = Math.min(n, i + 2);
            let ang = Math.atan2(a[j1].y - a[j0].y, a[j1].x - a[j0].x) / RAD + 90;
            if (lastAngle != null) { while (ang - lastAngle > 180) ang -= 360; while (ang - lastAngle < -180) ang += 360; }
            lastAngle = ang;
            const plane = $('rt-plane'), rot = $('rt-rot'), trail = $('rt-trail');
            if (plane) { plane.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`; rot.style.transform = `rotate(${ang.toFixed(1)}deg)`; }
            if (trail) {
                let d = 'M' + a[0].x.toFixed(1) + ' ' + a[0].y.toFixed(1);
                for (let q = 1; q <= i; q++) d += 'L' + a[q].x.toFixed(1) + ' ' + a[q].y.toFixed(1);
                trail.setAttribute('d', f > 0 ? d + 'L' + x.toFixed(1) + ' ' + y.toFixed(1) : '');
            }
        }

        // text: header, hint, footer
        const sig = [m.mode, m.rideId, m.status, m.arrMs, Math.floor(now / 1000), force ? 1 : 0].join('|');
        if (sig === lastPaint) return;
        lastPaint = sig;
        paintHead(m);
        paintFoot(m, f, now, state);
    }

    function paintHead(m) {
        const el = $('rt-head');
        let left;
        if (m.mode === 'route') left = `<b>${esc(m.from.code)}</b><span class="rt-to">→</span><b>${esc(m.to.code)}</b><span class="rt-chip">${esc(m.flight)}</span>`;
        else if (m.mode === 'dest') left = `<b>${esc(m.flight)}</b><span class="rt-sub">arriving at ${esc(m.to.code)}</span>`;
        else left = '<b>Flight route</b>' + (m.to ? `<span class="rt-sub">${esc(m.to.code)}</span>` : '');
        const sub = m.mode === 'route'
            ? (m.estimated ? 'Departure time estimated from the distance' : 'Position follows the clock · departure to arrival')
            : '';
        el.innerHTML = `<div class="rt-headl"><div class="rt-title">${left}</div>` + (sub ? `<div class="rt-note">${esc(sub)}</div>` : '') + '</div>' +
            '<span class="rt-live" title="The plane moves with the clock. It is an estimate, not a GPS position."><i></i>moves with the clock</span>';
        $('rt-hint').textContent = m.mode === 'route' ? '' : m.note;
        $('rt-hint').hidden = m.mode === 'route' || !m.note;
    }

    function cell(label, value, cls) { return `<div class="${cls || ''}"><label>${esc(label)}</label><b>${value}</b></div>`; }

    function paintFoot(m, f, now, state) {
        const el = $('rt-foot');
        if (m.mode === 'idle') { el.innerHTML = ''; el.hidden = true; return; }
        el.hidden = false;
        const eta = m.arrMs ? clock(m.arrMs) : '';
        if (m.mode === 'dest') {
            const left = m.arrMs - now;
            el.innerHTML = '<div class="rt-info">' + cell('Status', esc(m.status || '—')) + cell('Scheduled arrival', esc(eta || '—')) +
                cell(left >= 0 ? 'Arrives in' : 'Was due', m.arrMs ? esc(dur(Math.abs(left))) + (left < 0 ? ' ago' : '') : '—') + '</div>';
            return;
        }
        const flown = m.km * f, total = m.km;
        let status = m.status;
        if (state === 'cancelled') status = 'Cancelled';
        else if (state === 'landed') status = 'Landed' + (m.arrived ? ' at ' + m.arrived : '');
        else if (state === 'waiting') status = 'Departs in ' + dur(m.depMs - now);
        else if (f >= 0.985) status = 'Arriving';
        else if (f > 0) status = 'In the air';
        const elapsed = state === 'waiting' || state === 'cancelled' ? '—' : dur((state === 'landed' ? m.arrMs : now) - m.depMs);
        const remain = state === 'landed' || state === 'cancelled' ? '—' : (m.arrMs - now > 0 ? dur(m.arrMs - now) : 'any moment');
        el.innerHTML = `<div class="rt-bar"><i style="width:${(f * 100).toFixed(2)}%"></i></div><div class="rt-info">` +
            cell('Status', esc(status), 'rt-st') + cell('Elapsed', esc(elapsed)) +
            cell('Remaining', esc(remain) + (eta && state !== 'landed' && state !== 'cancelled' ? `<small>ETA ${esc(eta)}</small>` : '')) +
            cell('Distance', `${miles(flown)}<small>of ${miles(total)} mi</small>`) + '</div>';
    }

    // ---------------------------------------------------------------- weather card

    const wx = { code: null, at: null, tab: 'arr', state: 'idle', data: null, key: '', req: 0, loadedAt: 0, cache: {} };

    const CLOUD = '<path class="wi-cloud" d="M15 35h19a7 7 0 0 0 .8-13.96A10 10 0 0 0 15.4 19.3 8 8 0 0 0 15 35z"/>';
    const SUN_RAYS = '<g class="wi-rays">' + [0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<path d="M24 5v4" transform="rotate(${a} 24 24)"/>`).join('') + '</g>';
    const ICONS = {
        clear: `<svg viewBox="0 0 48 48" class="wi wi-clear">${SUN_RAYS}<circle class="wi-sun" cx="24" cy="24" r="8"/></svg>`,
        night: '<svg viewBox="0 0 48 48" class="wi wi-night"><path class="wi-moon" d="M32 31A13 13 0 0 1 19 11a13 13 0 1 0 13 20z"/></svg>',
        partly: `<svg viewBox="0 0 48 48" class="wi"><circle class="wi-sun" cx="17" cy="17" r="7"/><g class="wi-rays small">${[0, 60, 120, 180, 240, 300].map((a) => `<path d="M17 4v3" transform="rotate(${a} 17 17)"/>`).join('')}</g><g transform="translate(5 3)">${CLOUD}</g></svg>`,
        cloud: `<svg viewBox="0 0 48 48" class="wi">${CLOUD}</svg>`,
        fog: `<svg viewBox="0 0 48 48" class="wi"><g transform="translate(0 -5)">${CLOUD}</g><path class="wi-line" d="M12 34h24M15 40h18"/></svg>`,
        rain: `<svg viewBox="0 0 48 48" class="wi"><g transform="translate(0 -5)">${CLOUD}</g><path class="wi-drop" d="M17 34l-2 6M25 34l-2 6M33 34l-2 6"/></svg>`,
        snow: `<svg viewBox="0 0 48 48" class="wi"><g transform="translate(0 -5)">${CLOUD}</g><g class="wi-flake"><circle cx="16" cy="36" r="1.8"/><circle cx="25" cy="39" r="1.8"/><circle cx="33" cy="36" r="1.8"/></g></svg>`,
        storm: `<svg viewBox="0 0 48 48" class="wi"><g transform="translate(0 -5)">${CLOUD}</g><path class="wi-bolt" d="M26 28l-6 9h5l-2 7 8-10h-5z"/></svg>`
    };
    const icon = (kind, night) => (kind === 'clear' && night ? ICONS.night : ICONS[kind] || ICONS.cloud);

    function wxAirports() {
        const m = model, list = [];
        if (!m) return list;
        if (m.mode === 'route') { list.push({ tab: 'arr', label: 'Arrival', code: m.to.code }); list.push({ tab: 'dep', label: 'Departure', code: m.from.code }); }
        else if (m.to) list.push({ tab: 'arr', label: 'Arrival', code: m.to.code });
        return list;
    }

    function wxUpdate() {
        const host = $('wx-card');
        if (!host) return;
        const list = wxAirports();
        if (!list.length) {
            wx.code = null; wx.state = 'idle'; wx.key = '';
            const empty = '<div class="wx-head"><span class="wx-title">Weather</span></div><div class="wx-empty">Weather appears for the airport of the selected flight.</div>';
            if (host._html !== empty) { host._html = empty; host.innerHTML = empty; }
            return;
        }
        let pick = list.find((x) => x.tab === wx.tab) || list[0];
        wx.tab = pick.tab;
        const at = pick.tab === 'arr' && model.arrMs ? Math.round(model.arrMs / 1000) : (pick.tab === 'dep' && model.depMs ? Math.round(model.depMs / 1000) : null);
        const key = pick.code + '|' + (at ? Math.floor(at / 3600) : '');
        const stale = Date.now() - wx.loadedAt > WX_FRESH_MS;
        wx.code = pick.code; wx.at = at;
        if (key === wx.key && !stale && wx.state !== 'failed') { wxPaint(list); return; }
        wx.key = key;
        const hit = wx.cache[key];
        if (hit && Date.now() - hit.t < WX_FRESH_MS) { wx.data = hit.d; wx.state = 'ready'; wx.loadedAt = hit.t; wxPaint(list); return; }
        wx.state = 'loading'; wx.data = null; wxPaint(list);
        const req = ++wx.req;
        window.apiFetch(`/api/weather?airport=${encodeURIComponent(pick.code)}` + (at ? `&at=${at}` : '')).then((d) => {
            if (req !== wx.req) return;
            wx.cache[key] = { t: Date.now(), d }; wx.data = d; wx.state = 'ready'; wx.loadedAt = Date.now();
            wxPaint(wxAirports());
        }).catch((e) => {
            if (req !== wx.req || (e && e.auth)) return;
            wx.state = 'failed'; wx.data = { error: 'Weather could not be loaded.' }; wx.loadedAt = Date.now();
            wxPaint(wxAirports());
        });
    }

    function wxPaint(list) {
        const host = $('wx-card');
        if (!host) return;
        const ap = (airports || {})[wx.code] || {};
        const d = wx.data;
        let h = `<div class="wx-head"><span class="wx-title">Weather</span><span class="wx-ap"><b>${esc(wx.code)}</b> ${esc(short(ap.name || '', 28))}</span></div>`;
        if (list.length > 1) {
            h += '<div class="wx-tabs" role="tablist">' + list.map((x) => `<button type="button" role="tab" class="wx-tab${x.tab === wx.tab ? ' on' : ''}" data-wx="${x.tab}" aria-selected="${x.tab === wx.tab}">${x.label} <b>${esc(x.code)}</b></button>`).join('') + '</div>';
        }
        if (wx.state === 'loading' || !d) {
            h += '<div class="wx-skel"><i></i><i></i><i></i></div>';
        } else if (!d.current) {
            h += `<div class="wx-empty">${esc(d.error || 'No weather for this airport.')}</div>`;
        } else {
            const c = d.current;
            h += `<div class="wx-main"><div class="wx-ico">${icon(c.kind, c.night)}</div>` +
                `<div class="wx-temp"><b>${c.temp == null ? '—' : c.temp + '°'}</b><span>F</span></div>` +
                `<div class="wx-desc"><b>${esc(c.text)}</b><span>${c.feels == null ? '' : 'Feels like ' + c.feels + '°'}</span></div></div>` +
                '<div class="wx-grid">' +
                `<div><label>Wind</label><b>${c.wind == null ? '—' : c.wind + ' mph'}${c.dir ? ' <small>' + esc(c.dir) + '</small>' : ''}</b></div>` +
                `<div><label>Gusts</label><b>${c.gust == null ? '—' : c.gust + ' mph'}</b></div>` +
                `<div><label>Humidity</label><b>${c.humidity == null ? '—' : c.humidity + '%'}</b></div>` +
                `<div><label>Clouds</label><b>${c.clouds == null ? '—' : c.clouds + '%'}</b></div></div>`;
            if (d.arrival) {
                const a = d.arrival, when = wx.tab === 'dep' ? 'At departure' : 'At arrival';
                h += `<div class="wx-arr"><div class="wx-tag">${when} <span>${esc(a.time)} local</span></div>` +
                    `<div class="wx-row"><span class="wx-mini">${icon(a.kind, false)}</span><b>${a.temp == null ? '—' : a.temp + '°F'}</b><span>${esc(a.text)}</span></div>` +
                    `<div class="wx-sub">${a.precip_pct == null ? '' : 'Rain chance ' + a.precip_pct + '%'}${a.wind == null ? '' : ' · Wind ' + a.wind + ' mph'}</div></div>`;
            }
            if (d.error) h += `<div class="wx-warn">${esc(d.error)}</div>`;
        }
        const upd = d && d.updated ? ` · updated ${Math.max(0, Math.round((Date.now() / 1000 - d.updated) / 60))} min ago` : '';
        h += `<div class="wx-foot"><a href="https://open-meteo.com/" target="_blank" rel="noopener">Weather data by Open-Meteo.com</a>${upd}</div>`;
        if (host._html !== h) { host._html = h; host.innerHTML = h; }
    }

    // ---------------------------------------------------------------- loading + public interface

    function loadAirports() {
        if (airportsState === 'loading' || airportsState === 'ready') return;
        airportsState = 'loading';
        window.apiFetch('/api/airports').then((d) => {
            airports = d && typeof d === 'object' ? d : {};
            airportsState = 'ready';
            refresh();
        }).catch((e) => {
            if (e && e.auth) return;
            airportsState = 'failed'; airports = {};
            refresh();
        });
    }

    function refresh() {
        const before = model ? [model.mode, model.from && model.from.code, model.to && model.to.code].join() : '';
        model = resolve(inputs.ride, inputs.live, inputs.def);
        const after = [model.mode, model.from && model.from.code, model.to && model.to.code].join();
        if (!scene || before !== after) queueLayout(); else paint(true);
        wxUpdate();
    }

    function init() {
        build();
        const wc = $('wx-card');
        if (wc) wc.addEventListener('click', (e) => {
            const b = e.target.closest('[data-wx]');
            if (!b) return;
            wx.tab = b.getAttribute('data-wx');
            wxUpdate();
        });
        model = resolve(null, null, null);
        queueLayout();
        loadAirports();
    }

    function update(ride, live, defAirport) {
        if (!$('route-card')) return;
        const prev = inputs.ride && inputs.ride.id;
        inputs = { ride: ride || null, live: live || null, def: defAirport || null };
        if ((ride && ride.id) !== prev) wx.tab = 'arr';
        refresh();
    }

    function tick() {
        if (!model) return;
        paint(false);
        if (wx.code && Date.now() - wx.loadedAt > WX_FRESH_MS && wx.state === 'ready') wxUpdate();
    }

    window.RouteView = { init, update, tick, _model: () => model };
})();

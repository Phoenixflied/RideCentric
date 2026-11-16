/* =============================================================================
   RideCentric LIVE: route diagram + airport weather card.
   Plain browser script, no libraries and no map tiles.

   Route diagram: a world map (world.js) with the flight's route drawn as an arc, e.g. CDG -> MIA. The plane sits
   where the clock says it should be between the departure and the arrival time, and moves every second. It is an
   estimate from the schedule, not a GPS position, so no position data is ever requested from the flight API.

   Weather card: current weather and the forecast for the hour the flight lands, from the server's /api/weather
   (Open-Meteo, free, no key).
   The map can be moved and zoomed (drag, mouse wheel / pinch, the + and - buttons, double click), and it can follow the plane.
   The status of the flight (status, elapsed, remaining, distance) is shown in a strip just below the map.
   Used by script.js:  RouteView.init(), RouteView.update(ride, live, defaultAirport, stations), RouteView.tick()
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
    let inputs = { ride: null, live: null, def: null, stations: [] };
    let W = 0, H = 0, layoutQueued = false, lastAngle = null, lastPaint = '';
    // the part of the world on screen: k = width factor of the projection, s = degrees per pixel, cx/cy = centre (projected degrees)
    let vp = null, fit = null, limits = null, fitKey = '', moved = false, follow = false, tween = 0, goal = null;   // goal = where a running zoom animation is heading

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
        const to = ap((route && route.dest) || ride.airport || defCode || (inputs.stations || [])[0]);
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

    const ICO_FIT = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
    const ICO_FOLLOW = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="8"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3"/></svg>';

    function build() {
        const host = $('route-card');
        if (!host || host.dataset.built) return;
        host.dataset.built = '1';
        const land = (window.RC_WORLD && window.RC_WORLD.land) || '';
        const touch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
        host.innerHTML =
            '<div class="rt-wrap" id="rt-wrap" data-mode="idle">' +
            '<div class="rt-stage" id="rt-stage" tabindex="0" role="application" aria-label="Route map. Drag to move, scroll or pinch to zoom. The plus and minus keys zoom, the arrow keys move.">' +
            '<svg id="rt-svg" class="rt-svg" role="img" aria-label="Flight route diagram" preserveAspectRatio="none">' +
            `<defs><path id="rt-land" d="${land}"/></defs>` +
            '<g id="rt-grat"></g>' +
            '<g id="rt-landg"><use href="#rt-land" x="-360"/><use href="#rt-land"/><use href="#rt-land" x="360"/></g>' +
            '<g id="rt-dyn"></g></svg>' +
            '<div class="rt-head" id="rt-head"></div>' +
            '<div class="rt-hint" id="rt-hint"></div>' +
            `<div class="rt-tip" id="rt-tip">${touch ? 'Pinch to zoom · drag to move' : 'Drag to move · scroll to zoom'}</div>` +
            '<div class="rt-ctl" id="rt-ctl">' +
            '<button type="button" data-z="in" title="Zoom in" aria-label="Zoom in">+</button>' +
            '<button type="button" data-z="out" title="Zoom out" aria-label="Zoom out">&minus;</button>' +
            `<button type="button" data-z="fit" title="Show the whole route" aria-label="Show the whole route">${ICO_FIT}</button>` +
            `<button type="button" data-z="follow" title="Keep the plane in the middle" aria-label="Follow the plane" aria-pressed="false">${ICO_FOLLOW}</button>` +
            '</div></div>' +
            '<div class="rt-foot" id="rt-foot"></div></div>';
        const stage = $('rt-stage');
        if (window.ResizeObserver) new ResizeObserver(() => queueLayout()).observe(stage);
        else window.addEventListener('resize', queueLayout);
        bindView(stage);
    }

    function queueLayout() {
        if (layoutQueued) return;
        layoutQueued = true;
        requestAnimationFrame(() => { layoutQueued = false; layout(); });
    }

    // The view that shows the whole route (or the whole world when nothing is selected) in the free space of the map.
    function fitView(m, w, h) {
        let pts = [];
        if (m.mode === 'route') pts = arc(m.from, m.to, 80).pts;
        else if (m.to && m.mode === 'dest') pts = [{ lat: m.to.lat, lng: m.to.lng }];
        // room for the title at the top (and the hint line at the bottom when there is no route)
        const padT = Math.min(h * 0.3, 88), padB = m.mode === 'route' ? 36 : 64, padX = Math.min(w * 0.16, 64);
        const uw = Math.max(40, w - 2 * padX), uh = Math.max(40, h - padT - padB);
        let minLng, maxLng, minLat, maxLat, s, k;
        if (pts.length) {
            minLng = Math.min(...pts.map((p) => p.lng)); maxLng = Math.max(...pts.map((p) => p.lng));
            minLat = Math.min(...pts.map((p) => p.lat)); maxLat = Math.max(...pts.map((p) => p.lat));
            k = Math.max(0.3, Math.cos(clamp((minLat + maxLat) / 2, -75, 75) * RAD));
            const minSpan = m.mode === 'route' ? 20 : 60;               // short hops keep some surrounding map
            s = Math.max(((maxLng - minLng) * k) / uw, (maxLat - minLat) / uh, (minSpan * k) / uw);
        } else {
            minLng = -180; maxLng = 180; minLat = -5; maxLat = 55;
            k = 0.85; s = (360 * k) / w;                                // nothing selected: the whole world
        }
        const Xc = (((minLng + maxLng) / 2) + 180) * k, Yc = 90 - (minLat + maxLat) / 2;
        const ucx = padX + uw / 2, ucy = padT + uh / 2;
        return { k, s, cx: Xc - ucx * s + (w / 2) * s, cy: Yc - ucy * s + (h / 2) * s };
    }

    function limitsFor(k, s0, w) {
        const sWorld = (360 * k) / w;
        return { sMin: sWorld / 60, sMax: Math.max(sWorld, s0) };
    }

    // Keeps the view on the map: zoomed out no further than the whole world, and not beyond the poles or the repeated copies of the land.
    function bound(v) {
        const lim = limits || { sMin: 0.001, sMax: 5 };
        const s = clamp(v.s, lim.sMin, lim.sMax), k = v.k;
        const cx = clamp(v.cx, -180 * k, 540 * k);
        const halfH = (H * s) / 2;
        const cy = halfH >= 90 ? 90 : clamp(v.cy, halfH, 180 - halfH);
        return { k, s, cx, cy };
    }

    // Draws the parts that only change when the route, the size or the view changes: graticule, land, arc, airports, plane.
    function layout() {
        const stage = $('rt-stage'), svg = $('rt-svg');
        if (!stage || !svg || !model) return;
        W = Math.round(stage.clientWidth); H = Math.round(stage.clientHeight);
        if (W < 40 || H < 40) return;
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        const m = model;

        const key = [m.mode, m.rideId, m.from && m.from.code, m.to && m.to.code].join('|');
        fit = fitView(m, W, H);
        limits = limitsFor(fit.k, fit.s, W);
        if (key !== fitKey) { fitKey = key; moved = false; follow = false; }
        if (!vp || !moved) vp = { k: fit.k, s: fit.s, cx: fit.cx, cy: fit.cy };
        else vp = bound(vp);
        const k = vp.k, s = vp.s;
        const vx0 = vp.cx - (W / 2) * s, vy0 = vp.cy - (H / 2) * s;
        const P = (lng, lat) => ({ x: ((lng + 180) * k - vx0) / s, y: ((90 - lat) - vy0) / s });

        // graticule: a line every N degrees, N chosen so the lines are at least ~64 px apart
        let step = 30;
        for (const c of [0.25, 0.5, 1, 2, 5, 10, 15, 30]) { if (c * Math.min(k, 1) / s >= 64) { step = c; break; } }
        const lo = vx0 / k - 180, hi = (vx0 + W * s) / k - 180, top = 90 - vy0, bot = 90 - (vy0 + H * s);
        let g = '';
        for (let lg = Math.ceil(lo / step) * step; lg <= hi; lg += step) { const x = P(lg, 0).x; g += `M${x.toFixed(1)} 0V${H}`; }
        for (let lt = Math.ceil(Math.max(bot, -90) / step) * step; lt <= Math.min(top, 90); lt += step) { const y = P(0, lt).y; g += `M0 ${y.toFixed(1)}H${W}`; }
        $('rt-grat').innerHTML = `<path class="rt-grat" d="${g}"/>`;
        $('rt-landg').setAttribute('transform', `translate(${(-vx0 / s).toFixed(2)} ${(-vy0 / s).toFixed(2)}) scale(${(k / s).toFixed(5)} ${(1 / s).toFixed(5)})`);

        // route + airports + plane
        let h = '';
        let arcPx = null, arcU = null;
        if (m.mode === 'route') {
            const pts = arc(m.from, m.to, 80).pts;
            arcU = pts.map((p) => ({ X: (p.lng + 180) * k, Y: 90 - p.lat }));
            arcPx = arcU.map((u) => ({ x: (u.X - vx0) / s, y: (u.Y - vy0) / s }));
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
        scene = { arcPx, arcU, W, H };
        lastAngle = null; lastPaint = '';
        updateCtl();
        paint(true);
    }

    // ---------------------------------------------------------------- moving and zooming the map

    function updateCtl() {
        const c = $('rt-ctl');
        if (!c || !vp || !limits) return;
        const set = (z, off) => { const b = c.querySelector(`[data-z="${z}"]`); if (b) b.disabled = off; };
        set('in', vp.s <= limits.sMin * 1.001);
        set('out', vp.s >= limits.sMax * 0.999);
        set('fit', !moved);
        const f = c.querySelector('[data-z="follow"]');
        if (f) { f.disabled = !(model && model.mode === 'route'); f.classList.toggle('on', follow); f.setAttribute('aria-pressed', follow ? 'true' : 'false'); }
    }

    function setView(v, keepFollow, animated) {
        if (!vp) return;
        vp = bound(v);
        moved = true;
        if (!animated) goal = null;                 // the user took over
        if (!keepFollow) follow = false;
        const st = $('rt-stage');
        if (st) st.classList.add('used');
        queueLayout();
    }

    // Zoom by `factor` keeping the map point under (px, py) in place (px, py in stage pixels).
    function zoomAt(px, py, factor, immediate) {
        if (!vp) return;
        if (follow) { px = W / 2; py = H / 2; }
        const base = (!immediate && goal) || vp;      // quick repeated clicks add up: zoom from where the running animation is heading
        const s2 = clamp(base.s / factor, limits.sMin, limits.sMax);
        const wx0 = base.cx + (px - W / 2) * base.s, wy0 = base.cy + (py - H / 2) * base.s;      // map point under the cursor
        const target = { k: vp.k, s: s2, cx: wx0 - (px - W / 2) * s2, cy: wy0 - (py - H / 2) * s2 };
        if (immediate) setView(target, true); else animateTo(target, true);
    }

    function animateTo(target, keepFollow) {
        const from = Object.assign({}, vp), t0 = performance.now(), id = ++tween, dur = 180;
        goal = target;
        const step = (now) => {
            if (id !== tween) return;
            const u = clamp((now - t0) / dur, 0, 1), e = 1 - Math.pow(1 - u, 3);
            setView({ k: from.k, s: from.s * Math.pow(target.s / from.s, e), cx: from.cx + (target.cx - from.cx) * e, cy: from.cy + (target.cy - from.cy) * e }, keepFollow, true);
            if (u < 1) requestAnimationFrame(step); else goal = null;
        };
        requestAnimationFrame(step);
    }

    function fitAgain() {
        if (!fit) return;
        tween++;
        goal = null;
        follow = false;
        const from = Object.assign({}, vp), t0 = performance.now(), id = ++tween;
        const step = (now) => {
            if (id !== tween) return;
            const u = clamp((now - t0) / 220, 0, 1), e = 1 - Math.pow(1 - u, 3);
            vp = { k: fit.k, s: from.s * Math.pow(fit.s / from.s, e), cx: from.cx + (fit.cx - from.cx) * e, cy: from.cy + (fit.cy - from.cy) * e };
            if (u < 1) { requestAnimationFrame(step); queueLayout(); }
            else { moved = false; queueLayout(); }
        };
        requestAnimationFrame(step);
    }

    function bindView(stage) {
        const local = (e) => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
        const ptrs = new Map();

        stage.addEventListener('wheel', (e) => {
            e.preventDefault();
            const q = local(e), unit = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 0.5 : e.ctrlKey ? 0.01 : 0.0016;
            tween++;
            zoomAt(q.x, q.y, clamp(Math.exp(-e.deltaY * unit), 0.6, 1.7), true);
        }, { passive: false });

        stage.addEventListener('dblclick', (e) => {
            if (e.target.closest('.rt-ctl')) return;
            const q = local(e);
            zoomAt(q.x, q.y, 2);
        });

        stage.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.rt-ctl') || (e.pointerType === 'mouse' && e.button !== 0)) return;
            ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
            try { stage.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
            stage.classList.add('drag');
            tween++;
        });
        stage.addEventListener('pointermove', (e) => {
            const p = ptrs.get(e.pointerId);
            if (!p || !vp) return;
            if (ptrs.size === 1) {
                const dx = e.clientX - p.x, dy = e.clientY - p.y;
                p.x = e.clientX; p.y = e.clientY;
                if (dx || dy) setView({ k: vp.k, s: vp.s, cx: vp.cx - dx * vp.s, cy: vp.cy - dy * vp.s });
            } else if (ptrs.size === 2) {                         // two fingers: pinch to zoom, and move with the middle
                const ids = Array.from(ptrs.keys()), other = ptrs.get(ids[0] === e.pointerId ? ids[1] : ids[0]);
                const d0 = Math.hypot(p.x - other.x, p.y - other.y), m0 = { x: (p.x + other.x) / 2, y: (p.y + other.y) / 2 };
                p.x = e.clientX; p.y = e.clientY;
                const d1 = Math.hypot(p.x - other.x, p.y - other.y), m1 = { x: (p.x + other.x) / 2, y: (p.y + other.y) / 2 };
                setView({ k: vp.k, s: vp.s, cx: vp.cx - (m1.x - m0.x) * vp.s, cy: vp.cy - (m1.y - m0.y) * vp.s }, true);
                if (d0 > 8 && d1 > 8) { const r = stage.getBoundingClientRect(); zoomAt(m1.x - r.left, m1.y - r.top, d1 / d0, true); }
            }
        });
        const up = (e) => {
            ptrs.delete(e.pointerId);
            try { stage.releasePointerCapture(e.pointerId); } catch (err) { /* not captured */ }
            if (!ptrs.size) stage.classList.remove('drag');
        };
        stage.addEventListener('pointerup', up);
        stage.addEventListener('pointercancel', up);

        $('rt-ctl').addEventListener('click', (e) => {
            const b = e.target.closest('[data-z]');
            if (!b || b.disabled || !vp) return;
            const z = b.getAttribute('data-z');
            if (z === 'in') zoomAt(W / 2, H / 2, 1.7);
            else if (z === 'out') zoomAt(W / 2, H / 2, 1 / 1.7);
            else if (z === 'fit') fitAgain();
            else if (z === 'follow') { follow = !follow; if (follow) { moved = true; stage.classList.add('used'); } paint(true); updateCtl(); }
        });

        stage.addEventListener('keydown', (e) => {
            if (!vp || e.ctrlKey || e.metaKey || e.altKey) return;
            const move = (dx, dy) => { e.preventDefault(); setView({ k: vp.k, s: vp.s, cx: vp.cx + dx * W * vp.s * 0.15, cy: vp.cy + dy * H * vp.s * 0.15 }); };
            if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAt(W / 2, H / 2, 1.7); }
            else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomAt(W / 2, H / 2, 1 / 1.7); }
            else if (e.key === '0' || e.key === 'Home') { e.preventDefault(); fitAgain(); }
            else if (e.key === 'ArrowLeft') move(-1, 0);
            else if (e.key === 'ArrowRight') move(1, 0);
            else if (e.key === 'ArrowUp') move(0, -1);
            else if (e.key === 'ArrowDown') move(0, 1);
        });
    }

    // Where the plane is on the drawn route at progress f (0..1): pixels, projected units and heading.
    function planeAt(f) {
        const a = scene.arcPx, u = scene.arcU, n = a.length - 1, t = f * n, i = Math.min(n - 1, Math.floor(t)), r = t - i;
        const j0 = Math.max(0, i - 1), j1 = Math.min(n, i + 2);
        return {
            i, x: a[i].x + (a[i + 1].x - a[i].x) * r, y: a[i].y + (a[i + 1].y - a[i].y) * r,
            X: u[i].X + (u[i + 1].X - u[i].X) * r, Y: u[i].Y + (u[i + 1].Y - u[i].Y) * r,
            ang: Math.atan2(a[j1].y - a[j0].y, a[j1].x - a[j0].x) / RAD + 90
        };
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
            const pl = planeAt(f);
            if (follow && vp) {
                const tgt = bound({ k: vp.k, s: vp.s, cx: pl.X, cy: pl.Y });
                if (Math.abs(tgt.cx - vp.cx) > vp.s * 0.4 || Math.abs(tgt.cy - vp.cy) > vp.s * 0.4) {
                    vp = tgt;                                               // keep the plane in the middle: draw again around it
                    queueLayout();
                    return;
                }
            }
            let ang = pl.ang;
            if (lastAngle != null) { while (ang - lastAngle > 180) ang -= 360; while (ang - lastAngle < -180) ang += 360; }
            lastAngle = ang;
            const plane = $('rt-plane'), rot = $('rt-rot'), trail = $('rt-trail'), a = scene.arcPx;
            if (plane) { plane.style.transform = `translate(${pl.x.toFixed(1)}px, ${pl.y.toFixed(1)}px)`; rot.style.transform = `rotate(${ang.toFixed(1)}deg)`; }
            if (trail) {
                let d = 'M' + a[0].x.toFixed(1) + ' ' + a[0].y.toFixed(1);
                for (let q = 1; q <= pl.i; q++) d += 'L' + a[q].x.toFixed(1) + ' ' + a[q].y.toFixed(1);
                trail.setAttribute('d', f > 0 ? d + 'L' + pl.x.toFixed(1) + ' ' + pl.y.toFixed(1) : '');
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
    // Shows the weather at the airport where the selected flight LANDS (and, on a second tab, where it took off).
    // Below it, one small tile per station where the flights of the day land; a tile opens that station in the card.

    const wx = { code: null, at: null, tab: 'arr', pin: null, state: 'idle', data: null, key: '', req: 0, loadedAt: 0, cache: {}, st: {}, minute: 0 };

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

    // the airports the card can show for the selected flight: where it lands, and where it took off
    function wxAirports() {
        const m = model, list = [];
        if (!m) return list;
        if (m.mode === 'route') { list.push({ tab: 'arr', label: 'Landing', code: m.to.code }); list.push({ tab: 'dep', label: 'Departure', code: m.from.code }); }
        else if (m.to) list.push({ tab: 'arr', label: m.rideId ? 'Landing' : 'Station', code: m.to.code });
        return list;
    }

    // what the card shows right now
    function wxView(list) {
        if (wx.pin) return { tab: 'pin', label: 'Station', code: wx.pin, at: null };
        const pick = list.find((x) => x.tab === wx.tab) || list[0];
        if (!pick) return null;
        const at = pick.tab === 'arr' && model.arrMs ? Math.round(model.arrMs / 1000) : (pick.tab === 'dep' && model.depMs ? Math.round(model.depMs / 1000) : null);
        return { tab: pick.tab, label: pick.label, code: pick.code, at: model.rideId ? at : null };
    }

    function localClock(d) {
        if (!d || d.utc_offset == null) return '';
        const t = new Date(Date.now() + d.utc_offset * 1000), h = t.getUTCHours();
        return `${h % 12 || 12}:${pad(t.getUTCMinutes())} ${h < 12 ? 'AM' : 'PM'}${d.tz ? ' ' + d.tz : ''}`;
    }

    function wxUpdate() {
        const host = $('wx-card');
        if (!host) return;
        const list = wxAirports(), view = wxView(list);
        if (!view) {
            wx.code = null; wx.state = 'idle'; wx.key = '';
            const empty = '<div class="wx-head"><span class="wx-title">Weather</span></div><div class="wx-empty">Weather appears for the airport where the selected flight lands.</div>';
            if (host._html !== empty) { host._html = empty; host.innerHTML = empty; }
            return;
        }
        wx.tab = view.tab === 'pin' ? wx.tab : view.tab;
        const key = view.code + '|' + (view.at ? Math.floor(view.at / 3600) : '');
        const stale = Date.now() - wx.loadedAt > WX_FRESH_MS;
        wx.code = view.code; wx.at = view.at;
        wxStations();
        if (key === wx.key && !stale && wx.state !== 'failed') { wxPaint(); return; }
        wx.key = key;
        const hit = wx.cache[key];
        if (hit && Date.now() - hit.t < WX_FRESH_MS) { wx.data = hit.d; wx.state = 'ready'; wx.loadedAt = hit.t; wxPaint(); return; }
        wx.state = 'loading'; wx.data = null; wxPaint();
        const req = ++wx.req;
        window.apiFetch(`/api/weather?airport=${encodeURIComponent(view.code)}` + (view.at ? `&at=${view.at}` : '')).then((d) => {
            if (req !== wx.req) return;
            wx.cache[key] = { t: Date.now(), d }; wx.data = d; wx.state = 'ready'; wx.loadedAt = Date.now();
            wxPaint();
        }).catch((e) => {
            if (req !== wx.req || (e && e.auth)) return;
            wx.state = 'failed'; wx.data = { error: 'Weather could not be loaded.' }; wx.loadedAt = Date.now();
            wxPaint();
        });
    }

    // current weather of every station tile (one small request each, remembered 10 minutes here and 30 minutes on the server)
    function wxStations() {
        const codes = (inputs.stations || []).filter((c) => airports && airports[c]);
        if (codes.length < 2) return;
        const todo = codes.filter((c) => { const e = wx.st[c]; return !e || (!e.busy && Date.now() - e.t > WX_FRESH_MS); });
        if (!todo.length) return;
        todo.forEach((c) => { wx.st[c] = Object.assign(wx.st[c] || { d: null }, { busy: true, t: wx.st[c] ? wx.st[c].t : 0 }); });
        const run = (i) => {
            if (i >= todo.length) return;
            const c = todo[i];
            window.apiFetch(`/api/weather?airport=${encodeURIComponent(c)}`).then((d) => { wx.st[c] = { d, t: Date.now(), busy: false }; })
                .catch((e) => { wx.st[c] = { d: null, t: Date.now(), busy: false, failed: true }; if (e && e.auth) i = todo.length; })
                .then(() => { wxPaint(); run(i + 1); });
        };
        run(0);
    }

    function wxPaint() {
        const host = $('wx-card');
        if (!host || !wx.code) return;
        const list = wxAirports(), view = wxView(list) || { tab: 'arr', label: 'Station' };
        const ap = (airports || {})[wx.code] || {};
        const d = wx.data;
        const local = d && d.current ? localClock(d) : '';
        let h = `<div class="wx-head"><span class="wx-title">Weather<em class="wx-role">${esc(view.label)}</em></span>` +
            `<span class="wx-ap"><span><b>${esc(wx.code)}</b> ${esc(short(ap.name || '', 28))}</span>${local ? `<span class="wx-local">Local time ${esc(local)}</span>` : ''}</span></div>`;
        if (list.length > 1) {
            h += '<div class="wx-tabs" role="tablist">' + list.map((x) => `<button type="button" role="tab" class="wx-tab${!wx.pin && x.tab === view.tab ? ' on' : ''}" data-wx="${x.tab}" aria-selected="${!wx.pin && x.tab === view.tab}">${x.label} <b>${esc(x.code)}</b></button>`).join('') + '</div>';
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
                const a = d.arrival, when = view.tab === 'dep' ? 'At departure' : 'At landing';
                h += `<div class="wx-arr"><div class="wx-tag">${when} <span>${esc(a.time)} local</span></div>` +
                    `<div class="wx-row"><span class="wx-mini">${icon(a.kind, false)}</span><b>${a.temp == null ? '—' : a.temp + '°F'}</b><span>${esc(a.text)}</span></div>` +
                    `<div class="wx-sub">${a.precip_pct == null ? '' : 'Rain chance ' + a.precip_pct + '%'}${a.wind == null ? '' : ' · Wind ' + a.wind + ' mph'}</div></div>`;
            }
            if (d.error) h += `<div class="wx-warn">${esc(d.error)}</div>`;
        }
        const codes = (inputs.stations || []).filter((c) => airports && airports[c]);
        if (codes.length > 1) {
            h += '<div class="wx-stations"><label>Stations today</label><div class="wx-chips">' + codes.map((c) => {
                const e = wx.st[c], cur = e && e.d && e.d.current;
                const nm = ((airports[c] || {}).name || c).replace(/"/g, '');
                return `<button type="button" class="wx-chip${c === wx.code ? ' on' : ''}" data-wxst="${esc(c)}" title="${esc(c + ' · ' + nm)}">` +
                    `<span class="wx-ci">${cur ? icon(cur.kind, cur.night) : ''}</span><b>${esc(c)}</b><em>${cur && cur.temp != null ? cur.temp + '°' : (e && e.failed ? '—' : '…')}</em></button>`;
            }).join('') + '</div></div>';
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
            const t = e.target.closest('[data-wx]'), c = e.target.closest('[data-wxst]');
            if (t) { wx.pin = null; wx.tab = t.getAttribute('data-wx'); wxUpdate(); }
            else if (c) {
                const code = c.getAttribute('data-wxst');
                if (model && model.rideId && model.to && model.to.code === code) { wx.pin = null; wx.tab = 'arr'; }    // the station where this flight lands
                else wx.pin = code;
                wxUpdate();
            }
        });
        model = resolve(null, null, null);
        queueLayout();
        loadAirports();
    }

    function update(ride, live, defAirport, stations) {
        if (!$('route-card')) return;
        const prev = inputs.ride && inputs.ride.id;
        inputs = { ride: ride || null, live: live || null, def: defAirport || null, stations: Array.isArray(stations) ? stations : [] };
        if ((ride && ride.id) !== prev) { wx.tab = 'arr'; wx.pin = null; }
        refresh();
    }

    function tick() {
        if (!model) return;
        paint(false);
        if (wx.code && Date.now() - wx.loadedAt > WX_FRESH_MS && wx.state === 'ready') wxUpdate();
        const min = Math.floor(Date.now() / 60000);
        if (min !== wx.minute) { wx.minute = min; if (wx.code && wx.state === 'ready') wxPaint(); wxStations(); }     // the airport's local clock, and tiles that went stale
    }

    function view() { return vp && fit ? { s: vp.s, k: vp.k, cx: vp.cx, cy: vp.cy, fitS: fit.s, zoom: fit.s / vp.s, moved, follow, W, H } : null; }

    window.RouteView = { init, update, tick, _model: () => model, _view: view, _wx: () => wx };
})();

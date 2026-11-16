/* =============================================================================
   RideCentric LIVE: time-of-day sky and the Bright / Dark mode.

   Behind the whole dashboard there is a sky that follows the sun at the dispatch station (the time zone picked in
   the header): sunrise, morning, afternoon, evening, night. The position of the sun comes from the date and the
   station's coordinates (no service, no key). At night there are stars and the moon (with its real phase).

   Two switches in the header:
     Sky   on / off   the time-of-day sky. While it is on, the dashboard also switches between Bright and Dark by itself
                      (Bright by day, Dark after sunset).
     Sun / moon button  forces Bright or Dark. Turning Sky off and on again goes back to automatic.

   Loaded in <head> so the right colours are there before the first paint:  RCSky.boot() runs at once,
   RCSky.init() runs when the page is ready.  Used by script.js:  RCSky.setZone(tz)
   ============================================================================= */
(function () {
    'use strict';

    const K_SKY = 'rc-sky', K_MODE = 'rc-mode', K_THEME = 'rc-theme', K_STATION = 'rc-station';
    const RAD = Math.PI / 180, DEG = 180 / Math.PI;
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const root = document.documentElement;

    // Where the sun is measured for each dispatch time zone (the zone list in script.js).
    const ZONES = {
        'America/Chicago': { lat: 32.90, lng: -97.04, city: 'Dallas' },
        'America/New_York': { lat: 40.64, lng: -73.78, city: 'New York' },
        'America/Denver': { lat: 39.86, lng: -104.67, city: 'Denver' },
        'America/Los_Angeles': { lat: 33.94, lng: -118.41, city: 'Los Angeles' },
        'Europe/London': { lat: 51.47, lng: -0.45, city: 'London' },
        'Asia/Kathmandu': { lat: 27.70, lng: 85.36, city: 'Kathmandu' },
        'UTC': { lat: 40.0, lng: 0, city: 'UTC' }
    };

    const state = { sky: true, mode: 'auto', zone: 'America/Chicago', sun: null, theme: 'light', built: false, timer: 0, reduced: false };

    function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function put(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }

    // ---------------------------------------------------------------- the sun

    function place() {
        const z = ZONES[state.zone];
        if (z) return z;
        return { lat: 40, lng: -new Date().getTimezoneOffset() / 4, city: 'your computer' };   // "This computer": longitude from its clock
    }

    // Solar position (NOAA / Astronomical Almanac approximation, good to a fraction of a degree).
    // elev = degrees above the horizon, rising = before solar noon, x = 0..1 across the day arc, maxElev = noon height.
    function sunPos(ms, lat, lng) {
        const n = ms / 86400000 + 2440587.5 - 2451545.0;                 // days since J2000
        const norm = (a) => ((a % 360) + 360) % 360;
        const g = norm(357.529 + 0.98560028 * n) * RAD;
        const lam = norm(280.459 + 0.98564736 * n + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
        const eps = (23.439 - 0.00000036 * n) * RAD;
        const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
        const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
        let H = norm(280.46061837 + 360.98564736629 * n + lng - ra * DEG);   // hour angle, degrees
        if (H > 180) H -= 360;
        const phi = lat * RAD;
        const elev = Math.asin(clamp(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H * RAD), -1, 1)) * DEG;
        const c0 = (Math.sin(-0.833 * RAD) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
        const H0 = c0 >= 1 ? 0 : c0 <= -1 ? 180 : Math.acos(c0) * DEG;    // half the day length as an hour angle
        return { elev, H, H0, rising: H < 0, maxElev: 90 - Math.abs(lat - dec * DEG), dec: dec * DEG };
    }

    function phaseOf(s) {
        if (s.elev < -12) return 'night';
        if (s.rising) return s.elev < 3 ? 'sunrise' : 'morning';
        return s.elev >= 12 ? 'afternoon' : 'evening';
    }

    const PHASE_LABEL = { sunrise: 'Sunrise', morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', night: 'Night' };

    // Moon phase 0..1 (0 = new, 0.5 = full) from the mean synodic month.
    function moonPhase(ms) {
        const days = ms / 86400000 + 2440587.5 - 2451550.1;
        return (((days / 29.530588853) % 1) + 1) % 1;
    }

    // ---------------------------------------------------------------- colours

    // [sun elevation, top, middle, horizon] going up; different tables for the morning and the evening
    const RISE = [
        [-18, '#050a1e', '#0a1330', '#101c40'], [-12, '#0f1b45', '#2b3472', '#6b5a8e'], [-6, '#2c3f82', '#8f6aa0', '#f2a07f'],
        [0, '#4d78c4', '#f0b08a', '#ffd89a'], [6, '#5f9be6', '#a9cdee', '#ffe6b8'], [20, '#5aa6ee', '#9dd0f6', '#d9eefc'],
        [45, '#3f95e8', '#86c6f3', '#cfe9fa'], [90, '#3f95e8', '#86c6f3', '#cfe9fa']
    ];
    const SET = [
        [-18, '#050a1e', '#0a1330', '#101c40'], [-12, '#0f1840', '#26285c', '#4d3e75'], [-6, '#232f6e', '#6a4a8f', '#c9627e'],
        [-2, '#3a4a96', '#b8628f', '#f77b50'], [3, '#4f6fc0', '#ee9f7a', '#ffbd6b'], [10, '#5b92dc', '#b9c9e8', '#ffe0a8'],
        [20, '#5aa6ee', '#9dd0f6', '#d9eefc'], [45, '#3f95e8', '#86c6f3', '#cfe9fa'], [90, '#3f95e8', '#86c6f3', '#cfe9fa']
    ];

    function rgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
    function hex(c) { return '#' + c.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join(''); }
    function mix(a, b, t) { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); }

    function skyColors(elev, rising) {
        const T = rising ? RISE : SET;
        let i = 0;
        while (i < T.length - 2 && elev > T[i + 1][0]) i++;
        const a = T[i], b = T[i + 1], t = clamp((elev - a[0]) / (b[0] - a[0]), 0, 1);
        return [1, 2, 3].map((k) => mix(a[k], b[k], t));
    }

    // ---------------------------------------------------------------- state: sky on/off, Bright/Dark

    function readPrefs() {
        const sky = get(K_SKY);
        state.sky = sky === null ? true : sky === '1';
        let mode = get(K_MODE);
        if (mode !== 'auto' && mode !== 'light' && mode !== 'dark') {
            const old = get(K_THEME);                                  // a choice made before this version: keep it
            mode = old === 'dark' || old === 'light' ? old : 'auto';
        }
        state.mode = mode;
        const s = get(K_STATION);
        if (s !== null && (s === '' || ZONES[s])) state.zone = s;
    }

    function themeNow(elev) {
        if (state.mode === 'light' || state.mode === 'dark') return state.mode;
        if (!state.sky) return get(K_THEME) === 'dark' ? 'dark' : 'light';
        const cur = root.getAttribute('data-theme');
        return elev < (cur === 'dark' ? -3 : -5) ? 'dark' : 'light';   // a small gap so it does not flip back and forth at dusk and dawn
    }

    function hexGap(a, b) {                                            // largest difference in any colour channel (0..255)
        let g = 0;
        for (let i = 1; i < 7; i += 2) g = Math.max(g, Math.abs(parseInt(a.substr(i, 2), 16) - parseInt(b.substr(i, 2), 16)));
        return g;
    }

    function applyColors(sun, theme) {
        const night = clamp(-sun.elev / 18, 0, 1);
        const base = skyColors(sun.elev, sun.rising);
        const out = base.map((c) => theme === 'dark' ? mix(c, '#0a1017', 0.66) : mix(c, '#ffffff', 0.3 + 0.18 * night));
        const last = state.cols;
        if (last && last.theme === theme && out.every((c, i) => hexGap(c, last.out[i]) < 3)) return;
        state.cols = { theme, out };
        root.style.setProperty('--sky0', out[0]);
        root.style.setProperty('--sky1', out[1]);
        root.style.setProperty('--sky2', out[2]);
    }

    // Everything that depends on the time: attributes, colours, sun, moon, stars, clouds, the Sky button.
    function refresh(now) {
        const ms = now == null ? Date.now() : now, p = place();
        const sun = sunPos(ms, p.lat, p.lng), ph = phaseOf(sun);
        state.sun = Object.assign({ phase: ph, ms, city: p.city }, sun);
        const theme = themeNow(sun.elev);
        state.theme = theme;
        if (root.getAttribute('data-theme') !== theme) root.setAttribute('data-theme', theme);
        root.classList.toggle('sky-on', state.sky);
        root.setAttribute('data-phase', state.sky ? ph : 'off');
        root.setAttribute('data-mode', state.mode);
        if (state.sky) { applyColors(sun, theme); paintBodies(sun, ms, theme); }
        paintButtons(sun, ph, theme);
    }

    // ---------------------------------------------------------------- the sky layer

    const MOON_R = 20;
    function moonSvg(p) {
        const r = MOON_R, c = r + 2, cos = Math.cos(2 * Math.PI * p);
        const lit = `M${c} ${c - r}A${r} ${r} 0 0 1 ${c} ${c + r}A${(Math.abs(cos) * r).toFixed(2)} ${r} 0 0 ${cos > 0 ? 0 : 1} ${c} ${c - r}Z`;
        const flip = p > 0.5 ? `transform="translate(${2 * c} 0) scale(-1 1)"` : '';
        return `<svg viewBox="0 0 ${2 * c} ${2 * c}" width="100%" height="100%"><circle cx="${c}" cy="${c}" r="${r}" class="mn-dark"/><path d="${lit}" class="mn-lit" ${flip}/></svg>`;
    }

    function build() {
        if (state.built || !document.body) return;
        state.built = true;
        const el = document.createElement('div');
        el.id = 'sky';
        el.setAttribute('aria-hidden', 'true');
        let stars = '';
        let seed = 7;
        const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
        for (let i = 0; i < 64; i++) {
            const sz = (0.9 + rnd() * 1.9).toFixed(1);
            const tw = i % 3 === 0;                                   // only a third twinkle: fewer animations to run
            stars += `<i${tw ? ' class="tw"' : ''} style="left:${(rnd() * 100).toFixed(1)}%;top:${(rnd() * 78).toFixed(1)}%;width:${sz}px;height:${sz}px;` +
                (tw ? `animation-delay:${(rnd() * 6).toFixed(1)}s;animation-duration:${(3 + rnd() * 4).toFixed(1)}s` : 'opacity:.7') + '"></i>';
        }
        el.innerHTML = `<div class="sk-stars">${stars}</div><div class="sk-clouds"><i class="c1"></i><i class="c2"></i><i class="c3"></i></div>` +
            '<div class="sk-sun"></div><div class="sk-moon"></div>';
        document.body.insertBefore(el, document.body.firstChild);
    }

    function paintBodies(sun, ms, theme) {
        build();
        const el = document.getElementById('sky');
        if (!el) return;
        const night = clamp((-sun.elev - 2) / 10, 0, 1);                       // 0 by day .. 1 in the dark
        const dim = theme === 'dark' ? 0.55 : 1;
        // sun: along the day arc between sunrise (left) and sunset (right)
        const sx = 50 + 44 * clamp(sun.H / Math.max(30, sun.H0), -1, 1);
        const sy = 42 - (Math.max(sun.elev, -8) / Math.max(12, sun.maxElev)) * 32;        // the arc stays in the upper part of the screen
        const sunEl = el.querySelector('.sk-sun');
        const low = clamp(1 - sun.elev / 25, 0, 1);                              // low sun is orange
        sunEl.style.transform = `translate(${sx.toFixed(2)}vw, ${sy.toFixed(2)}vh)`;
        sunEl.style.opacity = (clamp((sun.elev + 6) / 8, 0, 1) * dim).toFixed(3);
        sunEl.style.setProperty('--core', mix('#fff8dc', '#ffe0a8', low));
        sunEl.style.setProperty('--glow', mix('#ffd55e', '#ff8f45', low));
        // moon: crosses the sky between sunset and sunrise
        const Hn = sun.H < 0 ? sun.H + 360 : sun.H;
        const f = clamp((Hn - sun.H0) / Math.max(1, 360 - 2 * sun.H0), 0, 1);
        const mx = 8 + 84 * f, my = 40 - 30 * Math.sin(Math.PI * f);
        const moonEl = el.querySelector('.sk-moon');
        moonEl.style.transform = `translate(${mx.toFixed(2)}vw, ${my.toFixed(2)}vh)`;
        moonEl.style.opacity = (night * (theme === 'dark' ? 0.9 : 0.8)).toFixed(3);
        const mp = Math.round(moonPhase(ms) * 60);                               // redraw only when the phase moves a little
        if (moonEl.dataset.p !== String(mp)) { moonEl.dataset.p = String(mp); moonEl.innerHTML = moonSvg(mp / 60); }
        const starsEl = el.querySelector('.sk-stars'), cloudsEl = el.querySelector('.sk-clouds');
        const cloudOp = clamp(sun.elev / 8 + 0.5, 0, 1) * (theme === 'dark' ? 0.18 : 0.55);
        starsEl.style.opacity = (night * 0.95).toFixed(3);
        cloudsEl.style.opacity = cloudOp.toFixed(3);
        starsEl.classList.toggle('rest', night < 0.01);                          // nothing animates while it cannot be seen
        cloudsEl.classList.toggle('rest', cloudOp < 0.01);
        el.style.setProperty('--cloud', mix('#ffffff', '#ffc9a6', low * 0.8));
    }

    // ---------------------------------------------------------------- the two buttons

    const SVG = (inner) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
    const ICON = {
        sunrise: SVG('<path d="M17 18a5 5 0 0 0-10 0M12 3v6M8.5 6.5 12 3l3.5 3.5M2 21h20M4.2 12.2l1.4 1.4M19.8 12.2l-1.4 1.4"/>'),
        sunset: SVG('<path d="M17 18a5 5 0 0 0-10 0M12 9V3M8.5 5.5 12 9l3.5-3.5M2 21h20M4.2 12.2l1.4 1.4M19.8 12.2l-1.4 1.4"/>'),
        day: SVG('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
        night: SVG('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/><path d="M18 3v3M16.5 4.5h3"/>'),
        off: SVG('<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>')
    };
    const SUN_ICON = ICON.day;
    const MOON_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

    function paintButtons(sun, ph, theme) {
        const sb = document.getElementById('sky-btn'), tb = document.getElementById('theme-btn');
        if (sb) {
            const ico = !state.sky ? ICON.off : ph === 'night' ? ICON.night : ph === 'sunrise' ? ICON.sunrise : ph === 'evening' ? ICON.sunset : ICON.day;
            const html = `<span class="sky-ico">${ico}</span><span class="sky-lbl">${state.sky ? PHASE_LABEL[ph] : 'Sky off'}</span><span class="sky-sw" aria-hidden="true"></span>`;
            if (sb._html !== html) { sb._html = html; sb.innerHTML = html; }
            sb.setAttribute('aria-pressed', state.sky ? 'true' : 'false');
            sb.classList.toggle('on', state.sky);
            sb.title = state.sky
                ? `Time-of-day sky is on. It follows the sun at ${state.sun.city} (${PHASE_LABEL[ph].toLowerCase()} now). Click to turn it off (S)`
                : 'Time-of-day sky is off. Click to turn it on (S)';
        }
        if (tb) {
            const html = theme === 'dark' ? SUN_ICON : MOON_ICON;
            if (tb._html !== html) { tb._html = html; tb.innerHTML = html; }
            tb.classList.toggle('auto', state.mode === 'auto' && state.sky);
            tb.setAttribute('aria-label', theme === 'dark' ? 'Switch to bright mode' : 'Switch to dark mode');
            tb.title = (theme === 'dark' ? 'Dark mode: click for Bright' : 'Bright mode: click for Dark') + (state.mode === 'auto' && state.sky ? ' (automatic, follows the sun)' : ' (D)');
        }
    }

    function say(msg) { if (typeof window.toast === 'function') window.toast(msg); }

    function toggleSky() {
        if (state.sky) {                                  // off: keep the colours you see now
            state.sky = false;
            if (state.mode === 'auto') state.mode = state.theme;
            say('Sky off. Plain dashboard');
        } else {
            state.sky = true; state.mode = 'auto';
            say('Sky on. It follows the sun in ' + place().city + ', and Bright / Dark follow it too');
        }
        put(K_SKY, state.sky ? '1' : '0'); put(K_MODE, state.mode);
        refresh();
    }

    function toggleTheme() {
        const next = state.theme === 'dark' ? 'light' : 'dark';
        state.mode = next;
        put(K_MODE, next); put(K_THEME, next);            // the login page reads rc-theme
        refresh();
        if (state.sky) say((next === 'dark' ? 'Dark' : 'Bright') + ' mode. Turn Sky off and on to go back to automatic');
    }

    // ---------------------------------------------------------------- public

    function boot() {
        readPrefs();
        refresh();
    }

    function init() {
        const sb = document.getElementById('sky-btn'), tb = document.getElementById('theme-btn');
        if (sb) sb.addEventListener('click', toggleSky);
        if (tb) tb.addEventListener('click', toggleTheme);
        state.reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        refresh();
        if (state.timer) clearInterval(state.timer);
        state.timer = setInterval(() => { if (!document.hidden) refresh(); }, 60000);        // the sun moves slowly; nothing to do in a hidden tab
        document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    }

    // the login page has its own Bright/Dark button: take over whatever it just set
    function adopt() {
        state.mode = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        put(K_MODE, state.mode);
        refresh();
    }

    function setZone(tz) {
        state.zone = tz == null ? '' : tz;
        refresh();
    }

    window.RCSky = { boot, init, setZone, refresh, toggleSky, toggleTheme, adopt, _state: () => state, _sun: sunPos, _phase: phaseOf, _moon: moonPhase };
    boot();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

/* RideCentric LIVE - shared visual effects:
   - RC.takeoff(): the animated "take-off" scene shown on the login page after a successful login
   - RC.introReveal(): lifts the cover on the dashboard and lets its content fly in
   - RC.countUp(): number count-up
   Everything is skipped when the visitor's system asks for reduced motion. */
(function () {
    'use strict';
    var RC = window.RC = {};
    var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    RC.reduced = function () { return !!(mq && mq.matches); };

    var PLANE = 'M0,-12 L3,-4 L12,2 L12,5 L3,3 L2,9 L5,11 L5,13 L0,12 L-5,13 L-5,11 L-2,9 L-3,3 L-12,5 L-12,2 L-3,-4 Z';
    RC.PLANE = PLANE;
    RC.esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
    RC.niceName = function (n) { n = String(n || '').trim(); return n ? n.charAt(0).toUpperCase() + n.slice(1) : 'there'; };

    // the brand mark as four rectangles (same numbers as img/mark.svg) + the lettering next to it
    var MARK = '<svg class="tk-mark" viewBox="0 0 13.57 13.72" aria-hidden="true">' +
        '<rect class="m1" x="0" y="0" width="4.5" height="13.72"/><rect class="m2" x="0" y="0" width="13.57" height="4.6"/>' +
        '<rect class="m3" x="4.5" y="4.6" width="4.62" height="4.53" fill-opacity=".82"/><rect class="m4" x="9.12" y="9.13" width="4.45" height="4.59"/></svg>';
    RC.centerHTML = function (name) {
        return '<div class="tk-center"><div class="tk-logo">' + MARK +
            '<img class="tk-word logo-light" src="/app/img/wordmark.png" alt="RideCentric"><img class="tk-word logo-dark" src="/app/img/wordmark-dark.png" alt=""></div>' +
            '<div class="tk-hello">Welcome back, <b>' + RC.esc(RC.niceName(name)) + '</b></div>' +
            '<div class="tk-bar"><i></i></div><div class="tk-sub">LOADING TODAY’S ARRIVALS</div></div>';
    };

    // ---- theme button for pages that do not have their own script (login page) ----
    var SUN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
    var MOON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
    RC.initThemeButton = function (btn) {
        function paint() { btn.innerHTML = document.documentElement.getAttribute('data-theme') === 'dark' ? SUN : MOON; }
        paint();
        btn.addEventListener('click', function () {
            var t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', t);
            try { localStorage.setItem('rc-theme', t); } catch (e) { }
            paint();
        });
    };

    // ---- login success: logo assembles, a plane draws its route across the screen, then we hand over to the dashboard ----
    RC.takeoff = function (name, done) {
        var el = document.getElementById('takeoff');
        if (!el || RC.reduced()) { setTimeout(done, RC.reduced() ? 200 : 0); return; }
        var W = window.innerWidth, H = window.innerHeight;
        var D = 'M' + (-.06 * W) + ' ' + (.86 * H) + ' C ' + (.28 * W) + ' ' + (.5 * H) + ', ' + (.66 * W) + ' ' + (1.08 * H) + ', ' + (1.07 * W) + ' ' + (.12 * H);
        el.innerHTML = '<svg class="tk-svg" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true"><path class="tk-rest" d="' + D + '"/>' +
            '<path class="tk-done" d="' + D + '"/><g class="tkp"><path class="tk-plane" d="' + PLANE + '"/></g></svg>' + RC.centerHTML(name);
        el.classList.add('on');
        var rest = el.querySelector('.tk-rest'), part = el.querySelector('.tk-done'), plane = el.querySelector('.tkp');
        var L = rest.getTotalLength(), T0 = performance.now() + 250, DUR = 1500;
        part.style.strokeDasharray = L; part.style.strokeDashoffset = L;
        function ease(t) { return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
        function frame(now) {
            var t = Math.min(1, Math.max(0, (now - T0) / DUR)), p = ease(t);
            var a = rest.getPointAtLength(L * p), b = rest.getPointAtLength(Math.min(L, L * p + 2));
            var ang = Math.atan2(b.x - a.x, -(b.y - a.y)) * 180 / Math.PI;
            plane.setAttribute('transform', 'translate(' + a.x.toFixed(1) + ' ' + a.y.toFixed(1) + ') rotate(' + ang.toFixed(1) + ') scale(1.7)');
            part.style.strokeDashoffset = L * (1 - p);
            if (t < 1) requestAnimationFrame(frame);
            else { el.classList.add('arrived'); setTimeout(done, 420); }
        }
        requestAnimationFrame(frame);
    };

    // ---- count-up ----
    RC.countUp = function (el, to, ms) {
        to = Number(to) || 0; ms = ms || 800;
        if (RC.reduced() || to === 0) { el.textContent = to; return; }
        var t0 = performance.now();
        (function step(now) {
            var t = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - t, 3);
            el.textContent = Math.round(to * e);
            if (t < 1) requestAnimationFrame(step);
        })(t0);
    };

    // ---- dashboard intro (only right after a login) ----
    RC.introActive = function () { var c = document.documentElement.classList; return c.contains('intro-pending') || c.contains('intro-play'); };
    RC.introReveal = function () {
        var h = document.documentElement;
        if (!h.classList.contains('intro-pending')) return;
        var ov = document.getElementById('intro');
        h.classList.remove('intro-pending'); h.classList.add('intro-play');
        if (ov) { ov.classList.add('out'); setTimeout(function () { if (ov.parentNode) ov.parentNode.removeChild(ov); }, 800); }
        Array.prototype.forEach.call(document.querySelectorAll('[data-to]'), function (n) { RC.countUp(n, n.getAttribute('data-to')); });
        setTimeout(function () { h.classList.remove('intro-play'); }, 3200);
    };

    var intro = document.getElementById('intro');
    if (intro && !document.documentElement.classList.contains('intro-pending')) { intro.parentNode.removeChild(intro); intro = null; }  // normal page load: no cover
    if (intro) {
        intro.innerHTML = RC.centerHTML((function () { try { return localStorage.getItem('ridecentric_user'); } catch (e) { return ''; } })());
        setTimeout(RC.introReveal, 4000); // safety net: never leave the cover up
    }
})();

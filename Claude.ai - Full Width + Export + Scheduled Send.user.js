// ==UserScript==
// @name         Claude.ai - Full Width + Export + Scheduled Send
// @namespace    https://github.com/yourname
// @version      3.0.0
// @description  Full-width toggle (gear icon) + markdown exporter (icon, % progress, integrity checks, log panel) + scheduled message sender (stopwatch icon, best-effort cooldown detection with manual override, live countdown, independently draggable position). All icon clusters remember position separately.
// @match        https://claude.ai/chat*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    /* ================= MODULE -1: UPLOAD NETWORK INTERCEPT (must run first) ================= */
    // @run-at document-start means this executes before Claude's own JS runs,
    // which is the only way to see its calls to XMLHttpRequest/fetch — patching
    // any later would just miss them since Claude's bundle would already hold
    // references to the originals.
    //
    // Correlates an in-flight upload to a DOM card by filename (the card shows
    // the filename, e.g. title="Logfile3.CSV", and a normal upload's request
    // body contains a File with that same name). Real byte-level progress only
    // exists for XHR (xhr.upload.onprogress) — most browsers don't expose
    // upload progress for fetch(), so fetch-based uploads are marked
    // "indeterminate" and Module 4 shows elapsed time instead of a percentage
    // for those. If Claude's actual upload mechanism doesn't match either
    // pattern (e.g. a presigned direct-to-storage PUT with a raw Blob and no
    // filename), correlation just won't find anything and the overlay falls
    // back to a plain "Uploading…" with no number — never breaks, just less precise.
    (function uploadInterceptModule() {
        try {
            const ULOG = '[Claude Upload]';
            function ulog(msg) { console.log(`%c${ULOG} ${msg}`, 'color:#a78bfa'); }

            const uploads = new Map(); // filename -> { loaded, total, startedAt, done, failed, indeterminate }
            window.__claudeUploads = uploads; // exposed for manual inspection in the console

            function extractFile(body) {
                if (!body) return null;
                if (typeof File !== 'undefined' && body instanceof File) return body;
                if (typeof FormData !== 'undefined' && body instanceof FormData) {
                    for (const val of body.values()) {
                        if (typeof File !== 'undefined' && val instanceof File) return val;
                    }
                }
                return null;
            }

            const OrigXHR = window.XMLHttpRequest;
            function PatchedXHR() {
                const xhr = new OrigXHR();
                const origSend = xhr.send.bind(xhr);
                xhr.send = function (body) {
                    const file = extractFile(body);
                    if (file && xhr.upload) {
                        uploads.set(file.name, { loaded: 0, total: file.size || 0, startedAt: Date.now() });
                        ulog(`XHR upload started: "${file.name}" (${file.size} bytes)`);
                        xhr.upload.addEventListener('progress', e => {
                            if (e.lengthComputable) {
                                const prev = uploads.get(file.name);
                                uploads.set(file.name, { loaded: e.loaded, total: e.total, startedAt: prev ? prev.startedAt : Date.now() });
                            }
                        });
                        xhr.upload.addEventListener('loadend', () => {
                            const entry = uploads.get(file.name);
                            if (entry) { entry.done = true; ulog(`XHR upload finished: "${file.name}"`); }
                        });
                    }
                    return origSend(body);
                };
                return xhr;
            }
            PatchedXHR.prototype = OrigXHR.prototype;
            Object.setPrototypeOf(PatchedXHR, OrigXHR);
            window.XMLHttpRequest = PatchedXHR;

            const origFetch = window.fetch.bind(window);
            window.fetch = function (input, init) {
                const file = extractFile(init && init.body);
                if (file) {
                    uploads.set(file.name, { loaded: 0, total: file.size || 0, startedAt: Date.now(), indeterminate: true });
                    ulog(`fetch upload started (no byte-level progress available via fetch): "${file.name}"`);
                }
                const p = origFetch(input, init);
                if (file) {
                    p.then(() => { const e = uploads.get(file.name); if (e) { e.done = true; ulog(`fetch upload finished: "${file.name}"`); } })
                     .catch(() => { const e = uploads.get(file.name); if (e) { e.done = true; e.failed = true; ulog(`fetch upload failed: "${file.name}"`); } });
                }
                return p;
            };

            ulog('Network intercept installed (XHR + fetch) — tracking file uploads for the progress overlay.');
        } catch (e) {
            console.warn('[Claude Upload] Failed to install network intercept — upload overlay will fall back to elapsed-time only:', e);
        }
    })();

    /* ================= MODULE 0: SHARED ANCHOR / DRAG HANDLE (gear + export dot) ================= */
    // Owns the single draggable "anchor" point {top, right} that Module 1 (gear)
    // and Module 2 (export cluster) offset themselves from. Persists via
    // GM_setValue (survives site-data clears / Firefox restarts), falls back to
    // localStorage if GM is unavailable for any reason.
    const ClaudeUIAnchor = (function () {
        const STORAGE_KEY = 'claude_ui_anchor';
        const DEFAULT_ANCHOR = { top: 14, right: 230 };
        const HANDLE_OFFSET = { top: 5, right: +20 }; // left of the gear icon
        let anchor = { ...DEFAULT_ANCHOR };
        let handle;

        function hasGM() {
            return typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
        }

        function load() {
            let raw = null;
            try {
                raw = hasGM() ? GM_getValue(STORAGE_KEY, null) : localStorage.getItem(STORAGE_KEY);
            } catch (e) {}
            if (raw) {
                try {
                    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                    if (typeof parsed.top === 'number' && typeof parsed.right === 'number') {
                        anchor = parsed;
                    }
                } catch (e) {}
            }
        }

        function persist() {
            try {
                const json = JSON.stringify(anchor);
                if (hasGM()) GM_setValue(STORAGE_KEY, json);
                else localStorage.setItem(STORAGE_KEY, json);
            } catch (e) {}
        }

        function clamp(a) {
            const w = window.innerWidth, h = window.innerHeight;
            return {
                top: Math.min(Math.max(a.top, 0), Math.max(0, h - 30)),
                right: Math.min(Math.max(a.right, 0), Math.max(0, w - 30))
            };
        }

        function apply(persistNow) {
            anchor = clamp(anchor);
            if (handle) {
    handle.style.top = (anchor.top + HANDLE_OFFSET.top) + 'px';
    handle.style.right = (anchor.right + HANDLE_OFFSET.right) + 'px';
}
            window.dispatchEvent(new CustomEvent('claude-ui-anchor-change', { detail: { ...anchor } }));
            if (persistNow) persist();
        }

        function getAnchor() { return { ...anchor }; }

        function createHandle() {
           const MOVE_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" width="100%" height="100%">
    <polygon points="12,3 8,9 16,9"></polygon>
    <polygon points="12,21 8,15 16,15"></polygon>
    <polygon points="3,12 9,8 9,16"></polygon>
    <polygon points="21,12 15,8 15,16"></polygon>
</svg>`;

handle = document.createElement('div');
handle.id = 'claude-ui-drag-handle';
handle.title = 'Drag to move';
handle.style.cssText = `
    position: fixed; z-index: 1000001;
    width: 6px; height: 6px; padding: 6px; box-sizing: content-box;
    cursor: grab; display: flex; align-items: center; justify-content: center;
`;
const iconWrap = document.createElement('div');
iconWrap.style.cssText = 'width:100%; height:100%; color:#60a5fa; filter: drop-shadow(0 1px 1px rgba(0,0,0,0.7)); pointer-events:none;';
iconWrap.innerHTML = MOVE_ICON;
handle.appendChild(iconWrap);
document.body.appendChild(handle);

            let dragging = false, startX = 0, startY = 0, startAnchor = null;

            handle.addEventListener('mousedown', e => {
                dragging = true;
                startX = e.clientX;
                startY = e.clientY;
                startAnchor = { ...anchor };
                handle.style.cursor = 'grabbing';
                document.body.style.userSelect = 'none';
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
                e.preventDefault();
            });

            function onMove(e) {
                if (!dragging) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                anchor = { top: startAnchor.top + dy, right: startAnchor.right - dx };
                apply(false);
            }

            function onUp() {
                dragging = false;
                handle.style.cursor = 'grab';
                document.body.style.userSelect = '';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                apply(true);
            }
        }

        function init() {
            load();
            createHandle();
            apply(false);
            let resizeTimer = null;
            window.addEventListener('resize', () => {
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(() => apply(false), 150);
            });
        }

        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
        else init();

        return { getAnchor, onChange: cb => window.addEventListener('claude-ui-anchor-change', e => cb(e.detail)) };
    })();

    /* ================= MODULE 0B: SCHEDULE ANCHOR (independent, bottom-right, near composer) ================= */
    // Same pattern as Module 0 but a completely separate anchor/handle, anchored
    // from the bottom of the viewport (near the message box) instead of the top.
    // Its own storage key means it remembers its position independently of the
    // gear/export cluster.
    const ClaudeScheduleAnchor = (function () {
        const STORAGE_KEY = 'claude_schedule_anchor';
        const DEFAULT_ANCHOR = { bottom: 90, right: 40 };
        const HANDLE_OFFSET = { bottom: -18, right: 22 };
        let anchor = { ...DEFAULT_ANCHOR };
        let handle;

        function hasGM() {
            return typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
        }

        function load() {
            let raw = null;
            try {
                raw = hasGM() ? GM_getValue(STORAGE_KEY, null) : localStorage.getItem(STORAGE_KEY);
            } catch (e) {}
            if (raw) {
                try {
                    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                    if (typeof parsed.bottom === 'number' && typeof parsed.right === 'number') {
                        anchor = parsed;
                    }
                } catch (e) {}
            }
        }

        function persist() {
            try {
                const json = JSON.stringify(anchor);
                if (hasGM()) GM_setValue(STORAGE_KEY, json);
                else localStorage.setItem(STORAGE_KEY, json);
            } catch (e) {}
        }

        function clamp(a) {
            const w = window.innerWidth, h = window.innerHeight;
            return {
                bottom: Math.min(Math.max(a.bottom, 0), Math.max(0, h - 30)),
                right: Math.min(Math.max(a.right, 0), Math.max(0, w - 30))
            };
        }

        function apply(persistNow) {
            anchor = clamp(anchor);
            if (handle) {
                handle.style.bottom = (anchor.bottom + HANDLE_OFFSET.bottom) + 'px';
                handle.style.right = (anchor.right + HANDLE_OFFSET.right) + 'px';
            }
            window.dispatchEvent(new CustomEvent('claude-schedule-anchor-change', { detail: { ...anchor } }));
            if (persistNow) persist();
        }

        function getAnchor() { return { ...anchor }; }

        function createHandle() {
            const MOVE_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" width="100%" height="100%">
    <polygon points="12,3 8,9 16,9"></polygon>
    <polygon points="12,21 8,15 16,15"></polygon>
    <polygon points="3,12 9,8 9,16"></polygon>
    <polygon points="21,12 15,8 15,16"></polygon>
</svg>`;
            handle = document.createElement('div');
            handle.id = 'claude-schedule-drag-handle';
            handle.title = 'Drag to move';
            handle.style.cssText = `
                position: fixed; z-index: 1000001;
                width: 6px; height: 6px; padding: 6px; box-sizing: content-box;
                cursor: grab; display: flex; align-items: center; justify-content: center;
            `;
            const iconWrap = document.createElement('div');
            iconWrap.style.cssText = 'width:100%; height:100%; color:#f472b6; filter: drop-shadow(0 1px 1px rgba(0,0,0,0.7)); pointer-events:none;';
            iconWrap.innerHTML = MOVE_ICON;
            handle.appendChild(iconWrap);
            document.body.appendChild(handle);

            let dragging = false, startX = 0, startY = 0, startAnchor = null;

            handle.addEventListener('mousedown', e => {
                dragging = true;
                startX = e.clientX;
                startY = e.clientY;
                startAnchor = { ...anchor };
                handle.style.cursor = 'grabbing';
                document.body.style.userSelect = 'none';
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
                e.preventDefault();
            });

            function onMove(e) {
                if (!dragging) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                anchor = { bottom: startAnchor.bottom - dy, right: startAnchor.right - dx };
                apply(false);
            }

            function onUp() {
                dragging = false;
                handle.style.cursor = 'grab';
                document.body.style.userSelect = '';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                apply(true);
            }
        }

        function init() {
            load();
            createHandle();
            apply(false);
            let resizeTimer = null;
            window.addEventListener('resize', () => {
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(() => apply(false), 150);
            });
        }

        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
        else init();

        return { getAnchor, onChange: cb => window.addEventListener('claude-schedule-anchor-change', e => cb(e.detail)) };
    })();

    function makeDot({ id, color, title, onClick, size = 5, padding = 8, iconHtml = null }) {
        const dot = document.createElement('div');
        dot.id = id;
        if (title) dot.title = title;
        dot.style.cssText = `
            position: fixed; z-index: 999999;
            width: ${size}px; height: ${size}px; padding: ${padding}px; box-sizing: content-box;
            background-clip: content-box; background: ${color}; border-radius: 50%;
            cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.4);
            display: flex; align-items: center; justify-content: center;
            transition: opacity 0.2s ease;
        `;
        if (iconHtml) {
            const iconWrap = document.createElement('div');
            iconWrap.style.cssText = `width:60%; height:60%; color: rgba(0,0,0,0.32); pointer-events:none; display:flex; align-items:center; justify-content:center;`;
            iconWrap.innerHTML = iconHtml;
            dot.appendChild(iconWrap);
        }
        dot.addEventListener('click', onClick);
        document.body.appendChild(dot);
        return dot;
    }

    /* ================= MODULE 1: FULL WIDTH ================= */
    (function fullWidthModule() {
        let currentWidthPercent = 95, isEnabled = true, isRelativeToScreen = true;
        let panel, gearIcon, styleElement, timeoutId = null, lastSettingKey = '';
        const STORAGE_KEY = 'claude_fullwidth_settings';
        const GEAR_OFFSET = { top: 0, right: -36 }; // relative to shared anchor
        const BROAD_SELECTOR = 'div[class*="max-w-"]'; // deliberately broad — see logDiagnostics()

        function flog(msg) { console.log(`%c[Claude FullWidth] ${msg}`, 'color:#60a5fa'); }
        const COMPOSER_SELECTOR = 'div.ProseMirror[contenteditable="true"], div[contenteditable="true"][translate="no"], fieldset div[contenteditable="true"], div[contenteditable="true"]';
        // The composer's wrapper very likely also carries a Tailwind max-w-* class,
        // meaning the broad rule above can squash it too — box stays, its text
        // layer's sizing breaks, looks like an empty gray card. Just as importantly,
        // things like the "pasted long text" / file-attachment preview card are
        // SIBLINGS of the editable div within the same composer wrapper, not its
        // ancestors — so exempting only the ancestor chain misses them entirely.
        // This instead climbs to a bounded "whole composer area" container and
        // exempts every element in that subtree, not just one line going up.
        function markComposerExempt() {
            const composer = document.querySelector(COMPOSER_SELECTOR);
            if (!composer) return;
            let wrapper = composer;
            for (let i = 0; i < 6 && wrapper.parentElement; i++) {
                wrapper = wrapper.parentElement;
                if (wrapper.tagName === 'FORM') break; // a <form>, if present, is a strong "whole composer area" boundary
            }
            let marked = 0;
            const mark = el => { if (el && !el.hasAttribute('data-claude-fw-exempt')) { el.setAttribute('data-claude-fw-exempt', '1'); marked++; } };
            mark(wrapper);
            wrapper.querySelectorAll('*').forEach(mark);
            let el = wrapper.parentElement;
            for (let i = 0; i < 6 && el; i++) { mark(el); el = el.parentElement; }
            if (marked > 0) flog(`Exempted the whole composer area (${marked} new element(s): wrapper subtree + its ancestors) from the full-width override.`);
        }

        // This module works by matching Tailwind's max-w-* classes generically,
        // since the exact class names Claude ships aren't known and can change.
        // That's also exactly the kind of selector that can accidentally catch a
        // tool-use/artifact/attachment card elsewhere on the page and squash its
        // layout (e.g. into an empty-looking gray box) as a side effect. This logs
        // what actually matched so that's visible instead of silent, and prints a
        // ready-to-paste console snippet to inspect the suspicious ones directly.
        function logDiagnostics() {
            const matches = document.querySelectorAll(BROAD_SELECTOR);
            const chatRoot = document.querySelector('[data-testid="chat-container"], main');
            let outside = 0;
            matches.forEach(el => { if (chatRoot && !chatRoot.contains(el)) outside++; });
            flog(`"${BROAD_SELECTOR}" currently matches ${matches.length} element(s) on the page` +
                (chatRoot ? `, ${outside} of them OUTSIDE the main chat container (candidates for unintended squashing)` : ' — could not find a main chat container to compare against, so this count is unfiltered'));
            if (outside > 0) {
                console.log(`%c[Claude FullWidth] Inspect them with:`, 'color:#60a5fa');
                console.log(`[...document.querySelectorAll('${BROAD_SELECTOR}')].filter(el => !document.querySelector('[data-testid="chat-container"], main')?.contains(el))`);
            }
            const composer = document.querySelector(COMPOSER_SELECTOR);
            if (composer) {
                const rect = composer.getBoundingClientRect();
                flog(`Composer: ${Math.round(rect.width)}×${Math.round(rect.height)}px rendered, exempt=${composer.closest('[data-claude-fw-exempt]') ? 'yes' : 'NO'}`);
            } else {
                flog('Composer element not found on the page right now.');
            }
            return { total: matches.length, outside };
        }

        function loadSettings() {
            try {
                const saved = localStorage.getItem(STORAGE_KEY);
                if (saved) {
                    const d = JSON.parse(saved);
                    currentWidthPercent = d.width ?? 95;
                    isEnabled = d.enabled ?? true;
                    isRelativeToScreen = d.relative ?? true;
                }
            } catch (e) {}
        }
        function saveSettings() {
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify({
                    width: currentWidthPercent, enabled: isEnabled, relative: isRelativeToScreen
                }));
            } catch (e) {}
        }
        function debounce(fn, wait = 100) {
            return (...a) => { clearTimeout(timeoutId); timeoutId = setTimeout(() => fn(...a), wait); };
        }

        function repositionGear(anchor) {
            if (!gearIcon) return;
            gearIcon.style.top = (anchor.top + GEAR_OFFSET.top) + 'px';
            gearIcon.style.right = (anchor.right + GEAR_OFFSET.right) + 'px';
        }

        function createControls() {
            panel = document.createElement('div');
            panel.id = 'claude-fullwidth-panel';
            panel.style.cssText = `
                position: fixed; top: 12px; right: 20px; z-index: 999999;
                background: #1f2937; color: #e5e7eb; padding: 8px 12px;
                border-radius: 8px; font-family: system-ui, sans-serif; font-size: 12.5px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.5); display: none;
                align-items: center; gap: 10px; border: 1px solid #4b5563; user-select: none;
            `;
            panel.innerHTML = `
                <label style="display:flex;align-items:center;gap:5px;cursor:pointer;">
                    <input type="checkbox" id="claude-fw-enable" ${isEnabled ? 'checked' : ''}>
                    <span>Full Width</span>
                </label>
                <div style="display:flex;align-items:center;gap:6px;">
                    <span style="font-size:11px;opacity:0.8;">W:</span>
                    <input type="range" id="claude-fw-slider" min="60" max="100" value="${currentWidthPercent}" style="width:130px;">
                    <span id="claude-fw-value" style="font-family:monospace;min-width:38px;">${currentWidthPercent}%</span>
                </div>
                <label style="display:flex;align-items:center;gap:5px;cursor:pointer;">
                    <input type="checkbox" id="claude-fw-relative" ${isRelativeToScreen ? 'checked' : ''}>
                    <span style="font-size:11px;">Screen</span>
                </label>
                <button id="claude-fw-reset" style="background:#374151;border:none;color:white;padding:3px 8px;border-radius:4px;font-size:11px;cursor:pointer;">Reset</button>
                <button id="claude-fw-diagnose" title="Log which elements the full-width CSS is touching" style="background:#374151;border:none;color:white;padding:3px 8px;border-radius:4px;font-size:11px;cursor:pointer;">Diagnose</button>
                <button id="claude-fw-minimize" style="background:none;border:none;color:#94a3b8;font-size:18px;line-height:1;cursor:pointer;padding:0 4px;">✕</button>
            `;

            gearIcon = document.createElement('div');
            gearIcon.id = 'claude-fw-gear';
            gearIcon.style.cssText = `
                position: fixed; z-index: 999999;
                width: 26px; height: 26px; background: #1f2937; border: 2px solid #60a5fa;
                color: #60a5fa; border-radius: 50%; display: flex; align-items: center;
                justify-content: center; cursor: pointer; box-shadow: 0 3px 12px rgba(0,0,0,0.4);
                font-size: 13px; transition: all 0.2s ease;
            `;
            gearIcon.innerHTML = '⚙️';
            gearIcon.title = 'Claude Full Width Controls';

            document.body.appendChild(panel);
            document.body.appendChild(gearIcon);
            repositionGear(ClaudeUIAnchor.getAnchor());
            ClaudeUIAnchor.onChange(repositionGear);

            panel.querySelector('#claude-fw-enable').addEventListener('change', e => {
                isEnabled = e.target.checked; saveSettings(); applyWidth();
            });
            panel.querySelector('#claude-fw-slider').addEventListener('input', e => {
                currentWidthPercent = parseInt(e.target.value);
                panel.querySelector('#claude-fw-value').textContent = currentWidthPercent + '%';
                applyWidth();
            });
            panel.querySelector('#claude-fw-relative').addEventListener('change', e => {
                isRelativeToScreen = e.target.checked; saveSettings(); applyWidth();
            });
            panel.querySelector('#claude-fw-reset').addEventListener('click', () => {
                currentWidthPercent = 95;
                panel.querySelector('#claude-fw-slider').value = 95;
                panel.querySelector('#claude-fw-value').textContent = '95%';
                applyWidth(); saveSettings();
            });
            panel.querySelector('#claude-fw-diagnose').addEventListener('click', logDiagnostics);
            panel.querySelector('#claude-fw-minimize').addEventListener('click', hidePanel);
            panel.addEventListener('dblclick', hidePanel);
            gearIcon.addEventListener('click', showPanel);
        }

        function showPanel() {
            panel.style.display = 'flex';
            gearIcon.style.display = 'none';
            window.dispatchEvent(new CustomEvent('claude-fw-panel-toggle', { detail: { open: true } }));
        }
        function hidePanel() {
            panel.style.display = 'none';
            gearIcon.style.display = 'flex';
            window.dispatchEvent(new CustomEvent('claude-fw-panel-toggle', { detail: { open: false } }));
        }

        function applyWidth() {
            // Runs on every call (including ones that no-op below because
            // settings didn't change) since this is also what's re-triggered by
            // the MutationObserver whenever React re-renders — which is exactly
            // when the composer's DOM node can get recreated and lose its mark.
            markComposerExempt();
            const key = `${isEnabled}-${currentWidthPercent}-${isRelativeToScreen}`;
            if (key === lastSettingKey) return;
            lastSettingKey = key;
            if (!isEnabled) {
                if (styleElement) styleElement.textContent = '';
                flog('Disabled — stylesheet cleared.');
                return;
            }
            const maxWidth = isRelativeToScreen ? `${currentWidthPercent}vw` : `${currentWidthPercent}%`;
            if (!styleElement) {
                styleElement = document.createElement('style');
                styleElement.id = 'claude-fullwidth-style';
                document.head.appendChild(styleElement);
            }
            styleElement.textContent = `
                [data-testid="chat-container"] > div:not([data-claude-fw-exempt]), main > div > div:not([data-claude-fw-exempt]),
                div[class*="max-w-"]:not([data-claude-fw-exempt]), .max-w-3xl:not([data-claude-fw-exempt]), .max-w-4xl:not([data-claude-fw-exempt]), .max-w-5xl:not([data-claude-fw-exempt]), .max-w-6xl:not([data-claude-fw-exempt]), .max-w-7xl:not([data-claude-fw-exempt]) {
                    max-width: ${maxWidth} !important; margin-left: auto !important; margin-right: auto !important;
                }
                div[data-is-streaming="false"] > div:not([data-claude-fw-exempt]), article:not([data-claude-fw-exempt]), [class*="font-claude-response"]:not([data-claude-fw-exempt]) {
                    max-width: none !important; width: 100% !important;
                }
            `;
            flog(`Applied max-width: ${maxWidth}`);
            logDiagnostics();
        }

        function init() {
            if (gearIcon) return;
            flog(`Starting (enabled=${isEnabled} width=${currentWidthPercent}${isRelativeToScreen ? 'vw' : '%'})`);
            loadSettings();
            createControls();
            applyWidth();
            const debouncedApply = debounce(applyWidth, 120);
            new MutationObserver(muts => {
                if (!isEnabled) return;
                const shouldApply = muts.some(m => m.addedNodes.length > 0 ||
                    (m.target.closest && m.target.closest('[data-testid="chat-container"], main')));
                if (shouldApply) debouncedApply();
            }).observe(document.documentElement, { childList: true, subtree: true });
        }

        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
        else init();
    })();

    /* ================= MODULE 2: EXPORTER ================= */
    (function exporterModule() {
        let dot, progressLabel, tooltip, excl, logPanel, logBody;
        let logPanelVisible = false;
        let exportInProgress = false;
        const LOG = '[Claude Export]';
        const COLORS = { idle: '#4ade80', exporting: '#fbbf24', success: '#22c55e', warning: '#f97316', error: '#ef4444' };
        const LINE_COLORS = { info: '#d1d5db', success: '#4ade80', warning: '#fb923c', error: '#f87171' };
        const CONSOLE_STYLES = {
            info: 'color:#9ca3af',
            success: 'color:#22c55e;font-weight:600',
            warning: 'color:#f97316;font-weight:600',
            error: 'color:#ef4444;font-weight:600'
        };
        const FLOPPY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" width="100%" height="100%">
            <path d="M4 4h13l3 3v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/>
            <path d="M7 4v5h9V4"/>
            <rect x="8" y="13" width="8" height="6"/>
        </svg>`;

        // Speed-sampling cadence for the download-phase progress label. Note: a
        // browser can't usefully redraw more than roughly every ~4ms (the DOM/paint
        // floor), and anything faster than the eye can track just burns CPU for no
        // visible benefit — so this is 333ms (3 updates/sec) rather than sub-ms.
        // Change this constant if you want a different cadence.
        const SPEED_REFRESH_MS = 333;
        function formatSpeed(bps) {
            if (!isFinite(bps) || bps < 0) bps = 0;
            if (bps < 1024) return `${bps.toFixed(0)} B/s`;
            if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
            return `${(bps / (1024 * 1024)).toFixed(2)} MB/s`;
        }
        function formatBytes(n) {
            if (!isFinite(n) || n < 0) n = 0;
            if (n < 1024) return `${n} B`;
            if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
            return `${(n / (1024 * 1024)).toFixed(2)} MB`;
        }

        // Deltas relative to the shared anchor (which equals the dot's own position, delta 0,0).
        const OFFSETS = {
            dot: { top: 0, right: 0 },
            progressLabel: { top: 26, right: -2 },
            tooltip: { top: 42, right: 0 },
            excl: { top: -3, right: -3 },
            logPanel: { top: 136, right: 0 }
        };

        let state = { status: 'idle', message: 'Export conversation to Markdown', issues: [] };
        let lastSpeedBps = null;

        function reposition(anchor) {
            dot.style.top = (anchor.top + OFFSETS.dot.top) + 'px';
            dot.style.right = (anchor.right + OFFSETS.dot.right) + 'px';
            progressLabel.style.top = (anchor.top + OFFSETS.progressLabel.top) + 'px';
            progressLabel.style.right = (anchor.right + OFFSETS.progressLabel.right) + 'px';
            tooltip.style.top = (anchor.top + OFFSETS.tooltip.top) + 'px';
            tooltip.style.right = (anchor.right + OFFSETS.tooltip.right) + 'px';
            excl.style.top = (anchor.top + OFFSETS.excl.top) + 'px';
            excl.style.right = (anchor.right + OFFSETS.excl.right) + 'px';
            logPanel.style.top = (anchor.top + OFFSETS.logPanel.top) + 'px';
            logPanel.style.right = (anchor.right + OFFSETS.logPanel.right) + 'px';
        }

        function logEntry(level, message) {
            console.log(`%c${LOG} ${message}`, CONSOLE_STYLES[level] || CONSOLE_STYLES.info);
            if (!logBody) return;
            const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
            const line = document.createElement('div');
            line.style.cssText = `color:${LINE_COLORS[level] || LINE_COLORS.info}; padding:1px 0; white-space:pre-wrap;`;
            line.textContent = `[${ts}] ${message}`;
            logBody.appendChild(line);
            logBody.scrollTop = logBody.scrollHeight;
        }

        function renderTooltip() {
            tooltip.innerHTML = '';
            const msgEl = document.createElement('div');
            msgEl.style.fontWeight = '600';
            msgEl.textContent = state.message;
            tooltip.appendChild(msgEl);
            if (state.issues.length) {
                const ul = document.createElement('ul');
                ul.style.cssText = 'margin:3px 0 0 14px;padding:0;';
                state.issues.forEach(issue => {
                    const li = document.createElement('li');
                    li.textContent = issue;
                    ul.appendChild(li);
                });
                tooltip.appendChild(ul);
            }
            const hint = document.createElement('div');
            hint.style.cssText = 'margin-top:4px;opacity:0.7;font-size:10px;';
            hint.textContent = 'Right-click for detailed log';
            tooltip.appendChild(hint);
        }

        function setState(status, message, issues = []) {
            state = { status, message, issues };
            dot.style.background = COLORS[status];
            // Pulses the dot while a fetch/build is actually in flight so a long
            // silent wait (large or tool-heavy conversations can take a couple
            // minutes just to get a response) still visibly reads as "working"
            // rather than "stuck".
            dot.classList.toggle('claude-export-pulse', status === 'exporting');
            excl.style.display = (status === 'warning' || status === 'error') ? 'flex' : 'none';
            renderTooltip();
        }

        function formatTimestamp(iso) {
            if (!iso) return null;
            return new Date(iso).toLocaleString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
            });
        }

        function getFileTimestamp() {
            const d = new Date();
            const pad = n => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
        }

        // Phase 1 (0-50%): stream response body, track bytes vs Content-Length.
        async function fetchConversationData(onProgress) {
            const conversationId = window.location.pathname.split('/').pop();
            const orgId = document.cookie.match(/lastActiveOrg=([^;]+)/)?.[1];
            logEntry('info', `conversationId=${conversationId} orgId=${orgId}`);
            if (!conversationId || !orgId) throw new Error('No conversation/org ID');
            const url = `/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=true&rendering_mode=messages&render_all_tools=true`;
            const fetchStart = performance.now();
            logEntry('info', `Fetching ${url}`);
            const res = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' } });
            logEntry('info', `Response status: ${res.status} (headers took ${((performance.now() - fetchStart) / 1000).toFixed(1)}s — large or tool-heavy conversations can take a while here before any bytes arrive)`);
            if (!res.ok) throw new Error(`API error: ${res.status}`);

            // This is the actual "started downloading" moment — headers are in and
            // the body is now streaming (or about to be). Everything before this
            // line was an indeterminate wait with nothing to report, which is why
            // the label shows "Preparing…" rather than a static, misleadingly
            // precise "0%" for however long that wait turns out to be.
            onProgress(0);

            const contentLength = +res.headers.get('Content-Length');
            const byteCheck = { expected: contentLength || null, received: null, ok: true };
            let data;

            if (!res.body) {
                // No readable stream at all (older/unsupported fetch impl) — nothing to sample.
                logEntry('info', 'Response body is not a stream — skipping byte-progress and speed');
                onProgress(50);
                const raw = await res.text();
                byteCheck.received = raw.length;
                data = JSON.parse(raw);
            } else {
                // Content-Length is commonly absent on compressed/chunked responses,
                // and more likely to disappear as a conversation (and its response
                // size) grows. That only removes the ability to compute a % — the
                // stream itself is still readable, so speed and a running byte
                // count are tracked either way.
                if (!contentLength) logEntry('info', 'No Content-Length header — showing live byte count instead of a percentage, speed still tracked');
                const reader = res.body.getReader();
                const chunks = [];
                let received = 0;
                // Speed is sampled on its own timer (not per-chunk) so a slow
                // connection — where chunks may arrive seconds apart — still gets
                // a live, adapting B/s → KB/s → MB/s readout rather than a frozen one.
                const downloadStart = performance.now();
                let lastBytes = 0;
                let lastTime = downloadStart;
                const speedTimer = setInterval(() => {
                    const now = performance.now();
                    const dt = (now - lastTime) / 1000;
                    const speed = dt > 0 ? (received - lastBytes) / dt : 0;
                    lastBytes = received;
                    lastTime = now;
                    const pct = contentLength ? Math.min(50, Math.round((received / contentLength) * 50)) : null;
                    onProgress(pct, speed, contentLength ? null : received);
                }, SPEED_REFRESH_MS);
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        chunks.push(value);
                        received += value.length;
                        if (contentLength) onProgress(Math.min(50, Math.round((received / contentLength) * 50)));
                    }
                } finally {
                    clearInterval(speedTimer);
                }
                // Small/fast exports commonly finish inside a single
                // SPEED_REFRESH_MS window, so the interval above may never have
                // fired even once — that's a real 0-samples case, not a bug in the
                // sampling logic, so it needs its own fallback: an average over the
                // whole download, computed unconditionally here.
                const downloadElapsedSec = (performance.now() - downloadStart) / 1000;
                const avgSpeed = downloadElapsedSec > 0 ? received / downloadElapsedSec : received;
                logEntry('info', `Download finished: ${formatBytes(received)} in ${(downloadElapsedSec * 1000).toFixed(0)}ms (avg ${formatSpeed(avgSpeed)})`);
                onProgress(50, avgSpeed, contentLength ? null : received);
                // buildMarkdown() runs synchronously right after this returns, with
                // no yield point in between — on a fast/small export that can all
                // happen within one JS task, so the browser never gets a chance to
                // actually paint the speed reading above before it's overwritten.
                // This forces a real, guaranteed-visible pause on the number every
                // time, regardless of how fast everything else was.
                await new Promise(r => setTimeout(r, 500));
                byteCheck.received = received;
                byteCheck.ok = contentLength ? received === contentLength : true;
                if (contentLength && !byteCheck.ok) {
                    logEntry('warning', `BYTE MISMATCH: received ${received}, expected ${contentLength} — response may be truncated`);
                } else {
                    logEntry('success', `All ${received} bytes received${contentLength ? ' intact' : ''}`);
                }
                data = JSON.parse(await new Blob(chunks).text());
            }

            const total = data.chat_messages?.length ?? 0;
            logEntry('info', `Raw chat_messages count: ${total}`);
            if (total === 0) logEntry('warning', 'No messages found in response');

            ['has_more', 'next_cursor', 'total_count'].forEach(k => {
                if (data[k] !== undefined) logEntry('info', `API field '${k}' = ${data[k]}`);
            });

            return { data, byteCheck };
        }

        function getConversationTitle(data) {
            const title = data?.name?.trim();
            if (!title || title === 'New conversation') return 'claude_conversation';
            return title.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_')
                .replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '').toLowerCase().substring(0, 100);
        }

        function analyzeContent(content) {
            if (!Array.isArray(content)) return { text: '', types: [], malformed: true };
            const types = content.map(c => c.type).filter(Boolean);
            const text = content.filter(c => c.type === 'text' && c.text).map(c => c.text).join('\n\n').trim();
            return { text, types, malformed: false };
        }

        function extractAttachments(msg) {
            const names = [];
            [msg.attachments, msg.files, msg.files_v2].forEach(arr => {
                if (Array.isArray(arr)) arr.forEach(f => {
                    const n = f?.file_name || f?.name || f?.filename;
                    if (n) names.push(n);
                });
            });
            if (Array.isArray(msg.content)) {
                msg.content.forEach(c => {
                    const n = c?.file_name || c?.name || c?.source?.file_name;
                    if (n) names.push(n);
                });
            }
            return [...new Set(names)];
        }

        // Phase 2 (50-100%): exact progress + verbose per-message log + integrity checks.
        function buildMarkdown(data, onProgress) {
            let md = "# Conversation with Claude\n\n";
            let humanCount = 0, claudeCount = 0, emptySkipped = 0, malformedCount = 0, unknownSenderCount = 0;
            const nonTextBlockCounts = {};
            const seenUuids = new Set();
            let duplicateCount = 0;
            const uploadedFiles = [];
            const downloadedFiles = [];
            const messages = data.chat_messages || [];
            const total = messages.length || 1;

            messages.forEach((msg, i) => {
                const uuid = msg.uuid ?? msg.id;
                let dupFlag = '';
                if (uuid) {
                    if (seenUuids.has(uuid)) { duplicateCount++; dupFlag = ' [DUPLICATE UUID]'; }
                    else seenUuids.add(uuid);
                }

                if (msg.sender !== 'human' && msg.sender !== 'assistant') {
                    unknownSenderCount++;
                    logEntry('warning', `Msg ${i + 1}/${messages.length}: unexpected sender '${msg.sender}'${dupFlag}`);
                }

                const { text, types, malformed } = analyzeContent(msg.content);
                if (malformed) {
                    malformedCount++;
                    logEntry('error', `Msg ${i + 1}/${messages.length} (${msg.sender}): malformed/missing content array${dupFlag}`);
                }
                types.filter(t => t !== 'text').forEach(t => {
                    nonTextBlockCounts[t] = (nonTextBlockCounts[t] || 0) + 1;
                });

                const attachments = extractAttachments(msg);
                if (attachments.length) {
                    logEntry('info', `Msg ${i + 1}/${messages.length} (${msg.sender}): attachments=[${attachments.join(', ')}]`);
                    if (msg.sender === 'human') uploadedFiles.push(...attachments);
                    else downloadedFiles.push(...attachments);
                }
                const attachLine = attachments.length ? `**Attached:** ${attachments.join(', ')}\n\n` : '';

                if (!text && !attachments.length) {
                    emptySkipped++;
                    logEntry('info', `Msg ${i + 1}/${messages.length} (${msg.sender}): skipped, no text, blocks=[${types.join(', ') || 'none'}]${dupFlag}`);
                } else if (msg.sender === 'human') {
                    humanCount++;
                    const ts = formatTimestamp(msg.created_at);
                    md += `## Human${ts ? ` (${ts})` : ''}:\n\n${attachLine}${text}\n\n---\n\n`;
                    logEntry('success', `Msg ${i + 1}/${messages.length} (human): captured, ${text.length} chars${dupFlag}`);
                } else {
                    claudeCount++;
                    md += `## Claude:\n\n${attachLine}${text}\n\n---\n\n`;
                    logEntry('success', `Msg ${i + 1}/${messages.length} (assistant): captured, ${text.length} chars, extra blocks=[${types.filter(t => t !== 'text').join(', ') || 'none'}]${dupFlag}`);
                }
                onProgress(50 + Math.round(((i + 1) / total) * 50));
            });

            const nonTextTotal = Object.values(nonTextBlockCounts).reduce((a, b) => a + b, 0);
            if (nonTextTotal) logEntry('warning', `Non-text blocks present (not exported): ${JSON.stringify(nonTextBlockCounts)}`);
            if (duplicateCount) logEntry('warning', `${duplicateCount} duplicate UUID(s) — tree=true likely returned branched/regenerated messages`);
            if (uploadedFiles.length) logEntry('info', `Files uploaded by user: ${uploadedFiles.join(', ')}`);
            if (downloadedFiles.length) logEntry('info', `Files provided for download by Claude: ${downloadedFiles.join(', ')}`);
            logEntry('info', `Markdown size: ${md.length} chars`);

            return {
                markdown: md,
                summary: {
                    totalMessages: messages.length, humanCount, claudeCount,
                    emptySkipped, malformedCount, unknownSenderCount,
                    duplicateCount, nonTextTotal, uploadedFiles, downloadedFiles
                }
            };
        }

        function downloadMarkdown(content, filename) {
            const blob = new Blob([content], { type: 'text/markdown' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(a.href);
            logEntry('success', `Download triggered: ${filename}`);
        }

        function setProgress(pct, speedBps, bytesReceived) {
            if (speedBps != null) lastSpeedBps = speedBps;
            // Only show speed while a total is unknown (pct === null) or still in
            // the download phase (pct < 50); phase 2 has no transfer speed to
            // report, and clearing it here stops a stale KB/s reading from
            // lingering into the markdown-building phase.
            const showSpeed = lastSpeedBps != null && (pct === null || pct < 50);
            const speedStr = showSpeed ? ` · ${formatSpeed(lastSpeedBps)}` : '';
            // pct is null when Content-Length was missing and the total size is
            // unknown — show a running byte count instead of a percentage.
            const mainStr = pct === null ? (bytesReceived != null ? formatBytes(bytesReceived) : '…') : `${pct}%`;
            const label = `${mainStr}${speedStr}`;
            progressLabel.textContent = label;
            progressLabel.style.display = 'block';
            state.message = `Exporting... ${label}`;
            renderTooltip();
        }

        async function runExport() {
            if (exportInProgress) {
                logEntry('warning', 'Export already in progress — ignoring extra click (the long wait before "0%" appears is a real, slow API response for large/tool-heavy conversations, not a stall; clicking again starts a second overlapping export and is what causes it to look stuck).');
                return;
            }
            exportInProgress = true;
            logEntry('info', '=== Export started ===');
            lastSpeedBps = null;
            setState('exporting', 'Preparing to download…');
            progressLabel.textContent = 'Preparing…';
            progressLabel.style.display = 'block';
            try {
                const { data, byteCheck } = await fetchConversationData(setProgress);
                const { markdown, summary } = buildMarkdown(data, setProgress);
                const filename = `${getConversationTitle(data)}_${getFileTimestamp()}.md`;
                downloadMarkdown(markdown, filename);

                console.log(`${LOG} --- Completeness summary ---`);
                console.table({ ...summary, byteCheckOk: byteCheck.ok, byteExpected: byteCheck.expected, byteReceived: byteCheck.received });

                const issues = [];
                if (!byteCheck.ok) issues.push(`Byte mismatch: got ${byteCheck.received}/${byteCheck.expected}`);
                if (summary.malformedCount > 0) issues.push(`${summary.malformedCount} malformed message(s)`);
                if (summary.duplicateCount > 0) issues.push(`${summary.duplicateCount} duplicate UUID(s) — branched messages`);
                if (summary.totalMessages === 0) issues.push('No messages found in response');

                if (issues.length) {
                    logEntry('warning', `Export completed WITH WARNINGS: ${issues.join(' | ')}`);
                    setState('warning', `Exported with warnings: ${filename}`, issues);
                } else {
                    logEntry('success', `=== Export complete, no integrity issues: ${filename} ===`);
                    setState('success', `Exported: ${filename}`);
                }
            } catch (err) {
                logEntry('error', `Export failed: ${err.message}`);
                setState('error', `Export failed: ${err.message}`, [err.message]);
            } finally {
                exportInProgress = false;
                setTimeout(() => {
                    progressLabel.style.display = 'none';
                    setState('idle', 'Export conversation to Markdown');
                }, 3000);
            }
        }

        function toggleLogPanel() {
            logPanelVisible = !logPanelVisible;
            logPanel.style.display = logPanelVisible ? 'flex' : 'none';
        }

        function init() {
            if (dot) return;

            const pulseStyle = document.createElement('style');
            pulseStyle.textContent = `
                @keyframes claude-export-pulse-kf { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
                #claude-export-dot.claude-export-pulse { animation: claude-export-pulse-kf 1.1s ease-in-out infinite; }
            `;
            document.head.appendChild(pulseStyle);

            dot = makeDot({
                id: 'claude-export-dot', color: COLORS.idle,
                title: '', onClick: runExport, size: 18, padding: 3, iconHtml: FLOPPY_ICON
            });
            dot.addEventListener('contextmenu', e => { e.preventDefault(); toggleLogPanel(); });

            window.addEventListener('claude-fw-panel-toggle', e => {
                if (e.detail.open) {
                    dot.style.zIndex = '1';
                    dot.style.opacity = '0.3';
                } else {
                    dot.style.zIndex = '999999';
                    dot.style.opacity = '1';
                }
            });

            progressLabel = document.createElement('div');
            progressLabel.id = 'claude-export-progress';
            progressLabel.style.cssText = `
                position: fixed; z-index: 999999;
                font-family: monospace; font-size: 10px; color: #e5e7eb;
                background: #1f2937; padding: 1px 4px; border-radius: 3px;
                display: none; pointer-events: none; box-shadow: 0 2px 6px rgba(0,0,0,0.4);
            `;
            document.body.appendChild(progressLabel);

            tooltip = document.createElement('div');
            tooltip.id = 'claude-export-tooltip';
            tooltip.style.cssText = `
                position: fixed; z-index: 999999;
                max-width: 220px; background: #111827; color: #e5e7eb;
                padding: 6px 8px; border-radius: 6px; font-family: system-ui, sans-serif;
                font-size: 11px; line-height: 1.4; border: 1px solid #374151;
                box-shadow: 0 4px 14px rgba(0,0,0,0.5); display: none; pointer-events: none;
            `;
            document.body.appendChild(tooltip);

            excl = document.createElement('div');
            excl.id = 'claude-export-excl';
            excl.textContent = '!';
            excl.style.cssText = `
                position: fixed; z-index: 1000000;
                width: 10px; height: 10px; border-radius: 50%; background: #dc2626;
                color: white; font-size: 8px; font-weight: 700; line-height: 1;
                display: none; align-items: center; justify-content: center;
                box-shadow: 0 1px 4px rgba(0,0,0,0.5); pointer-events: none;
            `;
            document.body.appendChild(excl);

            logPanel = document.createElement('div');
            logPanel.id = 'claude-export-logpanel';
            logPanel.style.cssText = `
                position: fixed; z-index: 999999;
                width: 380px; max-height: 280px; background: #0b0f17; color: #d1d5db;
                border: 1px solid #374151; border-radius: 6px; box-shadow: 0 4px 18px rgba(0,0,0,0.5);
                display: none; flex-direction: column; font-family: system-ui, sans-serif;
            `;
            const logHeader = document.createElement('div');
            logHeader.style.cssText = `
                display:flex; justify-content:space-between; align-items:center;
                padding:5px 8px; background:#1f2937; border-bottom:1px solid #374151;
                font-size:11px; font-weight:600; border-radius:6px 6px 0 0;
            `;
            logHeader.innerHTML = `<span>Export Log</span>`;
            const headerBtns = document.createElement('div');
            const clearBtn = document.createElement('button');
            clearBtn.textContent = 'Clear';
            clearBtn.style.cssText = 'background:#374151;border:none;color:#e5e7eb;font-size:10px;padding:2px 6px;border-radius:3px;cursor:pointer;margin-right:4px;';
            clearBtn.addEventListener('click', () => { logBody.innerHTML = ''; });
            const closeBtn = document.createElement('button');
            closeBtn.textContent = '✕';
            closeBtn.style.cssText = 'background:none;border:none;color:#94a3b8;font-size:13px;cursor:pointer;';
            closeBtn.addEventListener('click', toggleLogPanel);
            headerBtns.appendChild(clearBtn);
            headerBtns.appendChild(closeBtn);
            logHeader.appendChild(headerBtns);

            logBody = document.createElement('div');
            logBody.style.cssText = `
                overflow-y: auto; padding: 6px 8px; font-family: monospace;
                font-size: 10.5px; line-height: 1.5; flex: 1;
            `;

            logPanel.appendChild(logHeader);
            logPanel.appendChild(logBody);
            document.body.appendChild(logPanel);

            dot.addEventListener('mouseenter', () => { tooltip.style.display = 'block'; });
            dot.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });

            reposition(ClaudeUIAnchor.getAnchor());
            ClaudeUIAnchor.onChange(reposition);

            setState('idle', 'Export conversation to Markdown');
            logEntry('info', 'Exporter ready. Left-click to export, right-click to toggle this log.');
        }

        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
        else init();
    })();

    /* ================= MODULE 3: SCHEDULED SEND ================= */
    // Stopwatch icon (own draggable anchor — ClaudeScheduleAnchor, near the composer
    // by default). Click opens a small panel prefilled with whatever you've already
    // typed. Pick/confirm a cooldown reset time (auto-detected from the page on a
    // best-effort basis, or set manually) plus a delay after it, hit Schedule, and
    // the script will insert the message and send it for you at that time — even
    // across a reload, as long as this tab/window stays open.
    //
    // NOTE ON RELIABILITY: the cooldown-reset auto-detect and the send-button/
    // composer lookups below are best-effort text/selector guesses against
    // Claude.ai's current markup. If Claude changes its UI these can silently stop
    // matching — use the manual "reset in Xh Ym" fields as the reliable fallback,
    // and right-click the stopwatch to open the debug log if a send doesn't fire.
    (function scheduleModule() {
        const SCHED_STORAGE_KEY = 'claude_scheduled_send';

        function hasGM() { return typeof GM_getValue === 'function' && typeof GM_setValue === 'function'; }
        function saveTask(task) {
            try {
                const json = JSON.stringify(task);
                if (hasGM()) GM_setValue(SCHED_STORAGE_KEY, json); else localStorage.setItem(SCHED_STORAGE_KEY, json);
            } catch (e) {}
        }
        function loadTask() {
            try {
                const raw = hasGM() ? GM_getValue(SCHED_STORAGE_KEY, null) : localStorage.getItem(SCHED_STORAGE_KEY);
                return raw ? JSON.parse(raw) : null;
            } catch (e) { return null; }
        }
        function clearTask() {
            try { if (hasGM()) GM_setValue(SCHED_STORAGE_KEY, null); else localStorage.removeItem(SCHED_STORAGE_KEY); } catch (e) {}
        }

        const LOG = '[Claude Schedule]';
        const CONSOLE_STYLES = {
            info: 'color:#9ca3af',
            success: 'color:#22c55e;font-weight:600',
            warning: 'color:#f97316;font-weight:600',
            error: 'color:#ef4444;font-weight:600'
        };
        const LINE_COLORS = { info: '#d1d5db', success: '#4ade80', warning: '#fb923c', error: '#f87171' };
        let logBody;
        function logSched(level, message) {
            console.log(`%c${LOG} ${message}`, CONSOLE_STYLES[level] || CONSOLE_STYLES.info);
            if (!logBody) return;
            const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
            const line = document.createElement('div');
            line.style.cssText = `color:${LINE_COLORS[level] || LINE_COLORS.info}; padding:1px 0; white-space:pre-wrap;`;
            line.textContent = `[${ts}] ${message}`;
            logBody.appendChild(line);
            logBody.scrollTop = logBody.scrollHeight;
        }

        // ---- composer / send-button discovery (best-effort — adjust selectors here if needed) ----
        function findComposerElement() {
            const notOurs = el => el && !el.closest('#claude-schedule-panel, #claude-schedule-logpanel');
            const selectors = [
                'div.ProseMirror[contenteditable="true"]',
                'div[contenteditable="true"][translate="no"]',
                'fieldset div[contenteditable="true"]',
                'div[contenteditable="true"]'
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (notOurs(el)) return el;
            }
            return null;
        }
        function findSendButton() {
            let btn = document.querySelector('button[aria-label="Send message"]')
                || document.querySelector('button[aria-label="Send Message"]')
                || document.querySelector('button[data-testid="send-message-button"]')
                || Array.from(document.querySelectorAll('button')).find(b => /send message/i.test(b.getAttribute('aria-label') || ''));
            if (btn) return btn;

            // Fallback: Claude changed the exact label/testid before, so if none of the
            // known selectors hit, look inside the composer's own form/toolbar instead —
            // prefer a button whose label mentions "send", else assume the last button
            // in that container (the send button is conventionally rightmost).
            const composer = findComposerElement();
            const container = composer && (composer.closest('form') || composer.closest('[class*="composer" i]') || composer.parentElement?.parentElement);
            if (container) {
                const buttons = Array.from(container.querySelectorAll('button'));
                btn = buttons.find(b => /send/i.test(b.getAttribute('aria-label') || b.textContent || '')) || buttons[buttons.length - 1];
            }
            return btn || null;
        }
        function isButtonUsable(btn) {
            return !!btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true' && btn.getAttribute('data-disabled') !== 'true';
        }
        function getComposerText() {
            const el = findComposerElement();
            return el ? el.innerText.trim() : '';
        }
        function setComposerText(text) {
            const el = findComposerElement();
            if (!el) return false;
            el.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
            document.execCommand('insertText', false, text);
            el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
            return true;
        }
        async function sendScheduledMessage(text) {
            logSched('info', 'Attempting scheduled send...');
            if (!setComposerText(text)) { logSched('error', 'Composer not found — cannot insert text yet'); return false; }
            await new Promise(r => setTimeout(r, 400));

            const btn = findSendButton();
            if (btn) {
                logSched('info', `Send button candidate: aria-label="${btn.getAttribute('aria-label') || ''}" disabled=${btn.disabled} aria-disabled="${btn.getAttribute('aria-disabled') || ''}"`);
            } else {
                logSched('warning', 'No send button matched any known selector or fallback.');
            }

            if (isButtonUsable(btn)) {
                btn.click();
                logSched('info', 'Send button clicked — verifying...');
            } else {
                const el = findComposerElement();
                if (!el) { logSched('error', 'No composer or send button found — send failed'); return false; }
                el.focus();
                ['keydown', 'keypress', 'keyup'].forEach(type => {
                    el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
                });
                logSched('warning', 'Send button missing/disabled — simulated Enter keypress, verifying...');
            }

            // Neither a click() nor a synthetic keypress guarantees the app actually
            // submitted anything, so confirm rather than assume: a successful send
            // clears the composer. If our text is still sitting there, it didn't go
            // through (common cause: the send handler ignores untrusted/synthetic
            // events, or the button's real disabled state isn't the `disabled`
            // attribute at all — check the aria-disabled value logged above).
            await new Promise(r => setTimeout(r, 500));
            const after = findComposerElement();
            if (after && after.innerText.trim().length > 0) {
                logSched('error', 'Composer still has text after the attempt — send did NOT go through. Will retry.');
                return false;
            }
            logSched('success', 'Composer is empty — send appears to have gone through.');
            return true;
        }

        // ---- retry-click discovery/execution (best-effort — same caveats as above) ----
        // Finds every Retry/Regenerate-style button in DOM order (top to bottom of
        // the conversation, i.e. oldest to newest). A negative index counts from
        // the end like Python/JS array indexing: -1 = latest message's retry button.
        function findRetryButtons() {
            const notOurs = el => el && !el.closest('#claude-schedule-panel, #claude-schedule-logpanel');
            return Array.from(document.querySelectorAll('button')).filter(b => {
                if (!notOurs(b)) return false;
                const label = (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').toLowerCase();
                return /retry|regenerate/.test(label);
            });
        }
        // Long conversations are virtualized — only messages near the viewport
        // exist in the DOM at all, which is why a plain findRetryButtons() scan
        // only ever turns up a handful. This finds the scrollable message list
        // and walks it to the top, giving the virtualizer a chance to mount
        // everything, so indices further back than "currently on screen" resolve
        // correctly. Restores the original scroll position when done.
        function findScrollableAncestor(el) {
            let cur = el;
            while (cur && cur !== document.documentElement) {
                const style = getComputedStyle(cur);
                if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && cur.scrollHeight > cur.clientHeight + 20) return cur;
                cur = cur.parentElement;
            }
            return null;
        }
        function findConversationScrollContainer() {
            const anchorBtn = findRetryButtons()[0];
            if (anchorBtn) {
                const found = findScrollableAncestor(anchorBtn);
                if (found) return found;
            }
            // Fallback if no retry button is rendered yet to anchor from: the
            // largest scrollable region on the page is very likely the message list.
            let best = null, bestOverflow = 0;
            document.querySelectorAll('div, main, section').forEach(el => {
                const style = getComputedStyle(el);
                if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                    const overflow = el.scrollHeight - el.clientHeight;
                    if (overflow > bestOverflow) { bestOverflow = overflow; best = el; }
                }
            });
            return best;
        }
        async function loadAllRetryButtons(maxIterations = 60) {
            const container = findConversationScrollContainer();
            if (!container) {
                logSched('warning', 'Could not find the scrollable conversation container — only currently-rendered retry buttons are visible.');
                return findRetryButtons();
            }
            const originalScrollTop = container.scrollTop;
            let lastScrollHeight = -1;
            let iterations = 0;
            logSched('info', 'Scrolling up to load the full conversation (virtualized lists only keep nearby messages mounted)...');
            while (iterations < maxIterations) {
                container.scrollTop = 0;
                await new Promise(r => setTimeout(r, 200));
                if (container.scrollHeight === lastScrollHeight) break; // reached the actual top, nothing new mounted
                lastScrollHeight = container.scrollHeight;
                iterations++;
            }
            const buttons = findRetryButtons();
            logSched('success', `Finished scrolling (${iterations} step${iterations === 1 ? '' : 's'}) — found ${buttons.length} retry button(s) total.`);
            container.scrollTop = originalScrollTop;
            return buttons;
        }
        function resolveRetryIndex(rawIndex, buttons) {
            return rawIndex < 0 ? buttons.length + rawIndex : rawIndex;
        }
        // Climbs up from the retry button looking for the ancestor that's plausibly
        // "the whole message" rather than just its small button toolbar — approximated
        // as the first ancestor with a meaningful amount of text, since the exact
        // message-container class/attribute isn't known. Falls back to the button
        // itself if nothing better turns up within a few levels.
        function findMessageContainerForButton(btn) {
            let el = btn;
            for (let i = 0; i < 8 && el.parentElement; i++) {
                el = el.parentElement;
                if (el.innerText && el.innerText.trim().length > 40) return el;
            }
            return btn;
        }
        let highlightedEl = null;
        function clearHighlight() {
            if (highlightedEl) {
                highlightedEl.style.outline = '';
                highlightedEl.style.outlineOffset = '';
                highlightedEl = null;
            }
        }
        // Highlights (green outline) + scrolls to whichever message `rawIndex`
        // currently resolves to, so picking "-1" shows you exactly what "latest"
        // means right now, live, before you commit to scheduling it. Fast/live-typing
        // path — only scans what's already rendered; use "Load full history" first
        // if you need an index further back than what's currently mounted.
        function highlightRetryTarget(rawIndex) {
            clearHighlight();
            const buttons = findRetryButtons();
            const resolved = resolveRetryIndex(rawIndex, buttons);
            if (resolved < 0 || resolved >= buttons.length || buttons.length === 0) {
                return { ok: false, total: buttons.length, resolved };
            }
            const container = findMessageContainerForButton(buttons[resolved]);
            container.style.outline = '3px solid #22c55e';
            container.style.outlineOffset = '2px';
            container.scrollIntoView({ behavior: 'smooth', block: 'center' });
            highlightedEl = container;
            return { ok: true, total: buttons.length, resolved };
        }
        async function executeRetryClick(rawIndex) {
            logSched('info', `Attempting scheduled retry click (index ${rawIndex})...`);
            // Always do the full scroll-load at execution time (not just the live
            // fast-path) since accuracy matters more than speed when unattended,
            // and there's no user waiting on this to feel instant.
            const buttons = await loadAllRetryButtons();
            const resolved = resolveRetryIndex(rawIndex, buttons);
            if (resolved < 0 || resolved >= buttons.length) {
                logSched('error', `Retry index ${rawIndex} resolves out of range (found ${buttons.length} retry button(s) total) — will retry.`);
                return false;
            }
            const btn = buttons[resolved];
            if (!isButtonUsable(btn)) {
                logSched('warning', 'Matched retry button is disabled/unusable right now — will retry.');
                return false;
            }
            btn.click();
            logSched('info', 'Retry button clicked — checking for a generation-in-progress signal...');
            await new Promise(r => setTimeout(r, 800));
            // This is an informational check only, not a pass/fail gate: unlike the
            // send case (typing text that a framework might silently ignore),
            // clicking a real, enabled button we found on the page is already a
            // solid signal the action registered, so we don't retry-loop just
            // because this specific secondary check doesn't find anything.
            const stopBtn = document.querySelector('button[aria-label*="stop" i]');
            if (stopBtn) logSched('success', 'A "stop generating"-style button appeared — regeneration appears to have started.');
            else logSched('warning', 'Could not confirm regeneration visually, but the click was dispatched on a real, enabled button.');
            return true;
        }

        // ---- cooldown detection (best-effort text scan; manual override always available) ----
        function scanForCooldownText() {
            const parts = [];
            document.querySelectorAll('[role="alert"], [aria-live], [class*="limit" i], [class*="cooldown" i], [data-testid*="limit" i]')
                .forEach(el => parts.push(el.innerText || ''));
            const sendBtn = findSendButton();
            if (sendBtn) parts.push(sendBtn.getAttribute('aria-label') || '', sendBtn.getAttribute('title') || '');
            parts.push(document.body.innerText || '');
            return parts.join('\n');
        }
        function absoluteTimeToday(hStr, mStr, ap) {
            const now = new Date();
            let hh = parseInt(hStr, 10);
            const mm = parseInt(mStr, 10);
            if (ap) { if (/PM/i.test(ap) && hh < 12) hh += 12; if (/AM/i.test(ap) && hh === 12) hh = 0; }
            const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
            if (t <= now) t.setDate(t.getDate() + 1);
            return t;
        }
        function parseCooldownFromText(text) {
            if (!text) return null;

            // Claude's actual free-tier message: "You are out of free messages
            // until 1:10 AM" — checked first since it's specific enough to be safe
            // to match against the whole page, even with a markdown link on
            // "messages" ([messages](url)) sitting in between.
            let m = text.match(/out of (?:free )?messages[\s\S]{0,60}?until\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
            if (m) return absoluteTimeToday(m[1], m[2], m[3]);

            // Generic phrasings, in case Claude reworded it (relative duration first).
            m = text.match(/(?:reset[s]?|available again|try again|come back)\D{0,15}(\d+)\s*h(?:our)?s?\s*(?:(\d+)\s*m(?:in)?(?:ute)?s?)?/i);
            if (m) return new Date(Date.now() + (parseInt(m[1], 10) * 60 + parseInt(m[2] || '0', 10)) * 60000);
            m = text.match(/(?:reset[s]?|available again|try again|come back)\D{0,15}(\d+)\s*m(?:in)?(?:ute)?s?\b/i);
            if (m) return new Date(Date.now() + parseInt(m[1], 10) * 60000);
            m = text.match(/(?:reset[s]?|available again|try again|come back|until)\D{0,15}(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
            if (m) return absoluteTimeToday(m[1], m[2], m[3]);

            return null;
        }


        // ---- UI state ----
        let dot, countdownLabel, panel, textarea, detectedEl, statusEl, logPanel, pieWrap;
        let retryRow, retryIndexInput, retryStatusEl, modeSendBtn, modeRetryBtn;
        let logPanelVisible = false;
        let detectedResetTime = null;
        let selectedDelayMinutes = 5;
        let currentTask = null;
        let tickInterval = null;
        let sending = false;
        let taskMode = 'send'; // 'send' | 'retry'

        const COLORS = { idle: '#38bdf8', scheduled: '#fbbf24', sent: '#22c55e', error: '#ef4444' };
        // Pie icon: a faint track circle plus a filled wedge that sweeps clockwise
        // from 12 o'clock as `fraction` (0..1) goes from schedule-time to send-time.
        function buildPieIconSVG(fraction) {
            fraction = Math.max(0, Math.min(1, isFinite(fraction) ? fraction : 0));
            const cx = 12, cy = 12, r = 9;
            const track = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.35"></circle>`;
            let slice = '';
            if (fraction >= 0.999) {
                slice = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor"></circle>`;
            } else if (fraction > 0.001) {
                const toXY = deg => {
                    const rad = (deg - 90) * Math.PI / 180;
                    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
                };
                const [sx, sy] = toXY(0);
                const [ex, ey] = toXY(fraction * 360);
                const largeArc = fraction > 0.5 ? 1 : 0;
                slice = `<path d="M ${cx} ${cy} L ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${ex.toFixed(2)} ${ey.toFixed(2)} Z" fill="currentColor"></path>`;
            }
            return `<svg viewBox="0 0 24 24" width="100%" height="100%">${track}${slice}</svg>`;
        }

        const OFFSETS = {
            dot: { bottom: 0, right: 0 },
            countdown: { bottom: -18, right: -6 },
            panel: { bottom: 34, right: 0 },
            logPanel: { bottom: 34, right: 280 }
        };

        function reposition(anchor) {
            dot.style.bottom = (anchor.bottom + OFFSETS.dot.bottom) + 'px';
            dot.style.right = (anchor.right + OFFSETS.dot.right) + 'px';
            countdownLabel.style.bottom = (anchor.bottom + OFFSETS.countdown.bottom) + 'px';
            countdownLabel.style.right = (anchor.right + OFFSETS.countdown.right) + 'px';
            panel.style.bottom = (anchor.bottom + OFFSETS.panel.bottom) + 'px';
            panel.style.right = (anchor.right + OFFSETS.panel.right) + 'px';
            logPanel.style.bottom = (anchor.bottom + OFFSETS.logPanel.bottom) + 'px';
            logPanel.style.right = (anchor.right + OFFSETS.logPanel.right) + 'px';
            // Re-clamp any panel that's currently open — dragging the icon (or
            // resizing the window, which re-fires this via the anchor's own
            // resize handler) can otherwise push an already-open panel off-screen.
            if (panel.style.display !== 'none') clampToViewport(panel);
            if (logPanel.style.display !== 'none') clampToViewport(logPanel);
        }

        // Keeps a fixed-position, bottom/right-anchored panel fully on-screen.
        // The anchor offsets above assume plenty of room above/left of the icon;
        // when the icon's been dragged near an edge that's not true, so this
        // measures the panel's actual rendered box and nudges bottom/right just
        // enough to bring any clipped edge back within `margin` of the viewport.
        function clampToViewport(el, margin = 8) {
            const rect = el.getBoundingClientRect();
            const vw = window.innerWidth, vh = window.innerHeight;
            let bottom = parseFloat(el.style.bottom) || 0;
            let right = parseFloat(el.style.right) || 0;

            const overTop = margin - rect.top;
            if (overTop > 0) bottom -= overTop;
            const overBottom = rect.bottom - (vh - margin);
            if (overBottom > 0) bottom += overBottom;

            const overLeft = margin - rect.left;
            if (overLeft > 0) right -= overLeft;
            const overRight = rect.right - (vw - margin);
            if (overRight > 0) right += overRight;

            el.style.bottom = Math.max(margin, bottom) + 'px';
            el.style.right = Math.max(margin, right) + 'px';
        }

        function setDotState(status) { dot.style.background = COLORS[status] || COLORS.idle; }
        function setPieProgress(fraction) { if (pieWrap) pieWrap.innerHTML = buildPieIconSVG(fraction); }

        function formatRemaining(ms) {
            if (ms <= 0) return '0:00';
            const totalSec = Math.floor(ms / 1000);
            const h = Math.floor(totalSec / 3600);
            const m = Math.floor((totalSec % 3600) / 60);
            const s = totalSec % 60;
            if (h > 0) return `${h}h ${m}m`;
            return `${m}:${String(s).padStart(2, '0')}`;
        }

        function setStatus(msg) { statusEl.textContent = msg; }

        function runDetection() {
            const found = parseCooldownFromText(scanForCooldownText());
            if (found) {
                detectedResetTime = found;
                detectedEl.textContent = found.toLocaleString();
                logSched('success', `Detected reset time: ${found.toLocaleString()}`);
            } else {
                detectedEl.textContent = 'not detected — set manually below';
                logSched('warning', 'Could not auto-detect a cooldown reset time from the page.');
            }
        }

        function onScheduleClick() {
            if (!detectedResetTime) { setStatus('Detect or manually set the reset time first.'); return; }
            const customEl = panel.querySelector('#claude-sched-custom-delay');
            const custom = parseInt(customEl.value, 10);
            const delayMin = (!isNaN(custom) && custom > 0) ? custom : selectedDelayMinutes;
            const target = detectedResetTime.getTime() + delayMin * 60000;

            if (taskMode === 'retry') {
                const idx = parseInt(retryIndexInput.value, 10);
                if (isNaN(idx)) { setStatus('Enter a valid retry index (e.g. -1).'); return; }
                const check = highlightRetryTarget(idx);
                if (!check.ok) { setStatus(`Index ${idx} doesn't match any retry button right now (found ${check.total}).`); return; }
                currentTask = { type: 'retry', index: idx, target, createdAt: Date.now() };
            } else {
                const text = textarea.value;
                if (!text.trim()) { setStatus('Message is empty.'); return; }
                currentTask = { type: 'send', message: text, target, createdAt: Date.now() };
            }
            saveTask(currentTask);
            startTicking();
            setStatus(`Scheduled for ${new Date(target).toLocaleString()}`);
            logSched('success', `Scheduled ${currentTask.type} for ${new Date(target).toLocaleString()} (${delayMin}m after reset)`);
        }

        function onCancelClick() {
            currentTask = null;
            clearTask();
            stopTicking();
            setDotState('idle');
            setPieProgress(0);
            countdownLabel.style.display = 'none';
            dot.title = 'Schedule a message';
            setStatus('Schedule cancelled.');
            logSched('info', 'Schedule cancelled by user.');
        }

        function startTicking() {
            if (tickInterval) return;
            tickInterval = setInterval(tick, 1000);
            tick();
        }
        function stopTicking() { clearInterval(tickInterval); tickInterval = null; }

        function tick() {
            if (!currentTask) { countdownLabel.style.display = 'none'; setDotState('idle'); setPieProgress(0); return; }
            const total = currentTask.target - currentTask.createdAt;
            const elapsed = Date.now() - currentTask.createdAt;
            setPieProgress(total > 0 ? elapsed / total : 1);
            const remaining = currentTask.target - Date.now();
            if (remaining <= 0) {
                if (sending) return;
                sending = true;
                setDotState('scheduled');
                setPieProgress(1);
                countdownLabel.style.display = 'block';
                countdownLabel.textContent = 'sending…';
                const type = currentTask.type || 'send'; // tasks saved before retry-mode existed are always 'send'
                const runner = type === 'retry' ? executeRetryClick(currentTask.index) : sendScheduledMessage(currentTask.message);
                runner.then(ok => {
                    sending = false;
                    if (ok) {
                        clearTask();
                        currentTask = null;
                        stopTicking();
                        setDotState('sent');
                        countdownLabel.style.display = 'none';
                        setTimeout(() => { setDotState('idle'); setPieProgress(0); }, 6000);
                    } else {
                        setDotState('error');
                        logSched('warning', `${type === 'retry' ? 'Retry click' : 'Send'} attempt failed — will retry in a few seconds.`);
                    }
                });
                return;
            }
            countdownLabel.style.display = 'block';
            countdownLabel.textContent = formatRemaining(remaining);
            dot.title = `Sending in ${formatRemaining(remaining)}`;
            setDotState('scheduled');
            if (panel.style.display !== 'none') {
                setStatus(`Sending in ${formatRemaining(remaining)} (at ${new Date(currentTask.target).toLocaleTimeString()})`);
            }
        }

        function toggleLogPanel() {
            logPanelVisible = !logPanelVisible;
            logPanel.style.display = logPanelVisible ? 'flex' : 'none';
            if (logPanelVisible) clampToViewport(logPanel);
        }

        function togglePanel() {
            const isHidden = panel.style.display === 'none' || !panel.style.display;
            if (isHidden) {
                textarea.value = getComposerText();
                runDetection();
                if (taskMode === 'retry') updateRetryPreview();
                panel.style.display = 'block';
                clampToViewport(panel);
            } else {
                panel.style.display = 'none';
                clearHighlight();
            }
        }
        function updateRetryPreview() {
            const raw = parseInt(retryIndexInput.value, 10);
            if (isNaN(raw)) { retryStatusEl.textContent = 'Enter a number (e.g. -1 for latest).'; clearHighlight(); return; }
            const result = highlightRetryTarget(raw);
            retryStatusEl.textContent = result.ok
                ? `→ message ${result.resolved + 1} of ${result.total} — highlighted in green`
                : `→ no match (found ${result.total} retry button(s) on the page)`;
        }
        function setMode(mode) {
            taskMode = mode;
            modeSendBtn.style.background = mode === 'send' ? '#2563eb' : '#374151';
            modeRetryBtn.style.background = mode === 'retry' ? '#2563eb' : '#374151';
            textarea.style.display = mode === 'send' ? 'block' : 'none';
            retryRow.style.display = mode === 'retry' ? 'block' : 'none';
            if (mode === 'retry') updateRetryPreview();
            else clearHighlight();
        }

        function createUI() {
            dot = makeDot({
                id: 'claude-schedule-dot', color: COLORS.idle,
                title: 'Schedule a message', onClick: togglePanel, size: 18, padding: 3, iconHtml: buildPieIconSVG(0)
            });
            pieWrap = dot.firstElementChild; // the icon container makeDot() creates around iconHtml
            dot.addEventListener('contextmenu', e => { e.preventDefault(); toggleLogPanel(); });

            countdownLabel = document.createElement('div');
            countdownLabel.id = 'claude-schedule-countdown';
            countdownLabel.style.cssText = `
                position: fixed; z-index: 999999; font-family: monospace; font-size: 10px;
                color: #e5e7eb; background: #1f2937; padding: 1px 4px; border-radius: 3px;
                display: none; pointer-events: none; box-shadow: 0 2px 6px rgba(0,0,0,0.4);
            `;
            document.body.appendChild(countdownLabel);

            panel = document.createElement('div');
            panel.id = 'claude-schedule-panel';
            panel.style.cssText = `
                position: fixed; z-index: 999999; width: 280px;
                background: #1f2937; color: #e5e7eb; padding: 10px 12px; border-radius: 8px;
                font-family: system-ui, sans-serif; font-size: 12px; display: none;
                box-shadow: 0 4px 20px rgba(0,0,0,0.5); border: 1px solid #4b5563;
            `;
            panel.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                    <strong style="font-size:12.5px;">Scheduled Send</strong>
                    <button id="claude-sched-close" style="background:none;border:none;color:#94a3b8;font-size:16px;cursor:pointer;line-height:1;">✕</button>
                </div>
                <div style="display:flex; gap:4px; margin-bottom:6px;">
                    <button id="claude-sched-mode-send" style="flex:1; background:#2563eb;border:none;color:white;padding:4px;border-radius:4px;font-size:10.5px;cursor:pointer;">Send message</button>
                    <button id="claude-sched-mode-retry" style="flex:1; background:#374151;border:none;color:white;padding:4px;border-radius:4px;font-size:10.5px;cursor:pointer;">Click retry</button>
                </div>
                <textarea id="claude-sched-text" placeholder="Message to send..." style="width:100%; height:70px; box-sizing:border-box; background:#111827; color:#e5e7eb; border:1px solid #374151; border-radius:4px; padding:5px; font-size:11.5px; resize:vertical;"></textarea>
                <div id="claude-sched-retry-row" style="display:none;">
                    <div style="display:flex; align-items:center; gap:4px;">
                        <span style="opacity:0.85;">Retry index (−1 = latest):</span>
                        <input id="claude-sched-retry-index" type="number" value="-1" style="width:50px; background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:3px;">
                        <button id="claude-sched-load-history" style="background:#374151;border:none;color:#e5e7eb;padding:2px 6px;border-radius:4px;font-size:10.5px;cursor:pointer;">Load full history</button>
                    </div>
                    <div id="claude-sched-retry-status" style="margin-top:4px; font-size:10.5px; opacity:0.85; min-height:13px;">not checked</div>
                    <div style="margin-top:2px; font-size:9.5px; opacity:0.55;">Long chats only render nearby messages — click Load if your target isn't found. Always scans the full chat automatically at send time regardless.</div>
                </div>
                <div style="margin-top:6px;">Cooldown reset: <span id="claude-sched-detected" style="opacity:0.85;">not detected</span>
                    <button id="claude-sched-redetect" style="margin-left:4px; background:#374151;border:none;color:#e5e7eb;padding:2px 6px;border-radius:4px;font-size:10.5px;cursor:pointer;">Detect</button>
                </div>
                <div style="margin-top:5px; display:flex; align-items:center; gap:4px;">
                    <span style="opacity:0.85;">Manual, in</span>
                    <input id="claude-sched-manual-h" type="number" min="0" value="5" style="width:34px; background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:3px;"> h
                    <input id="claude-sched-manual-m" type="number" min="0" max="59" value="0" style="width:34px; background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:3px;"> m
                    <button id="claude-sched-manual-apply" style="background:#374151;border:none;color:#e5e7eb;padding:2px 6px;border-radius:4px;font-size:10.5px;cursor:pointer;">Set</button>
                </div>
                <div style="margin-top:6px; opacity:0.85;">Send delay after reset:</div>
                <div style="display:flex; gap:4px; margin-top:3px; align-items:center; flex-wrap:wrap;">
                    <button class="claude-sched-delay-btn" data-min="5" style="background:#374151;border:none;color:#e5e7eb;padding:3px 7px;border-radius:4px;font-size:10.5px;cursor:pointer;">5m</button>
                    <button class="claude-sched-delay-btn" data-min="15" style="background:#374151;border:none;color:#e5e7eb;padding:3px 7px;border-radius:4px;font-size:10.5px;cursor:pointer;">15m</button>
                    <button class="claude-sched-delay-btn" data-min="30" style="background:#374151;border:none;color:#e5e7eb;padding:3px 7px;border-radius:4px;font-size:10.5px;cursor:pointer;">30m</button>
                    <button class="claude-sched-delay-btn" data-min="60" style="background:#374151;border:none;color:#e5e7eb;padding:3px 7px;border-radius:4px;font-size:10.5px;cursor:pointer;">60m</button>
                    <input id="claude-sched-custom-delay" type="number" min="1" placeholder="custom" style="width:56px; background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:3px;">
                </div>
                <div style="margin-top:8px; display:flex; gap:6px;">
                    <button id="claude-sched-schedule" style="flex:1; background:#2563eb;border:none;color:white;padding:5px;border-radius:4px;font-size:11.5px;cursor:pointer;">Schedule</button>
                    <button id="claude-sched-cancel" style="flex:1; background:#7f1d1d;border:none;color:white;padding:5px;border-radius:4px;font-size:11.5px;cursor:pointer;">Cancel</button>
                </div>
                <div id="claude-sched-status" style="margin-top:6px; font-size:10.5px; opacity:0.85; min-height:13px;"></div>
                <div style="margin-top:4px; font-size:9.5px; opacity:0.55;">Send mode replaces whatever's in the message box at send time. Right-click the stopwatch for the debug log.</div>
            `;
            document.body.appendChild(panel);

            textarea = panel.querySelector('#claude-sched-text');
            detectedEl = panel.querySelector('#claude-sched-detected');
            statusEl = panel.querySelector('#claude-sched-status');
            retryRow = panel.querySelector('#claude-sched-retry-row');
            retryIndexInput = panel.querySelector('#claude-sched-retry-index');
            retryStatusEl = panel.querySelector('#claude-sched-retry-status');
            modeSendBtn = panel.querySelector('#claude-sched-mode-send');
            modeRetryBtn = panel.querySelector('#claude-sched-mode-retry');

            modeSendBtn.addEventListener('click', () => setMode('send'));
            modeRetryBtn.addEventListener('click', () => setMode('retry'));
            retryIndexInput.addEventListener('input', updateRetryPreview);
            panel.querySelector('#claude-sched-load-history').addEventListener('click', async () => {
                retryStatusEl.textContent = 'Loading full conversation…';
                await loadAllRetryButtons();
                updateRetryPreview();
            });

            panel.querySelector('#claude-sched-close').addEventListener('click', () => { panel.style.display = 'none'; clearHighlight(); });
            panel.querySelector('#claude-sched-redetect').addEventListener('click', runDetection);
            panel.querySelector('#claude-sched-manual-apply').addEventListener('click', () => {
                const h = parseInt(panel.querySelector('#claude-sched-manual-h').value, 10) || 0;
                const m = parseInt(panel.querySelector('#claude-sched-manual-m').value, 10) || 0;
                detectedResetTime = new Date(Date.now() + (h * 60 + m) * 60000);
                detectedEl.textContent = detectedResetTime.toLocaleString() + ' (manual)';
                logSched('info', `Manual reset time set: ${detectedResetTime.toLocaleString()}`);
            });
            panel.querySelectorAll('.claude-sched-delay-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    selectedDelayMinutes = parseInt(btn.dataset.min, 10);
                    panel.querySelectorAll('.claude-sched-delay-btn').forEach(b => b.style.outline = 'none');
                    btn.style.outline = '2px solid #60a5fa';
                    panel.querySelector('#claude-sched-custom-delay').value = '';
                });
            });
            panel.querySelector('#claude-sched-schedule').addEventListener('click', onScheduleClick);
            panel.querySelector('#claude-sched-cancel').addEventListener('click', onCancelClick);

            logPanel = document.createElement('div');
            logPanel.id = 'claude-schedule-logpanel';
            logPanel.style.cssText = `
                position: fixed; z-index: 999999; width: 320px; max-height: 220px;
                background: #0b0f17; color: #d1d5db; border: 1px solid #374151; border-radius: 6px;
                box-shadow: 0 4px 18px rgba(0,0,0,0.5); display: none; flex-direction: column;
                font-family: system-ui, sans-serif;
            `;
            const logHeader = document.createElement('div');
            logHeader.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:5px 8px;background:#1f2937;border-bottom:1px solid #374151;font-size:11px;font-weight:600;border-radius:6px 6px 0 0;';
            logHeader.innerHTML = '<span>Schedule Log</span>';
            const closeLogBtn = document.createElement('button');
            closeLogBtn.textContent = '✕';
            closeLogBtn.style.cssText = 'background:none;border:none;color:#94a3b8;font-size:13px;cursor:pointer;';
            closeLogBtn.addEventListener('click', toggleLogPanel);
            logHeader.appendChild(closeLogBtn);
            logBody = document.createElement('div');
            logBody.style.cssText = 'overflow-y:auto; padding:6px 8px; font-family:monospace; font-size:10.5px; line-height:1.5; flex:1;';
            logPanel.appendChild(logHeader);
            logPanel.appendChild(logBody);
            document.body.appendChild(logPanel);

            reposition(ClaudeScheduleAnchor.getAnchor());
            ClaudeScheduleAnchor.onChange(reposition);
        }

        function init() {
            if (dot) return;
            createUI();
            setDotState('idle');
            currentTask = loadTask();
            // Tasks saved before the pie-progress feature won't have createdAt —
            // fall back to "just started now" so the pie has a sane baseline
            // instead of NaN/negative fractions.
            if (currentTask && !currentTask.createdAt) currentTask.createdAt = Date.now();
            if (currentTask) startTicking();
            logSched('info', 'Scheduler ready. Left-click the stopwatch to set up a scheduled send, right-click to toggle this log.');
        }

        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
        else init();
    })();

    /* ================= MODULE 4: UPLOAD PROGRESS OVERLAY ================= */
    // Puts real text on Claude's own gray "pending" attachment-card skeleton:
    // a percentage when Module -1's network intercept found a matching XHR
    // upload, otherwise an elapsed-time counter, otherwise a plain "Uploading…"
    // — always something, never blank, regardless of which fallback tier it's in.
    (function uploadOverlayModule() {
        const CARD_SELECTOR = '[data-cds="MessageAttachmentsFile"], [data-cds*="Attachment"]';
        const ULOG = '[Claude Upload]';
        function ulog(msg) { console.log(`%c${ULOG} ${msg}`, 'color:#a78bfa'); }
        const overlays = new WeakMap();

        function getFilename(card) {
            return card.getAttribute('title')
                || card.querySelector('[title]')?.getAttribute('title')
                || card.querySelector('.sr-only')?.textContent
                || null;
        }
        function formatElapsed(ms) {
            const s = Math.max(0, Math.floor(ms / 1000));
            return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
        }
        function ensureOverlay(card) {
            let overlay = overlays.get(card);
            if (overlay && card.contains(overlay)) return overlay;
            overlay = document.createElement('div');
            overlay.className = 'claude-upload-overlay';
            overlay.style.cssText = `
                position: absolute; inset: 0; z-index: 5;
                display: flex; align-items: center; justify-content: center;
                font-family: monospace; font-size: 11px; color: #e5e7eb; font-weight: 600;
                background: rgba(0,0,0,0.4); border-radius: inherit;
                pointer-events: none; text-align: center; padding: 4px;
            `;
            if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
            card.appendChild(overlay);
            overlays.set(card, overlay);
            ulog(`Overlay attached for "${getFilename(card) || 'unknown file'}"`);
            return overlay;
        }
        function removeOverlay(card) {
            const overlay = overlays.get(card);
            if (overlay && overlay.parentElement) overlay.remove();
            overlays.delete(card);
        }
        function updateCard(card) {
            const isPending = card.getAttribute('data-state') === 'pending' || card.getAttribute('aria-busy') === 'true';
            if (!isPending) { removeOverlay(card); return; }
            const overlay = ensureOverlay(card);
            const filename = getFilename(card);
            const entry = filename && window.__claudeUploads ? window.__claudeUploads.get(filename) : null;
            if (entry && entry.total > 0 && !entry.indeterminate) {
                overlay.textContent = `${Math.min(100, Math.round((entry.loaded / entry.total) * 100))}%`;
            } else if (entry) {
                overlay.textContent = `Uploading… ${formatElapsed(Date.now() - entry.startedAt)}`;
            } else {
                overlay.textContent = 'Uploading…';
            }
        }
        function purgeOldUploads() {
            if (!window.__claudeUploads) return;
            const now = Date.now();
            for (const [name, entry] of window.__claudeUploads.entries()) {
                if (entry.done && now - entry.startedAt > 60000) window.__claudeUploads.delete(name);
            }
        }
        function scan() {
            document.querySelectorAll(CARD_SELECTOR).forEach(updateCard);
            purgeOldUploads();
        }
        function init() {
            ulog('Upload progress overlay ready.');
            scan();
            setInterval(scan, 300);
            new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state', 'aria-busy'] });
        }
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
        else init();
    })();
})();

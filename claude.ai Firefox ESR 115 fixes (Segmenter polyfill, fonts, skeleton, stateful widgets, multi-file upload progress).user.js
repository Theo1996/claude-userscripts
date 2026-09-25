// ==UserScript==
// @name         claude.ai Firefox ESR 115 fixes (Segmenter polyfill, fonts, skeleton, stateful widgets, multi-file upload progress)
// @match        https://claude.ai/*
// @match        file:///*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function() {
  'use strict';

  /* === 0. Intl.Segmenter polyfill — must run before app code, hence document-start === */
  if (typeof window.Intl === 'undefined') window.Intl = {};
  if (typeof window.Intl.Segmenter === 'undefined') {
    console.warn('Injecting low-overhead Intl.Segmenter polyfill.');
    window.Intl.Segmenter = class Segmenter {
      constructor(locales, options) {
        this.locales = locales;
        this.options = options || { granularity: 'grapheme' };
      }
      segment(input) {
        const str = String(input);
        const granularity = this.options.granularity || 'grapheme';
        return {
          [Symbol.iterator]: function* () {
            if (granularity === 'word') {
              const regex = /\w+|[^\w\s]+|\s+/g;
              let match;
              while ((match = regex.exec(str)) !== null) {
                yield { segment: match[0], index: match.index, input: str, isWordLike: /\w/.test(match[0]) };
              }
            } else {
              let currentIndex = 0;
              for (const char of str) {
                yield { segment: char, index: currentIndex, input: str };
                currentIndex += char.length;
              }
            }
          },
          containing: function(idx) {
            if (idx < 0 || idx >= str.length) return undefined;
            if (granularity === 'word') {
              const regex = /\w+|[^\w\s]+|\s+/g;
              let match;
              while ((match = regex.exec(str)) !== null) {
                const start = match.index, end = start + match[0].length;
                if (idx >= start && idx < end) {
                  return { segment: match[0], index: start, input: str, isWordLike: /\w/.test(match[0]) };
                }
              }
            } else {
              let currentIndex = 0;
              for (const char of str) {
                const nextIndex = currentIndex + char.length;
                if (idx >= currentIndex && idx < nextIndex) {
                  return { segment: char, index: currentIndex, input: str };
                }
                currentIndex = nextIndex;
              }
            }
            return undefined;
          }
        };
      }
    };
  }

  /* === 4. fetch() has no upload-progress event; reroute file uploads through XHR,
            and render %, MB, speed, and a bar inside the CORRECT skeleton box —
            matched by upload-call-order <-> skeleton-appearance-order, race-safe
            for multiple simultaneous uploads. Declared at top level (before
            document-ready) since fetch must be patched before any upload fires. === */

  let uploadSlotCounter = 0;
  const skeletonQueue = [];
  const seenSkeletons = new WeakSet();
  const pendingSlotWaiters = [];

  function registerSkeleton(el) {
    if (seenSkeletons.has(el)) return;
    seenSkeletons.add(el);
    skeletonQueue.push(el);
    for (let i = pendingSlotWaiters.length - 1; i >= 0; i--) {
      const w = pendingSlotWaiters[i];
      if (skeletonQueue.length > w.slot) {
        pendingSlotWaiters.splice(i, 1);
        w.resolve(skeletonQueue[w.slot]);
      }
    }
  }

  function scanForSkeletons(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.matches && node.matches('[data-cds="Skeleton"]')) registerSkeleton(node);
    node.querySelectorAll?.('[data-cds="Skeleton"]').forEach(registerSkeleton);
  }

  function claimUploadSlot() {
    return uploadSlotCounter++;
  }

  function waitForSkeletonSlot(slot, timeoutMs = 6000) {
    if (skeletonQueue.length > slot) return Promise.resolve(skeletonQueue[slot]);
    return new Promise(resolve => {
      const waiter = {
        slot,
        resolve: (el) => { clearTimeout(timer); resolve(el); },
      };
      pendingSlotWaiters.push(waiter);
      const timer = setTimeout(() => {
        const idx = pendingSlotWaiters.indexOf(waiter);
        if (idx !== -1) pendingSlotWaiters.splice(idx, 1);
        resolve(null); // no matching box found in time — upload still proceeds, just no overlay
      }, timeoutMs);
    });
  }

  (function patchFetchForUploadProgress() {
    const originalFetch = window.fetch.bind(window);

    function hasFileOrBlob(formData) {
      for (const value of formData.values()) {
        if (value instanceof File || value instanceof Blob) return true;
      }
      return false;
    }

    function headersToObject(headersInit) {
      const out = {};
      if (!headersInit) return out;
      if (headersInit instanceof Headers) {
        for (const [k, v] of headersInit.entries()) out[k] = v;
      } else if (Array.isArray(headersInit)) {
        headersInit.forEach(([k, v]) => { out[k] = v; });
      } else {
        Object.assign(out, headersInit);
      }
      return out;
    }

    function parseResponseHeaders(raw) {
      const headers = new Headers();
      raw.trim().split(/\r?\n/).forEach(line => {
        const idx = line.indexOf(':');
        if (idx === -1) return;
        headers.append(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
      });
      return headers;
    }

    function createOverlay() {
      const el = document.createElement('div');
      el.className = 'fx-upload-overlay';
      el.innerHTML =
        '<div class="fx-upload-pct">0%</div>' +
        '<div class="fx-upload-mb">0.0 / 0.0 MB</div>' +
        '<div class="fx-upload-speed">-- MB/s</div>' +
        '<div class="fx-upload-track"><div class="fx-upload-fill"></div></div>';
      return el;
    }

    function renderProgress(overlay, loaded, total) {
      const pct = Math.min(100, Math.round((loaded / total) * 100));
      overlay.querySelector('.fx-upload-pct').textContent = pct + '%';
      overlay.querySelector('.fx-upload-mb').textContent =
        (loaded / 1048576).toFixed(1) + ' / ' + (total / 1048576).toFixed(1) + ' MB';
      overlay.querySelector('.fx-upload-fill').style.width = pct + '%';
    }

    window.fetch = function(input, init) {
      const body = init && init.body;
      if (!(body instanceof FormData) || !hasFileOrBlob(body)) {
        return originalFetch(input, init);
      }

      // Reserve this upload's position SYNCHRONOUSLY, in fetch()-call order —
      // this is what makes concurrent uploads race-safe.
      const mySlot = claimUploadSlot();

      const url = typeof input === 'string' ? input : input.url;
      const method = (init && init.method) || 'GET';

      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(method, url, true);

        const headers = headersToObject(init && init.headers);
        Object.keys(headers).forEach(name => {
          if (name.toLowerCase() === 'content-type') return; // let XHR set the multipart boundary itself
          try { xhr.setRequestHeader(name, headers[name]); } catch (e) {}
        });

        let overlay = null;
        let latestProgress = null; // {loaded, total} — buffered in case it arrives before the overlay does
        let lastLoaded = 0, lastTime = performance.now(), speedEMA = null;

        waitForSkeletonSlot(mySlot).then(skel => {
          if (!skel) return; // timed out — upload still works, just no visible overlay
          overlay = createOverlay();
          skel.appendChild(overlay);
          if (latestProgress) renderProgress(overlay, latestProgress.loaded, latestProgress.total);
        });

        xhr.upload.addEventListener('progress', (e) => {
          if (!e.lengthComputable) return;
          latestProgress = { loaded: e.loaded, total: e.total };

          const now = performance.now();
          const dt = (now - lastTime) / 1000;
          if (dt > 0.05) {
            const instSpeed = (e.loaded - lastLoaded) / dt;
            speedEMA = speedEMA === null ? instSpeed : speedEMA * 0.7 + instSpeed * 0.3;
            lastLoaded = e.loaded;
            lastTime = now;
          }

          if (overlay) {
            renderProgress(overlay, e.loaded, e.total);
            overlay.querySelector('.fx-upload-speed').textContent =
              (speedEMA !== null ? (speedEMA / 1048576).toFixed(1) : '--') + ' MB/s';
          }
        });

        xhr.addEventListener('load', () => {
          resolve(new Response(xhr.response, {
            status: xhr.status,
            statusText: xhr.statusText,
            headers: parseResponseHeaders(xhr.getAllResponseHeaders() || ''),
          }));
        });
        xhr.addEventListener('error', () => {
          if (overlay) overlay.querySelector('.fx-upload-pct').textContent = 'Failed';
          reject(new TypeError('Network request failed'));
        });
        xhr.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));

        if (init && init.signal) {
          if (init.signal.aborted) { xhr.abort(); return; }
          init.signal.addEventListener('abort', () => xhr.abort());
        }

        xhr.send(body);
      });
    };
  })();

  /* Everything below touches the DOM/stylesheets, so defer until it exists */
  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);

  function init() {
    /* === 1. Fix any variable font using the unsupported "woff2-variations" format keyword
              (this covers Anthropicons automatically — it matches on the broken format
              string, not on a hardcoded family name, so it also catches any other
              broken variable font, e.g. the checkbox's check-glyph icon font) === */
    const fixedUrls = new Set();
    function scanFonts() {
      [...document.styleSheets].forEach(ss => {
        let rules;
        try { rules = [...ss.cssRules]; } catch (e) { return; }
        rules.forEach(r => {
          if (r.constructor.name !== 'CSSFontFaceRule') return;
          if (!r.cssText.includes('woff2-variations')) return;
          const urlMatch = r.cssText.match(/url\("([^"]+)"\)/);
          const familyMatch = r.cssText.match(/font-family:\s*["']?([^;"']+)["']?/);
          if (!urlMatch || !familyMatch) return;
          const url = urlMatch[1];
          if (fixedUrls.has(url)) return;
          fixedUrls.add(url);
          const family = familyMatch[1].trim();
          const fix = document.createElement('style');
          fix.textContent = `@font-face { font-family: ${family}; src: url("${url}") format("woff2"); font-weight: 400 700; font-display: block; }`;
          document.head.appendChild(fix);
        });
      });
    }
    scanFonts();
    new MutationObserver(scanFonts).observe(document.head, { childList: true, subtree: true });

    /* === 2. Static CSS: skeleton shimmer, pointer-events net, checkbox color (UNVERIFIED —
              click-trace diagnostic never confirmed whether this layer is even the problem),
              state outline, and the upload progress overlay === */
    const css = `
      [data-cds="Skeleton"]::after { display: block !important; }

      [role="checkbox"], [role="radio"], [role="switch"], [role="tab"],
      [role="menuitem"], [role="option"] {
        pointer-events: auto !important;
      }
      [role="checkbox"], [role="radio"], [role="switch"], [role="tab"],
      button, [role="button"] {
        cursor: pointer !important;
      }

      span[data-cds="Checkbox"][aria-checked="true"] > span:first-child,
      span[data-cds="Checkbox"][data-checked] > span:first-child {
        background-color: var(--cds-fill-accent, #b45f34) !important;
        border-color: transparent !important;
      }
      span[data-cds="Checkbox"][aria-checked="true"] [data-cds="Icon"],
      span[data-cds="Checkbox"][data-checked] [data-cds="Icon"] {
        opacity: 1 !important;
      }

      .fx-active-state {
        outline: 2px solid var(--cds-fill-accent, #b45f34) !important;
        outline-offset: 1px !important;
      }

      .fx-upload-overlay {
        position: absolute; inset: 0; z-index: 10;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 2px; padding: 6px; box-sizing: border-box;
        background: rgba(0,0,0,0.45); color: #fff;
        font: 600 11px/1.3 sans-serif; text-align: center;
        border-radius: inherit; pointer-events: none;
      }
      .fx-upload-pct { font-size: 15px; }
      .fx-upload-track {
        width: 90%; height: 4px; margin-top: 3px;
        background: rgba(255,255,255,0.3); border-radius: 2px; overflow: hidden;
      }
      .fx-upload-fill {
        height: 100%; width: 0%;
        background: var(--cds-fill-accent, #ffffff);
        transition: width 0.12s linear;
      }

      [contenteditable="true"], [contenteditable="true"] * {
        -moz-user-select: text !important;
        user-select: text !important;
      }
    `;
    const styleEl = document.createElement('style');
    styleEl.textContent = css;
    document.head.appendChild(styleEl);

    /* === 3. Mirror aria/data "on" state onto a plain class for the CSS above === */
    const STATE_ATTRS = ['aria-checked','aria-selected','aria-pressed','aria-expanded','data-state','data-checked'];
    function truthy(v) { return v === 'true' || v === 'checked' || v === 'on' || v === 'open' || v === 'expanded' || v === 'selected'; }
    function markState(el) {
      if (!el.getAttribute) return;
      let active = false;
      STATE_ATTRS.forEach(a => {
        if (!el.hasAttribute(a)) return;
        if (a === 'data-checked') { active = true; return; }
        if (truthy(el.getAttribute(a))) active = true;
      });
      el.classList.toggle('fx-active-state', active);
    }
    document.querySelectorAll('[role],[data-cds],[data-state]').forEach(markState);
    new MutationObserver(muts => {
      muts.forEach(m => {
        if (m.type === 'attributes') markState(m.target);
        if (m.type === 'childList') {
          m.addedNodes.forEach(n => {
            if (n.nodeType !== 1) return;
            markState(n);
            n.querySelectorAll?.('[role],[data-cds],[data-state]').forEach(markState);
          });
        }
      });
    }).observe(document.body, {
      attributes: true, childList: true, subtree: true,
      attributeFilter: STATE_ATTRS
    });

    /* Feed skeleton boxes into section 4's upload-progress queue as they're added */
    scanForSkeletons(document.body);
    new MutationObserver(muts => muts.forEach(m => m.addedNodes.forEach(scanForSkeletons)))
      .observe(document.body, { childList: true, subtree: true });

    /* === 5. Checkbox click fallback — replicates Base UI's OWN toggle mechanism,
              read directly from its source (CheckboxRoot.tsx / dispatchClickWithModifiers.ts):
              clicking the visible span dispatches a constructed click on a paired hidden
              <input type="checkbox">, whose native activation is what actually flips state.
              This only intervenes if that real toggle did NOT happen — it snapshots
              input.checked on pointerdown, then on click (bubble-phase on document, so it
              runs AFTER React's own delegated handler if one fired) checks whether the
              input actually changed. If it did, this does nothing — no double-toggle risk
              on checkboxes that already work fine. If it didn't, it performs the exact
              same dispatch the framework would have. Scoped to data-cds="Checkbox" only,
              since that's the specific component this was verified against. */
    /* v2 — no longer replicates Base UI's own PointerEvent-construction (that's
       the same mechanism the site itself uses and may be the actual root cause
       of the breakage). Uses input.click() instead — guaranteed by spec to fully
       simulate a real click including native activation, in every browser.
       Capture phase so nothing downstream can stop this from seeing the click;
       deferred via setTimeout so React's own handling (if it runs at all) gets
       a full tick to finish before we check whether it actually worked. */
    document.addEventListener('click', (e) => {
      const cb = e.target.closest?.('[data-cds="Checkbox"][role="checkbox"]');
      if (!cb) return;
      if (cb.getAttribute('aria-disabled') === 'true' || cb.hasAttribute('data-disabled')) return;
      if (cb.getAttribute('aria-readonly') === 'true') return;

      const input = cb.parentElement?.querySelector('input[type="checkbox"]');
      if (!input) return;

      const before = input.checked;
      setTimeout(() => {
        if (input.checked === before) input.click();
      }, 0);
    }, true);
  }
})();
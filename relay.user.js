// ==UserScript==
// @name         IG Direct → Live Mirror Relay (read-only)
// @namespace    https://github.com/orin/soad-live-chat
// @version      2.0.0
// @description  Mirrors ONE Instagram Direct thread to Firebase Realtime Database for a public read-only page. Client-side DOM observation only — no login automation, no private APIs. Mobile (Firefox for Android) friendly.
// @author       Orin
// @downloadURL  https://raw.githubusercontent.com/repo-ghost/soad-live-chat/arena/9c327de7-soad-live-chat/relay.user.js
// @updateURL    https://raw.githubusercontent.com/repo-ghost/soad-live-chat/arena/9c327de7-soad-live-chat/relay.user.js
// @match        https://www.instagram.com/direct/*
// @match        https://instagram.com/direct/*
// @match        https://m.instagram.com/direct/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      firebaseio.com
// @connect      *.firebaseio.com
// @connect      firebasedatabase.app
// @connect      *.firebasedatabase.app
// @connect      cdninstagram.com
// @connect      *.cdninstagram.com
// @connect      fbcdn.net
// @connect      *.fbcdn.net
// @connect      instagram.com
// @connect      *.instagram.com
// ==/UserScript==

/* =====================================================================================
 *  HOW IT WORKS (and why it is ban-safe)
 *  ---------------------------------------------------------------------------------
 *  This script NEVER logs in, never stores cookies, never calls a private API.
 *  It is a passive observer: it reads the DOM that Instagram already rendered in a
 *  browser tab *you* are logged into, and relays what it sees to Firebase.
 *
 *  Only the thread whose ID matches TARGET_CHAT_ID is relayed. Open any other chat and
 *  the relay pauses instantly (no reads, no writes).
 *
 *  MOBILE NOTES (Firefox for Android + Tampermonkey)
 *  ---------------------------------------------------------------------------------
 *  • Firebase calls prefer GM_xmlhttpRequest, which bypasses Instagram's CSP/CORS
 *    entirely. If the extension blocks it we fall back to fetch() automatically.
 *  • Android freezes background tabs. Scans pause while the tab is hidden and run
 *    immediately when you return, then catch up from Firebase — no lost messages.
 *  • Works in "Desktop site" mode. Rows are found by several strategies, and if the
 *    markup differs the HUD's diagnostic panel tells you what was actually seen.
 * ===================================================================================== */

(function () {
  'use strict';

  /* ===================================================================================
   * 1. CONFIGURATION  — ✅ ALREADY FILLED IN FOR ORIN
   *    Firebase project : soad-live  (asia-southeast1)
   *    Target thread    : 18063962657394896
   *    You do not need to edit anything in this file.
   * =================================================================================== */

  const CONFIG = {
    // Firebase Realtime Database REST base for the *messages* node.
    // ⚠️ Copy it EXACTLY from the Firebase console (region names differ!).
    //    Asia / EU projects look like: https://<id>-default-rtdb.asia-southeast1.firebasedatabase.app
    //    US projects look like:        https://<id>-default-rtdb.firebaseio.com
    FIREBASE_DB_URL: 'https://soad-live-default-rtdb.asia-southeast1.firebasedatabase.app/messages',

    // The numeric thread id from https://www.instagram.com/direct/t/<THIS_NUMBER>/
    TARGET_CHAT_ID: '18063962657394896',

    // Polling / observation interval (ms). The MutationObserver also fires on DOM changes.
    SCAN_INTERVAL_MS: 1500,

    // Delay between sequential writes so message order is preserved (ms).
    POST_DELAY_MS: 80,

    // Media encoding.
    MAX_IMAGE_PX: 800,
    JPEG_QUALITY: 0.70,
    MAX_AUDIO_BYTES: 1400000, // ~1.4 MB raw ≈ 1.9 MB base64; skip bigger clips.

    // How many recent Firebase rows to compare against when catching up.
    HISTORY_LOOKBACK: 300,

    // If the DOM keeps lagging the database for this many scans, switch to "loose"
    // dedupe (push only messages whose signature is absent from recent history).
    BEHIND_RECOVERY_SCANS: 8,

    // Android: skip scans while the tab is in the background, then catch up on return.
    PAUSE_WHEN_HIDDEN: true,

    // ── Full-history backfill ────────────────────────────────────────────────
    // On an empty database the relay scrolls the conversation to the very first
    // message, collecting as it goes, then walks back down. Set to false if you
    // only ever want what is currently on screen.
    BACKFILL: true,
    SCROLL_STEP_RATIO: 0.85,     // how much of the viewport to scroll per step
    SCROLL_SETTLE_MS: 420,       // wait for lazy-loaded rows after each step
    SCROLL_TOP_GRACE: 5,         // extra passes at the top before believing we arrived
    MAX_BACKFILL_MS: 240000,     // hard stop (4 min) so it can never loop forever

    // Small status pill in the corner (tap it to open diagnostics).
    SHOW_HUD: true,

    // Extra logging in the browser console.
    VERBOSE: false,
  };

  /* ===================================================================================
   * 2. INTERNALS
   * =================================================================================== */

  const VERSION = '2.0.0';
  const DB = String(CONFIG.FIREBASE_DB_URL).replace(/\/+$/, '');
  const LOG = (...a) => console.log('%c[relay]', 'color:#A800FF;font-weight:700', ...a);
  const WARN = (...a) => console.warn('%c[relay]', 'color:#ff9f0a;font-weight:700', ...a);
  const VLOG = (...a) => { if (CONFIG.VERBOSE) LOG(...a); };

  const STATE = {
    ready: false,          // initial Firebase snapshot loaded
    paused: true,          // URL does not match target thread
    scanning: false,
    wrote: 0,
    tail: [],              // [{ key, sig }] ascending — what Firebase already knows
    reactions: new Map(),  // key -> reaction string | null
    mediaCache: new Map(), // src -> data URL
    lastHudText: '',
    behindScans: 0,        // consecutive scans where the DOM lags the database
    looseDedupe: false,    // sticky fallback: dedupe by signature instead of alignment
    backfilled: false,     // one-time full-history read has run
    // diagnostics
    transport: 'unknown',  // 'gm' | 'fetch'
    lastStatus: null,      // last HTTP status from Firebase
    lastError: '',
    lastRows: 0,
    lastScanAt: 0,
    bootAt: Date.now(),
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nowMs = () => Date.now();

  // ── hashing (stable, tiny) ────────────────────────────────────────────────────────
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  /* ===================================================================================
   * 3. HUD + DIAGNOSTICS PANEL
   *     On a phone there is no console, so everything important lives on screen.
   * =================================================================================== */

  let hudEl = null;
  let panelEl = null;

  function ensureHud() {
    if (!CONFIG.SHOW_HUD || hudEl) return;
    hudEl = document.createElement('div');
    hudEl.id = 'ig-relay-hud';
    hudEl.setAttribute(
      'style',
      [
        'position:fixed', 'right:12px', 'bottom:12px', 'z-index:2147483000',
        'font:600 11.5px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
        'padding:8px 12px', 'border-radius:999px', 'letter-spacing:.2px',
        'background:rgba(18,18,18,.94)', 'color:#fff',
        'border:1px solid rgba(255,255,255,.16)',
        'box-shadow:0 6px 22px rgba(0,0,0,.55)',
        'cursor:pointer', 'user-select:none', 'max-width:76vw',
        'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
        'touch-action:manipulation',
      ].join(';')
    );
    hudEl.title = 'Tap for diagnostics · long-press to hide';
    hudEl.addEventListener('click', () => togglePanel());
    document.documentElement.appendChild(hudEl);
  }

  function hud(text, tone) {
    if (!CONFIG.SHOW_HUD) return;
    ensureHud();
    if (!hudEl) return;
    if (text !== STATE.lastHudText) {
      STATE.lastHudText = text;
      hudEl.textContent = text;
    }
    hudEl.style.color =
      tone === 'warn' ? '#ffd60a' : tone === 'bad' ? '#ff6b6b' : tone === 'ok' ? '#4ade80' : '#fff';
    if (panelEl && panelEl.style.display !== 'none') renderPanel();
  }

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

  function maskedUrl() {
    // show host + whether /messages is attached, but not the whole thing
    try {
      const u = new URL(DB);
      return u.hostname + u.pathname.replace(/\/+$/, '');
    } catch (_) {
      return '(invalid URL)';
    }
  }

  function togglePanel() {
    if (!panelEl) buildPanel();
    panelEl.style.display = panelEl.style.display === 'none' ? 'block' : 'none';
    if (panelEl.style.display === 'block') renderPanel();
  }

  function buildPanel() {
    panelEl = document.createElement('div');
    panelEl.id = 'ig-relay-panel';
    panelEl.setAttribute(
      'style',
      [
        'position:fixed', 'right:10px', 'bottom:58px', 'z-index:2147483000',
        'width:min(340px, 92vw)', 'max-height:58vh', 'overflow:auto',
        'background:rgba(12,12,12,.98)', 'color:#eee',
        'border:1px solid rgba(255,255,255,.16)', 'border-radius:14px',
        'padding:12px 13px',
        'font:500 11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
        'box-shadow:0 14px 40px rgba(0,0,0,.7)', 'white-space:pre-wrap',
        'word-break:break-word', 'display:none', '-webkit-user-select:text', 'user-select:text',
      ].join(';')
    );
    document.documentElement.appendChild(panelEl);
  }

  /** The screen that actually tells you WHY it failed on a phone. */
  function renderPanel() {
    if (!panelEl) return;
    const id = chatIdFromUrl();
    const gm = !!GMXHR;
    const rows = safeRowCount();
    const diag = classify();
    const lines = [
      `IG Relay v${VERSION}`,
      ``,
      `thread in URL : ${id || '(none — not a /direct/t/ page)'}`,
      `target thread : ${String(CONFIG.TARGET_CHAT_ID)}`,
      `match         : ${id === String(CONFIG.TARGET_CHAT_ID) ? 'YES' : 'NO'}`,
      `state         : ${STATE.paused ? 'PAUSED' : STATE.ready ? 'LIVE' : 'starting'}`,
      ``,
      `database      : ${maskedUrl()}`,
      `transport     : ${STATE.transport === 'gm' ? 'GM_xmlhttpRequest ✓' : STATE.transport === 'fetch' ? (gm ? 'fetch (GM failed — blocked?)' : 'fetch (no GM grant)') : 'not used yet'}`,
      `GM available  : ${gm ? 'yes' : 'NO — check @grant lines'}`,
      `last HTTP     : ${STATE.lastStatus == null ? '—' : STATE.lastStatus}`,
      `rows found    : ${rows}`,
      `relayed       : ${STATE.wrote}`,
      `known in DB   : ${STATE.tail.length}`,
      `last scan     : ${STATE.lastScanAt ? Math.round((nowMs() - STATE.lastScanAt) / 1000) + 's ago' : '—'}`,
    ];

    if (STATE.lastError) lines.push('', `last error    : ${STATE.lastError}`);
    if (diag) lines.push('', `⚠️ ${diag.title}`, diag.hint);

    panelEl.innerHTML =
      lines
        .map((l) => {
          if (/^IG Relay/.test(l)) return `<b style="color:#c084fc">${esc(l)}</b>`;
          if (/^⚠️/.test(l)) return `<b style="color:#ffb4a2">${esc(l)}</b>`;
          if (/^(database|transport|last HTTP|last error)/.test(l)) return `<span style="color:#9ad">${esc(l)}</span>`;
          if (/^(thread in URL|match|state|rows found)/.test(l)) return `<span style="color:#dfe">${esc(l)}</span>`;
          return esc(l);
        })
        .join('\n') +
      `<div style="margin-top:10px;padding-top:9px;border-top:1px solid #2a2a2a;color:#888;font-family:system-ui">
         Tap the pill to close · long-press the pill to hide entirely
       </div>`;
  }

  function safeRowCount() {
    try { return getBubbles().bubbles.length; } catch (_) { return -1; }
  }

  /** Turns a raw failure into an actionable explanation. */
  function classify() {
    const raw = STATE.lastError || '';
    const status = STATE.lastStatus;
    const dbHost = (() => { try { return new URL(DB).hostname; } catch (_) { return ''; } })();

    if (!/^https?:\/\//i.test(DB)) {
      return { title: 'FIREBASE_DB_URL is not a full URL', hint: 'It must start with https:// and be copied exactly from the Firebase console.' };
    }
    if (/YOUR-PROJECT-ID/.test(DB) || !/firebaseio\.com|firebasedatabase\.app/.test(DB)) {
      return { title: 'FIREBASE_DB_URL still has the placeholder', hint: 'Replace YOUR-PROJECT-ID with your real project id, keep /messages on the end.' };
    }
    if (/YOUR_THREAD_ID/.test(String(CONFIG.TARGET_CHAT_ID))) {
      return { title: 'TARGET_CHAT_ID still has the placeholder', hint: 'Copy the digits from instagram.com/direct/t/<DIGITS>/ in the address bar.' };
    }
    if (!dbHost) {
      return { title: 'database URL cannot be parsed', hint: 'Check for a typo, a stray space, or a missing https://' };
    }
    if (status === 401 || status === 403) {
      return {
        title: `Firebase denied the request (${status})`,
        hint:
          'Your Realtime Database rules block reads. Open Firebase → Realtime Database → Rules and set:\n' +
          '{ "rules": { "messages": { ".read": true, ".write": true } } }\nThen tap Publish and reload Instagram.',
      };
    }
    if (status === 404) {
      return {
        title: 'Firebase returned 404 — wrong database URL',
        hint:
          `It asked for: ${dbHost}\n` +
          'Region matters. An asia-southeast1 project is on *.firebasedatabase.app, not *.firebaseio.com. ' +
          'Copy the URL straight from the console header.',
      };
    }
    if (status === 400) {
      return { title: 'Firebase rejected the request (400)', hint: 'Usually a malformed URL (double slashes) or a bad query.' };
    }
    if (/network|timeout|abort|NS_ERROR|Load failed|Failed to fetch|NetworkError/i.test(raw)) {
      return {
        title: 'No connection to Firebase',
        hint:
          'Firefox/Tampermonkey blocked the request or you are offline.\n' +
          '• Make sure the script header still lists @connect for firebaseio.com / firebasedatabase.app\n' +
          '• On Firefox Android: Settings → Data collection → turn OFF "Block trackers" for instagram.com\n' +
          '• Check the phone is online, then reload the Instagram tab.',
      };
    }
    if (/CORS|TypeError: NetworkError/i.test(raw)) {
      return {
        title: 'Blocked as a cross-site request (CORS)',
        hint: 'GM_xmlhttpRequest was unavailable, so fetch() was used and blocked. Re-install the script so its @grant lines apply.',
      };
    }
    if (raw) return { title: 'Firebase request failed', hint: raw };
    return null;
  }

  /* ===================================================================================
   * 4. HTTP LAYER (GM_xmlhttpRequest first — bypasses Instagram CSP and Firebase CORS)
   * =================================================================================== */

  // Tampermonkey on Firefox exposes the modern GM.xmlHttpRequest; older builds use
  // GM_xmlhttpRequest. Support both so the phone never silently falls back to fetch().
  const GMXHR =
    (typeof GM_xmlhttpRequest === 'function' && GM_xmlhttpRequest) ||
    (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function'
      ? GM.xmlHttpRequest.bind(GM)
      : null);

  const hasGM = !!GMXHR;

  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      let handle;
      const settle = (fn, v) => { try { fn(v); } catch (_) {} };
      try {
        handle = GMXHR(
          Object.assign({}, opts, {
            onload: (r) => settle(resolve, r),
            onerror: (e) => settle(reject, new Error('network error' + (e && e.error ? ': ' + e.error : ''))),
            ontimeout: () => settle(reject, new Error('timeout')),
            onabort: () => settle(reject, new Error('abort')),
            onreadystatechange: (r) => {
              // some Firefox builds report progress through this path only
              if (r && r.readyState === 4 && r.status >= 200 && r.status < 300 && !r.responseText && opts.responseType === 'arraybuffer') {
                settle(resolve, r);
              }
            },
          })
        );
      } catch (e) {
        settle(reject, e);
      }
      // GM.xmlHttpRequest returns a promise-like with .abort(); keep a safety net
      if (handle && typeof handle.then === 'function') {
        handle.then(() => {}, () => {});
      }
    });
  }

  async function fbRequest(method, path, body) {
    const url = DB + path;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json' };

    // ── 1. extension transport (preferred: immune to CORS and page CSP) ──────────
    if (hasGM) {
      try {
        const r = await gmRequest({ method, url, headers, data: payload, timeout: 25000 });
        STATE.transport = 'gm';
        STATE.lastStatus = r.status;
        if (r.status >= 200 && r.status < 300) {
          STATE.lastError = '';
          return r.responseText ? JSON.parse(r.responseText) : null;
        }
        const snippet = String(r.responseText || '').slice(0, 200);
        STATE.lastError = 'FB ' + r.status + ' ' + snippet;
        const err = new Error(STATE.lastError);
        err.status = r.status;
        err.final = r.status === 401 || r.status === 403 || r.status === 404;  // no point retrying
        throw err;
      } catch (e) {
        if (e && e.final) throw e;
        // transport-level failure → try the page transport before giving up
        VLOG('GM transport failed, trying fetch:', e.message);
        if (!e.status) STATE.lastError = e.message;
      }
    }

    // ── 2. page transport fallback ───────────────────────────────────────────────
    try {
      STATE.transport = 'fetch';
      const res = await fetch(url, { method, headers, body: payload, cache: 'no-store' });
      STATE.lastStatus = res.status;
      if (!res.ok) {
        const txt = (await res.text()).slice(0, 200);
        STATE.lastError = 'FB ' + res.status + ' ' + txt;
        const err = new Error(STATE.lastError);
        err.status = res.status;
        throw err;
      }
      STATE.lastError = '';
      const txt = await res.text();
      return txt ? JSON.parse(txt) : null;
    } catch (e) {
      if (!e.status) STATE.lastError = e.message;
      throw e;
    }
  }

  async function getBytes(url) {
    if (!url) return null;
    // blob: URLs are same-origin and readable straight from the page.
    if (url.startsWith('blob:')) {
      const r = await fetch(url);
      if (!r.ok) throw new Error('blob ' + r.status);
      const blob = await r.blob();
      return { buf: await blob.arrayBuffer(), mime: blob.type };
    }
    if (hasGM) {
      try {
        const r = await gmRequest({ method: 'GET', url, responseType: 'arraybuffer', timeout: 25000 });
        if (r.status >= 200 && r.status < 300 && r.response) {
          return { buf: r.response, mime: r.responseHeaders?.match(/content-type:\s*([^\r\n;]+)/i)?.[1] || 'image/jpeg' };
        }
      } catch (_) { /* fall through */ }
    }
    const r = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
    if (!r.ok) throw new Error('GET ' + r.status);
    const blob = await r.blob();
    return { buf: await blob.arrayBuffer(), mime: blob.type };
  }

  function abToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function loadImageFromUrl(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('decode failed'));
      img.src = url;
    });
  }

  /** Downscale to <= maxPx and re-encode as JPEG (Instagram CDN URLs expire → must inline). */
  async function toCompressedDataUrl(buf, mime, maxPx, quality) {
    const blob = new Blob([buf], { type: mime || 'image/jpeg' });
    const objUrl = URL.createObjectURL(blob);
    try {
      const img = await loadImageFromUrl(objUrl);
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      const scale = Math.min(1, maxPx / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      return canvas.toDataURL('image/jpeg', quality);
    } catch (e) {
      // Undecodable (rare) — inline the raw bytes so the image is still preserved.
      return 'data:' + (mime || 'image/jpeg') + ';base64,' + abToBase64(buf);
    } finally {
      URL.revokeObjectURL(objUrl);
    }
  }

  async function mediaDataUrl(url, { maxPx = CONFIG.MAX_IMAGE_PX, quality = CONFIG.JPEG_QUALITY } = {}) {
    if (!url) return null;
    if (STATE.mediaCache.has(url)) return STATE.mediaCache.get(url);
    let out = null;
    try {
      const res = await getBytes(url);
      if (res && res.buf && res.buf.byteLength) {
        if ((res.mime || '').startsWith('image/')) {
          out = await toCompressedDataUrl(res.buf, res.mime, maxPx, quality);
        } else {
          out = 'data:' + (res.mime || 'audio/mp4') + ';base64,' + abToBase64(res.buf);
        }
      }
    } catch (e) {
      WARN('media failed', e.message);
    }
    if (STATE.mediaCache.size > 260) STATE.mediaCache.clear();
    STATE.mediaCache.set(url, out);
    return out;
  }

  /* ===================================================================================
   * 5. DOM HELPERS
   * =================================================================================== */

  function chatIdFromUrl() {
    const m = location.pathname.match(/\/direct\/t\/([\w.:-]+)/);
    return m ? m[1] : null;
  }

  /**
   * ─────────────────────────────────────────────────────────────────────────────
   * MESSAGE DISCOVERY
   * ─────────────────────────────────────────────────────────────────────────────
   * Instagram's class names and roles change constantly, so we avoid relying on
   * them. The one thing every Direct layout has is the composer ("Message…").
   * Everything ABOVE it in the same scroll container is the conversation, and the
   * conversation list sits beside it. That anchor is what makes this reliable.
   */

  /** The message composer box (input / contenteditable). */
  function findComposer() {
    const sel = [
      '[contenteditable="true"][role="textbox"]',
      'div[role="textbox"][contenteditable="true"]',
      'textarea[placeholder]',
      'input[placeholder]',
      '[aria-label*="Message" i][contenteditable="true"]',
      '[contenteditable="true"]',
    ].join(',');
    const nodes = Array.from(document.querySelectorAll(sel));
    for (const n of nodes) {
      if (n.closest('[role="dialog"]')) continue;
      const r = n.getBoundingClientRect();
      if (r.width < 40 || r.height < 12) continue;
      // the composer is in the lower half of the screen
      if (r.top < window.innerHeight * 0.35) continue;
      return n;
    }
    return null;
  }

  /**
   * The scrollable element that holds the conversation.
   * Walks up from the composer to the nearest ancestor that scrolls.
   */
  function findThreadScroller() {
    const composer = findComposer();
    const composerTop = composer ? composer.getBoundingClientRect().top : window.innerHeight;

    // Candidate must ACTUALLY scroll: overflow auto/scroll AND overflow content.
    const scrollable = (el) => {
      if (!el || !el.getBoundingClientRect) return false;
      try {
        const st = getComputedStyle(el);
        if (!/(auto|scroll)/.test(st.overflowY)) return false;
        return el.scrollHeight > el.clientHeight + 12;
      } catch (_) { return false; }
    };

    if (composer) {
      // Case A: the scroller is an ancestor of the composer.
      let el = composer.parentElement;
      for (let i = 0; i < 14 && el && el !== document.body; i++, el = el.parentElement) {
        if (scrollable(el)) return el;
      }

      // Case B: the scroller is a SIBLING above the composer (most Instagram
      // layouts put the composer outside the message list). Pick the scrollable
      // element whose box ends near the composer and that holds message text.
      let node = composer.parentElement;
      for (let depth = 0; depth < 6 && node && node !== document.body; depth++, node = node.parentElement) {
        const cands = Array.from(node.querySelectorAll('div, section, ul, main'))
          .filter((el) => el !== node && !el.contains(composer) && scrollable(el))
          .filter((el) => {
            const r = el.getBoundingClientRect();
            if (r.height < 120) return false;
            // ends at/above the composer
            if (r.bottom > composerTop + 8) return false;
            // must look like a message area
            return el.querySelectorAll('[dir="auto"], img, audio, video').length >= 2;
          });
        if (cands.length) {
          // prefer the one with the most scrollable overflow (the real list)
          cands.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
          return cands[0];
        }
      }

      // Case C: not scrollable at all (short thread) — use the composer's biggest
      // sibling container so row resolution stays stable.
      let box = composer.parentElement;
      for (let i = 0; i < 6 && box && box.parentElement && box !== document.body; i++) {
        const r = box.getBoundingClientRect();
        if (r.height > 200) break;
        box = box.parentElement;
      }
      if (box) return box;
    }

    // Last resort: the biggest scrollable region on the page that holds text.
    let best = null;
    let bestScore = 0;
    document.querySelectorAll('div, section, main, ul').forEach((el) => {
      if (!scrollable(el)) return;
      if (!el.querySelector('[dir="auto"]')) return;
      const score = el.scrollHeight - el.clientHeight;
      if (score > bestScore && el.clientHeight > 150) { bestScore = score; best = el; }
    });
    return best;
  }

  /** Is this node inside the conversation list / sidebar rather than the chat? */
  function inInbox(el, scroller) {
    if (!el) return false;
    if (scroller && scroller.contains(el)) return false;       // inside the chat → fine
    if (el.querySelector('a[href*="/direct/t/"]')) return true; // links to another thread
    if (el.closest('nav, [aria-label*="Conversation" i], [aria-label*="Chats" i], [aria-label*="Inbox" i]')) return true;
    return false;
  }

  /** Instagram renders every message twice; the copy is hidden and must be skipped. */
  function isHiddenRow(row) {
    if (row.getAttribute('aria-hidden') === 'true') return true;
    let el = row;
    for (let i = 0; i < 4 && el && el !== document.body; i++, el = el.parentElement) {
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none' || parseFloat(st.opacity) === 0) return true;
      const r = el.getBoundingClientRect();
      if (r.height < 8 || r.width < 8) return true;
    }
    return false;
  }

  const REACTION_ONLY = /^(?:\p{Extended_Pictographic}|\uFE0F|\u200D|\s)+$/u;

  /** Does this element hold a message body? (Avoids reacting to its buttons.) */
  function hasMessageContent(el) {
    if (el.querySelector('[dir="auto"], img, video, audio')) return true;
    if (el.querySelector('a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"], a[href*="/tv/"]')) return true;
    // attachment / document cards have text but often no [dir="auto"]
    if (/\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|txt|csv|apk)\b/i.test(el.innerText || '')) return true;
    return false;
  }

  const MAX_BUBBLE_HEIGHT = 520;

  /**
   * Walk UP from a content element to the outermost ancestor that is still a
   * single message (does not contain other message bodies and does not span the
   * whole conversation). Returns the element to treat as one message.
   */
  function climbToBubble(start, stopAt) {
    let node = start;
    let best = start;
    for (let i = 0; i < 12; i++) {
      const parent = node.parentElement;
      if (!parent || parent === stopAt || parent === document.body) break;
      // stop if the parent starts holding a second message
      if (parent.querySelectorAll('[dir="auto"]').length > 1) break;
      if (parent.querySelectorAll('img').length > 1 && !parent.querySelector('a[href*="/reel/"], a[href*="/p/"]')) break;
      const r = parent.getBoundingClientRect();
      if (r.height > MAX_BUBBLE_HEIGHT) break;                 // too big → a container
      if (r.width > 0) best = parent;
      // a real bubble has visible padding/background; once we have size, keep climbing
      node = parent;
    }
    return best;
  }

  /** All message bubbles in the open conversation, top → bottom. */
  function getBubbles() {
    const scroller = findThreadScroller();
    const root = scroller || document.querySelector('main') || document.body;
    const composer = findComposer();

    // candidate content nodes inside the conversation
    const seeds = Array.from(root.querySelectorAll(
      '[dir="auto"], img, video, audio, [aria-label*="document" i], [aria-label*="file" i], [aria-label*="attachment" i]'
    ))
      .filter((n) => {
        if (composer && (composer.contains(n) || n.contains(composer))) return false;
        if (n.closest('[role="dialog"]')) return false;
        if (inInbox(n, scroller)) return false;
        if (n.closest('a[href*="/direct/t/"]')) return false;
        // ignore header text, buttons and labels
        if (n.closest('button, [role="button"], header, [aria-label*="Message" i][role="textbox"]')) return false;
        const r = n.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return false;
        return true;
      });

    // climb each seed to a whole-bubble element, then de-duplicate
    let bubbles = seeds.map((n) => climbToBubble(n, root));

    // collapse nested/duplicate bubbles, keep the outermost
    bubbles = bubbles.filter((b, i, arr) => !arr.some((o) => o !== b && o.contains(b)));

    // drop hidden measure nodes and reaction-only pills
    bubbles = bubbles.filter((b) => {
      if (isHiddenRow(b)) return false;
      if (!hasMessageContent(b)) return false;
      const txt = (b.innerText || '').trim();
      if (txt && REACTION_ONLY.test(txt) && !b.querySelector('img, audio, video')) return false;
      const r = b.getBoundingClientRect();
      if (r.height < 8) return false;
      return true;
    });

    // sort by vertical position → true chronological order on screen
    bubbles.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return ra.top - rb.top || ra.left - rb.left;
    });

    // remove exact visual duplicates (same text, same top, same kind)
    const seen = new Set();
    const out = [];
    for (const b of bubbles) {
      const r = b.getBoundingClientRect();
      const key = Math.round(r.top) + '|' + Math.round(r.left) + '|' + (b.innerText || '').trim().slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(b);
    }
    return { bubbles: out, scroller };
  }

  const isLikelyAvatar = (img) => {
    const r = img.getBoundingClientRect();
    const w = Math.max(r.width, img.naturalWidth || 0);
    return w > 0 && w < 70;
  };

  /** "Me" = row rendered right-to-left (row-reverse wrapper), with a geometry fallback. */
  function isMine(row) {
    let el = row;
    for (let i = 0; i < 9 && el && el !== document.body; i++, el = el.parentElement) {
      const inline = el.getAttribute && el.getAttribute('style');
      if (inline && /flex-direction\s*:\s*row-reverse/i.test(inline)) return true;
      try {
        if (getComputedStyle(el).flexDirection === 'row-reverse') return true;
      } catch (_) { /* ignore */ }
    }
    // geometry fallback: is the bubble sitting on the right half of the row?
    const marker = row.querySelector('[dir="auto"]') || row.querySelector('img') || row;
    const mr = marker.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    if (!rr.width || !mr.width) return false;
    return (mr.left + mr.width / 2 - rr.left) / rr.width > 0.55;
  }

  const REACTION_STRIP = /\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*/gu;

  /** Reaction pill: tiny emoji-only element floating on the bubble corner. */
  function findReaction(row, excludeEls) {
    for (const el of row.querySelectorAll('[aria-label]')) {
      const label = el.getAttribute('aria-label') || '';
      if (!/react/i.test(label)) continue;
      const txt = (el.innerText || el.textContent || '').trim();
      const emoji = txt.match(REACTION_STRIP);
      if (emoji && emoji.length) return emoji.join('');
      const byLabel = label.match(REACTION_STRIP);
      if (byLabel && byLabel.length) return byLabel.join('');
    }
    for (const el of row.querySelectorAll('span, div')) {
      if (el.children.length > 1) continue;
      if (el.closest('[dir="auto"]')) continue;
      const txt = (el.textContent || '').trim();
      if (!txt || txt.length > 12) continue;
      const emoji = txt.match(REACTION_STRIP);
      if (!emoji) continue;
      const leftovers = txt.replace(REACTION_STRIP, '').replace(/[\s0-9+]/g, '');
      if (leftovers.length) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.width <= 60 && r.height <= 40) return emoji.slice(0, 3).join('');
    }
    return null;
  }

  function extractText(row, reactionEl) {
    const parts = [];
    const nodes = row.querySelectorAll('[dir="auto"]');
    if (nodes.length) {
      nodes.forEach((n) => {
        if (reactionEl && (n === reactionEl || reactionEl.contains(n) || n.contains(reactionEl))) return;
        const t = (n.innerText || '').trim();
        if (t) parts.push(t);
      });
    }
    if (!parts.length) {
      const clone = row.cloneNode(true);
      clone.querySelectorAll('svg, script, style, audio, video, img').forEach((n) => n.remove());
      const t = (clone.innerText || '').trim();
      if (t) parts.push(t);
    }
    const out = [];
    parts.forEach((p) => {
      if (NOISE_ALT.test(p)) return;                       // alt text, not a message
      if (/^\d+[smhd]$/.test(p)) return;                   // "55m" timestamp
      if (/^\d{1,2}:\d{2}(\s?[AP]M)?$/i.test(p)) return;    // "8:04 PM"
      if (out[out.length - 1] !== p) out.push(p);
    });
    return out.join('\n').trim();
  }

  // Instagram labels photos with alt="Shared photo" / "Photo shared by …" — that is
  // not user text, so it must never become a caption.
  const NOISE_ALT = /^(shared photo|photo shared by|video shared by|image|photo|gif|sticker)/i;

  const IG_CONTENT_RE = /instagram\.com\/(reel|reels|p|tv)\//i;

  function extractReels(row) {
    const links = new Map();
    row.querySelectorAll('a[href]').forEach((a) => {
      const href = a.href || '';
      if (!IG_CONTENT_RE.test(href)) return;
      const img = a.querySelector('img');
      links.set(href.split('?')[0], img ? img.src : null);
    });
    if (!links.size) {
      const t = row.innerText || '';
      const m = t.match(/https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p|tv)\/[^\s]+/i);
      if (m) links.set(m[0].split('?')[0], null);
    }
    return Array.from(links.entries()).map(([url, thumb]) => ({ url, thumb }));
  }

  /** Cheap, re-render-stable identity for an image (CDN query strings rotate, path doesn't). */
  function imageFingerprint(src) {
    try {
      const u = new URL(src);
      const file = u.pathname.split('/').filter(Boolean).pop() || u.pathname;
      return file.replace(/\.(jpg|jpeg|png|webp|heic)$/i, '');
    } catch (_) {
      return hash(String(src)).slice(0, 8);
    }
  }

  /** Rows that are pure chrome (timestamps, "Sent an attachment") are not messages. */
  function isJunkItem(item) {
    if (item.kind !== 'text') return false;
    const t = (item.text || '').trim();
    if (!t) return true;
    if (/^\d{1,2}:\d{2}(\s?[AP]M)?$/i.test(t)) return true;      // clock only
    if (/^(today|yesterday|mon|tue|wed|thu|fri|sat|sun)/i.test(t) && t.length < 12) return true;
    if (/sent an attachment\.?$/i.test(t) && t.length < 40) return true;
    return false;
  }

  /**
   * Attachment / document cards (PDF, docs, zips). These are easy to miss because
   * Instagram renders them as a small card, sometimes without any [dir="auto"].
   */
  function extractAttachment(row) {
    const txt = (row.innerText || row.textContent || '').trim();
    const sizeRe = /\b\d+(\.\d+)?\s?(B|KB|MB|GB)\b/i;
    const extRe = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|txt|csv|apk|mp3|mp4|mov|heic|jpg|png)\b/i;

    const size = (txt.match(sizeRe) || [''])[0];
    const hasExt = extRe.test(txt);

    // a "file card" look: a small document icon / attachment container
    const cardLike = !!row.querySelector(
      '[aria-label*="document" i], [aria-label*="file" i], [aria-label*="attachment" i]'
    );

    if (!hasExt && !(cardLike && size)) return null;

    const lines = txt.split('\n').map((t) => t.trim()).filter(Boolean);
    let name = lines.find((l) => extRe.test(l));
    if (!name) name = lines[0] || (cardLike ? 'Attachment' : '');
    if (!name) return null;
    return { name: name.slice(0, 120), size };
  }

  /** Reaction emoji attached to a bubble. */
  function findReaction(row) {
    // 1) labelled react buttons
    for (const el of row.querySelectorAll('[aria-label]')) {
      const label = el.getAttribute('aria-label') || '';
      if (!/react/i.test(label)) continue;
      const txt = (el.innerText || el.textContent || '').trim();
      const emoji = txt.match(REACTION_STRIP);
      if (emoji && emoji.length) return emoji.join('');
      const byLabel = label.match(REACTION_STRIP);
      if (byLabel && byLabel.length) return byLabel.join('');
    }
    // 2) an emoji-only element that is NOT the message text
    const textNodes = new Set(Array.from(row.querySelectorAll('[dir="auto"]')));
    for (const el of row.querySelectorAll('span, div')) {
      if (el.children.length > 1) continue;
      const txt = (el.textContent || '').trim();
      if (!txt || txt.length > 14) continue;
      const emoji = txt.match(REACTION_STRIP);
      if (!emoji) continue;
      // only pure emoji, optionally with a count like "2"
      if (!REACTION_ONLY.test(txt.replace(/[\d+]/g, ''))) continue;
      // it must not be the bubble's own text
      let isText = false;
      for (const tn of textNodes) { if (tn === el || tn.contains(el)) { isText = true; break; } }
      if (isText) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.width <= 64 && r.height <= 44) return emoji.slice(0, 3).join('');
    }
    return null;
  }

  function extractTextFrom(row) {
    const parts = [];
    Array.from(row.querySelectorAll('[dir="auto"]')).forEach((n) => {
      const t = (n.innerText || '').trim();
      if (!t) return;
      if (NOISE_ALT.test(t)) return;
      if (/^\d{1,2}:\d{2}(\s?[AP]M)?$/i.test(t)) return;
      if (/^\d+[smhd]$/.test(t)) return;
      if (/^replied to you$/i.test(t)) return;
      if (parts[parts.length - 1] !== t) parts.push(t);
    });
    return parts.join('\n').trim();
  }

  function extractReelsFrom(row) {
    const links = new Map();
    row.querySelectorAll('a[href]').forEach((a) => {
      const href = a.href || '';
      if (!IG_CONTENT_RE.test(href)) return;
      const img = a.querySelector('img');
      links.set(href.split('?')[0], img ? img.src : null);
    });
    if (!links.size) {
      const t = row.innerText || '';
      const m = t.match(/https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p|tv)\/[^\s]+/i);
      if (m) links.set(m[0].split('?')[0], null);
    }
    return Array.from(links.entries()).map(([url, thumb]) => ({ url, thumb }));
  }

  const isLikelyAvatarImg = (img) => {
    const r = img.getBoundingClientRect();
    const w = Math.max(r.width, img.naturalWidth || 0);
    return w > 0 && w < 72;
  };

  /** Extract one bubble into a normalised message record. */
  function extractRow(row) {
    const side = isMine(row) ? 'me' : 'friend';
    const reaction = findReaction(row);
    const text = extractTextFrom(row);

    const imgs = Array.from(row.querySelectorAll('img')).filter(
      (img) => img.src && !isLikelyAvatarImg(img) &&
        !img.closest('a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"], a[href*="/tv/"]')
    );
    const reels = extractReelsFrom(row);
    const audio = row.querySelector('audio');
    const audioSrc = audio ? (audio.currentSrc || audio.src || null) : null;
    const video = row.querySelector('video');
    const file = extractAttachment(row);

    let kind = 'text';
    if (audioSrc) kind = 'voice';
    else if (video && !reels.length) kind = 'video';
    else if (reels.length) kind = 'reel';
    else if (imgs.length) kind = 'photo';
    else if (file) kind = 'file';

    // A caption is real text that is NOT the file name / placeholder alt text.
    let caption = text;
    if (kind === 'file' && file && text.includes(file.name)) caption = '';
    if (NOISE_ALT.test(text || '')) caption = '';

    const imgSrc = kind === 'photo' ? imgs[0].src : null;
    const reelThumbSrc = kind === 'reel' ? (reels[0].thumb || imgs[0]?.src || null) : null;

    const sig = hash([
      side,
      kind,
      caption || '',
      imgSrc ? 'img:' + imageFingerprint(imgSrc) : '',
      audioSrc ? 'aud' : '',
      reels.length ? 'reel:' + reels[0].url : '',
      file ? 'file:' + file.name + ':' + (file.size || '') : '',
      imgs.length > 1 ? '+' + imgs.length : '',
    ].join('|'));

    return {
      row, side, kind, text: caption || '', sig, reaction,
      imgSrc, audioSrc, videoSrc: video ? (video.currentSrc || video.src || null) : null,
      reel: reels[0] ? reels[0].url : null,
      reelThumbSrc,
      file,
    };
  }

  /* ===================================================================================
   * 6. SEQUENCE ALIGNMENT (catch-up without duplicates)
   * =================================================================================== */

  function ranksOf(sigs) {
    const seen = new Map();
    return sigs.map((sig) => {
      const r = seen.get(sig) || 0;
      seen.set(sig, r + 1);
      return r;
    });
  }

  function align(domSigs, tail) {
    const n = domSigs.length;
    const m = tail.length;

    if (!m) return { start: 0, k: 0, behind: false };
    if (!n) return { start: 0, k: 0, behind: false };

    const maxK = Math.min(n, m, 60);
    const domRank = ranksOf(domSigs);
    const tailRank = ranksOf(tail.map((x) => x.sig));
    for (let k = maxK; k >= 1; k--) {
      for (let i = n - k; i >= 0; i--) {
        let ok = true;
        for (let j = 0; j < k; j++) {
          const t = m - k + j;
          if (domSigs[i + j] !== tail[t].sig) { ok = false; break; }
          if (domRank[i + j] !== tailRank[t]) { ok = false; break; }
        }
        if (ok) return { start: i, k, behind: false };
      }
    }

    const lastSig = tail[m - 1].sig;
    for (let i = n - 1; i >= 0; i--) {
      if (domSigs[i] === lastSig) return { start: i, k: 1, behind: false };
    }

    return { start: 0, k: 0, behind: true };
  }

  /* ===================================================================================
   * 7. FIREBASE SYNC
   * =================================================================================== */

  async function loadTail() {
    const q = '?orderBy=' + encodeURIComponent('"$key"') + '&limitToLast=' + CONFIG.HISTORY_LOOKBACK;
    const data = await fbRequest('GET', '.json' + q);
    const entries = data && typeof data === 'object' ? Object.entries(data) : [];
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    STATE.tail = entries.map(([key, v]) => ({ key, sig: (v && v.sig) || '' }));
    STATE.reactions.clear();
    entries.forEach(([key, v]) => STATE.reactions.set(key, v && v.reactions ? v.reactions : null));
    LOG('firebase tail loaded:', STATE.tail.length);
  }

  function buildPayload(item, media) {
    const payload = {
      side: item.side,
      kind: item.kind,
      text: item.text || '',
      ts: nowMs(),
      sig: item.sig,
      author: item.side === 'me' ? 'Orin' : 'MD.Soad',
    };
    if (item.caption) payload.caption = item.caption;

    if (item.kind === 'photo') {
      if (media.img) payload.img = media.img;
      if (!media.img && item.imgSrc) payload.imgUrl = item.imgSrc;
      if (item.text) payload.caption = item.text;
    }
    if (item.kind === 'voice') {
      if (media.audio) payload.audio = media.audio;
      else if (item.audioSrc && !item.audioSrc.startsWith('blob:')) payload.audioUrl = item.audioSrc;
    }
    if (item.kind === 'video') {
      if (!item.videoSrc || !item.videoSrc.startsWith('blob:')) payload.videoUrl = item.videoSrc || null;
      if (media.videoThumb) payload.videoThumb = media.videoThumb;
      if (item.text) payload.caption = item.text;
    }
    if (item.kind === 'reel') {
      payload.reel = item.reel;
      // the poster is small, so always try to inline it — even if the full
      // thumbnail fetch failed we keep the CDN URL as a second chance
      if (media.thumb) payload.reelThumb = media.thumb;
      else if (item.reelThumbSrc) payload.reelThumbUrl = item.reelThumbSrc;
      if (item.text) payload.caption = item.text;
    }
    if (item.kind === 'file' && item.file) {
      payload.fileName = item.file.name;
      if (item.file.size) payload.fileSize = item.file.size;
    }
    if (item.reaction) payload.reactions = item.reaction;

    Object.keys(payload).forEach((k) => {
      if (payload[k] === null || payload[k] === undefined || payload[k] === '') delete payload[k];
    });
    return payload;
  }

  async function prepareMedia(item) {
    const media = { img: null, audio: null, thumb: null, videoThumb: null };
    const safe = async (fn, label) => {
      try { return await fn(); } catch (e) { WARN(label + ' failed', e.message); return null; }
    };

    if (item.kind === 'photo' && item.imgSrc) {
      media.img = await safe(() => mediaDataUrl(item.imgSrc), 'photo');
    }
    if (item.kind === 'reel' && item.reelThumbSrc) {
      media.thumb = await safe(() => mediaDataUrl(item.reelThumbSrc, { maxPx: 480, quality: 0.62 }), 'reel thumb');
    }
    if (item.kind === 'video' && item.videoSrc) {
      const v = await safe(() => makeVideoThumb(item.videoSrc), 'video thumb');
      media.videoThumb = v;
    }
    if (item.kind === 'voice' && item.audioSrc) {
      const raw = await safe(() => getBytes(item.audioSrc), 'voice');
      if (raw && raw.buf && raw.buf.byteLength) {
        if (raw.buf.byteLength <= CONFIG.MAX_AUDIO_BYTES) {
          media.audio = 'data:' + (raw.mime || 'audio/mp4') + ';base64,' + abToBase64(raw.buf);
        } else {
          WARN('voice note too large, keeping URL only');
        }
      }
    }
    return media;
  }

  /** Grab one frame from a video element and compress it. */
  async function makeVideoThumb(src) {
    if (!src || src.startsWith('blob:')) {
      // a blob video is already on the page; use its poster frame via the element
      const v = document.querySelector('video');
      if (!v) return null;
      const c = document.createElement('canvas');
      const w = v.videoWidth || v.clientWidth;
      const h = v.videoHeight || v.clientHeight;
      if (!w || !h) return null;
      c.width = Math.min(480, w);
      c.height = Math.round((c.width / w) * h);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.6);
    }
    const bytes = await getBytes(src);
    if (!bytes || !bytes.buf) return null;
    return toCompressedDataUrl(bytes.buf, bytes.mime, 480, 0.6);
  }

  async function pushItem(item) {
    const media = await prepareMedia(item);
    const payload = buildPayload(item, media);
    const res = await fbRequest('POST', '.json', payload);
    const key = res && res.name;
    if (!key) throw new Error('no key returned');
    STATE.tail.push({ key, sig: item.sig });
    if (STATE.tail.length > CONFIG.HISTORY_LOOKBACK * 2) STATE.tail.splice(0, STATE.tail.length - CONFIG.HISTORY_LOOKBACK);
    if (item.reaction) STATE.reactions.set(key, item.reaction);
    STATE.wrote++;
    return key;
  }

  async function patchReactions(key, value) {
    await fbRequest('PATCH', '/' + key + '.json', { reactions: value || null });
  }

  /* ===================================================================================
   * 7b. FULL-HISTORY BACKFILL
   *     Instagram only renders a window of messages. To capture the WHOLE chat we
   *     drive the conversation scroller up to the first message, collecting every
   *     row on the way, then return to the bottom. Everything is then pushed in
   *     true chat order.
   * =================================================================================== */

  const sleepScroll = (ms) => new Promise((r) => setTimeout(r, ms));

  // Backfill trace — readable from the page via window.__relayTrace
  const TRACE = [];
  function trace(...a) {
    const line = a.join(' ');
    TRACE.push(line);
    if (TRACE.length > 200) TRACE.shift();
    VLOG('trace:', line);
  }
  try { window.__relayTrace = TRACE; } catch (_) {}

  function scrollerBounds(el) {
    return { top: el.scrollTop, max: Math.max(0, el.scrollHeight - el.clientHeight) };
  }

  /**
   * Harvest the bubbles currently on screen.
   *
   * Returns only the rows we have not seen before, in top→bottom DOM order.
   * Because we always scroll UP, anything newly revealed sits above everything
   * collected so far — so the caller can prepend it and keep true chat order.
   */
  function harvestNew(seen, scroller) {
    const { bubbles } = getBubbles();
    const base = scroller ? scroller.getBoundingClientRect().top : 0;
    const fresh = [];
    for (const b of bubbles) {
      let item;
      try { item = extractRow(b); } catch (_) { continue; }
      if (isJunkItem(item)) continue;
      if (!item.text && item.kind === 'text') continue;

      // STABLE identity: content signature + the row's position *within the scroll
      // content* (not the viewport — which moves every step and caused duplicates).
      const rect = b.getBoundingClientRect();
      const contentY = Math.round(rect.top - base + (scroller ? scroller.scrollTop : 0));
      const key = item.sig + '@' + contentY;
      if (seen.has(key)) continue;
      seen.add(key);
      item.contentY = contentY;
      fresh.push(item);
    }

    // Learn how many legitimately-identical messages exist ("ok" sent twice) by
    // counting copies within a single render pass, and keep the maximum seen.
    const passCount = new Map();
    for (const item of fresh) passCount.set(item.sig, (passCount.get(item.sig) || 0) + 1);
    for (const [sig, n] of passCount) {
      if (n > (seen.maxPerSig?.get(sig) || 0)) {
        if (!seen.maxPerSig) seen.maxPerSig = new Map();
        seen.maxPerSig.set(sig, n);
      }
    }
    return fresh;
  }

  /** Nudge the scroller so Instagram's "load older messages" hook fires. */
  async function nudgeForMore(scroller) {
    const prev = scroller.scrollTop;
    scroller.scrollTop = Math.min(60, Math.max(20, scroller.clientHeight * 0.05));
    await sleepScroll(120);
    scroller.scrollTop = 0;
    await sleepScroll(CONFIG.SCROLL_SETTLE_MS + 120);
    if (prev > 0 && scroller.scrollTop === 0 && prev !== 0) { /* fine */ }
  }

  /** Everything currently rendered, in top→bottom order (no scrolling needed). */
  function harvestRendered() {
    let { bubbles } = getBubbles();        // already sorted top → bottom
    if (!bubbles.length) bubbles = discoverByStructure();
    const out = [];
    for (const b of bubbles) {
      let item;
      try { item = extractRow(b); } catch (_) { continue; }
      if (isJunkItem(item)) continue;
      if (!item.text && item.kind === 'text') continue;
      out.push(item);
    }
    return dedupeSequential(out);
  }

  /**
   * Absolute last resort — used when no composer and no recognisable container
   * exist (unusual Instagram builds). Groups message text nodes by their nearest
   * message-sized ancestor and sorts them top→bottom.
   */
  function discoverByStructure() {
    const nodes = Array.from(document.querySelectorAll('[dir="auto"]')).filter((n) => {
      if (!(n.innerText || '').trim()) return false;
      if (n.closest('[role="dialog"]')) return false;
      if (n.querySelector('a[href*="/direct/t/"]')) return false;
      if (n.closest('a[href*="/direct/t/"]')) return false;
      const r = n.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    });

    const groups = [];
    const seen = new Set();
    for (const n of nodes) {
      let g = n;
      for (let i = 0; i < 5; i++) {
        const p = g.parentElement;
        if (!p || p === document.body) break;
        if (p.querySelectorAll('[dir="auto"]').length > 1) break;
        const r = p.getBoundingClientRect();
        if (r.height > MAX_BUBBLE_HEIGHT) break;
        g = p;
      }
      if (seen.has(g)) continue;
      seen.add(g);
      if (!hasMessageContent(g)) continue;
      groups.push(g);
    }

    groups.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return groups;
  }

  async function backfillAll(onProgress) {
    const started = nowMs();
    const scroller = findThreadScroller();
    if (!scroller) {
      WARN('backfill: no scroller found — reading visible messages');
      return harvestRendered();
    }

    // self-check: the computed scroller may be a non-scrolling wrapper; if so,
    // hunt again for any genuinely scrollable container that holds messages
    let useScroller = scroller;
    if (useScroller.scrollHeight <= useScroller.clientHeight + 12) {
      const composer = findComposer();
      let found = null;
      document.querySelectorAll('div, section, main, ul').forEach((el) => {
        try {
          const st = getComputedStyle(el);
          if (!/(auto|scroll)/.test(st.overflowY)) return;
          if (el.scrollHeight <= el.clientHeight + 12) return;
          if (!el.querySelector('[dir="auto"]')) return;
          if (composer && el.contains(composer)) return;
          if (!found || (el.scrollHeight - el.clientHeight) > (found.scrollHeight - found.clientHeight)) found = el;
        } catch (_) {}
      });
      if (found) {
        WARN('backfill: wrapper does not scroll — using the real list container');
        useScroller = found;
      } else {
        // short conversation: nothing to scroll, just read what is rendered
        WARN('backfill: conversation does not scroll — reading visible messages');
        return harvestRendered();
      }
    }

    const seen = new Set();
    const maxPerSig = new Map();  // how many identical messages legitimately exist
    let collected = [];          // ascending chat order, built by prepending
    const origTop = useScroller.scrollTop;

    // start at the newest message
    useScroller.scrollTop = useScroller.scrollHeight;
    await sleepScroll(CONFIG.SCROLL_SETTLE_MS);
    collected = harvestNew(seen, useScroller);          // bottom block (newest)

    trace('scroller', useScroller.className || useScroller.id || 'div',
          'h=' + useScroller.scrollHeight, 'ch=' + useScroller.clientHeight,
          'top=' + Math.round(useScroller.scrollTop));
    let idleAtTop = 0;
    let lastHeight = useScroller.scrollHeight;
    let steps = 0;

    while (nowMs() - started < CONFIG.MAX_BACKFILL_MS) {
      if (document.hidden) { WARN('backfill paused: tab hidden'); break; }

      const before = useScroller.scrollTop;
      const step = Math.max(140, Math.floor(useScroller.clientHeight * CONFIG.SCROLL_STEP_RATIO));

      // move up; clamp to 0 so we always reach the very top
      useScroller.scrollTop = Math.max(0, before - step);
      await sleepScroll(CONFIG.SCROLL_SETTLE_MS);
      steps++;

      let fresh = harvestNew(seen, useScroller);
      if (fresh.length) collected = fresh.concat(collected);   // ← true chronological order
      trace('up step', steps, 'top=' + Math.round(useScroller.scrollTop),
            'h=' + useScroller.scrollHeight, 'fresh=' + fresh.length, 'total=' + collected.length);

      const atTop = useScroller.scrollTop <= 2;
      const grew = useScroller.scrollHeight !== lastHeight;
      lastHeight = useScroller.scrollHeight;

      if (onProgress) onProgress(collected.length, steps, useScroller.scrollTop);

      trace('   atTop=' + atTop, 'grew=' + grew, 'idle=' + idleAtTop);
      if (atTop) {
        if (fresh.length || grew) { idleAtTop = 0; continue; }
        idleAtTop++;
        if (idleAtTop > CONFIG.SCROLL_TOP_GRACE) break;
        // nothing new: actively poke the "load older" hook, then look again
        await nudgeForMore(useScroller);
        const more = harvestNew(seen, useScroller);
        if (more.length) {
          collected = more.concat(collected);
          idleAtTop = 0;
          lastHeight = useScroller.scrollHeight;
        }
      } else if (before === useScroller.scrollTop && !grew && !fresh.length) {
        idleAtTop++;
        if (idleAtTop > CONFIG.SCROLL_TOP_GRACE) break;
        await nudgeForMore(useScroller);
      } else {
        idleAtTop = 0;
      }
    }

    // ── Phase 2: canonical order pass ────────────────────────────────────────
    // Everything is loaded now. Scroll to the very top, then step DOWN, appending
    // each newly-seen bubble in DOM order. This yields guaranteed chat order
    // without relying on coordinates recorded during the upward pass.
    useScroller.scrollTop = 0;
    await sleepScroll(CONFIG.SCROLL_SETTLE_MS + 150);

    const ordered = [];
    const seenElements = new WeakSet();   // DOM identity — each bubble counted once
    let guard = 0;

    // harvest the top window first
    const takePass = () => {
      const { bubbles } = getBubbles();          // already sorted top→bottom
      let added = 0;
      for (const b of bubbles) {
        if (seenElements.has(b)) continue;       // same DOM node → already recorded
        let item;
        try { item = extractRow(b); } catch (_) { continue; }
        if (isJunkItem(item)) continue;
        if (!item.text && item.kind === 'text') continue;
        seenElements.add(b);
        item.offsetKey = Math.round(b.getBoundingClientRect().top - useScroller.getBoundingClientRect().top);
        ordered.push(item);
        added++;
      }
      return added;
    };

    takePass();

    while (guard++ < 600) {
      const max = useScroller.scrollHeight - useScroller.clientHeight;
      if (useScroller.scrollTop >= max - 2) { takePass(); break; }
      const step = Math.max(140, Math.floor(useScroller.clientHeight * 0.7));
      useScroller.scrollTop = Math.min(max, useScroller.scrollTop + step);
      await sleepScroll(Math.max(160, CONFIG.SCROLL_SETTLE_MS - 140));
      takePass();
    }

    useScroller.scrollTop = origTop > 0 ? origTop : useScroller.scrollHeight;

    // collapse exact repeats while preserving order (a message genuinely sent
    // twice appears twice in `ordered`, which is correct)
    const finalList = dedupeSequential(ordered);
    LOG('backfill canonical order:', finalList.length, 'messages (scan steps', steps + ')');
    trace('canonical=' + finalList.length + ' harvested=' + ordered.length);
    return finalList;
  }

  /**
   * Collapse the canonical pass result.
   *
   * The pass walks strictly top→bottom and only adds bubbles it has not seen at
   * that exact scroll offset, so genuine repeats ("ok" sent twice) stay separate.
   * All this needs to do is drop runs that were re-harvested without movement.
   */
  function dedupeSequential(list) {
    const out = [];
    let prevId = null;
    for (const item of list) {
      const id = item.sig + '@' + (item.offsetKey ?? '');
      if (id === prevId) continue;
      prevId = id;
      out.push(item);
    }
    return out;
  }

  /**
   * Collapse the collected list into true chat order.
   *
   * `collected` holds every sighting during the scroll; the same bubble is often
   * seen on several steps. We keep at most `maxPerSig` copies of each signature
   * (so a message genuinely sent twice survives), ordered by its top-most
   * recorded position.
   */
  function dedupeOrdered(list, maxPerSig) {
    const bySig = new Map();
    for (const item of list) {
      const arr = bySig.get(item.sig) || [];
      arr.push(item);
      bySig.set(item.sig, arr);
    }

    const out = [];
    for (const [sig, arr] of bySig) {
      arr.sort((a, b) => (a.contentY ?? 0) - (b.contentY ?? 0));
      const limit = Math.max(1, (maxPerSig && maxPerSig.get(sig)) || 1);
      // take the top-most `limit` sightings, keeping their relative order
      out.push(...arr.slice(0, limit));
    }

    out.sort((a, b) => (a.contentY ?? 0) - (b.contentY ?? 0));
    return out;
  }

  /* ===================================================================================
   * 8. MAIN SCAN LOOP
   * =================================================================================== */

  async function scan() {
    if (!STATE.ready || STATE.scanning) return;
    if (CONFIG.PAUSE_WHEN_HIDDEN && document.hidden) return;   // Android froze us

    const id = chatIdFromUrl();
    if (!id || id !== String(CONFIG.TARGET_CHAT_ID)) {
      if (!STATE.paused) { STATE.paused = true; LOG('paused — not the target thread'); }
      hud('⏸ Relay paused · open the target chat', 'warn');
      return;
    }

    STATE.scanning = true;
    STATE.paused = false;
    STATE.lastScanAt = nowMs();

    try {
      // ── full-history backfill, once, when the database is empty ──────────────
      if (CONFIG.BACKFILL && !STATE.backfilled && STATE.tail.length === 0) {
        STATE.backfilled = true;
        return await runBackfill();
      }

      const { bubbles } = getBubbles();
      STATE.lastRows = bubbles.length;
      if (!bubbles.length) {
        hud('⏳ Waiting for messages to render…', 'warn');
        return;
      }

      const items = bubbles.map(extractRow).filter((i) => !isJunkItem(i));
      if (!items.length) {
        hud('⏳ Waiting for messages to render…', 'warn');
        return;
      }
      await syncItems(items);

    } catch (e) {
      WARN('scan error', e);
      STATE.lastError = e.message;
      hud('⚠️ Relay error · tap for details', 'bad');
      if (!panelEl) buildPanel();
      panelEl.style.display = 'block';
      renderPanel();
    } finally {
      STATE.scanning = false;
    }
  }

  /** Scroll the whole conversation once, then push everything in chat order. */
  async function runBackfill() {
    if (document.hidden) { STATE.backfilled = false; return; }
    hud('📜 Reading full history from the top…');
    let all = null;
    try {
      all = await backfillAll((collected, onScreen, step) => {
        hud('📜 Collecting history… ' + collected + ' messages (step ' + step + ')');
      });
    } catch (e) {
      WARN('backfill failed', e);
    }
    if (!all || !all.length) {
      STATE.backfilled = false;
      hud('⚠️ Could not read history · tap', 'bad');
      return;
    }

    STATE.tail = [];
    STATE.reactions.clear();
    STATE.looseDedupe = false;

    hud('⬆️ Saving ' + all.length + ' messages in order…');
    let n = 0;
    for (const item of all) {
      try {
        await pushItem(item);
        n++;
        if (n % 5 === 0) hud('⬆️ Saving history… ' + n + '/' + all.length);
      } catch (e) {
        WARN('history push failed', e.message);
        STATE.lastError = e.message;
        await sleep(500);
      }
      await sleep(CONFIG.POST_DELAY_MS);
    }
    hud('🔴 Live · ' + STATE.wrote + ' relayed', 'ok');
    LOG('backfill complete:', n, 'messages');
  }

  /**
   * Diff the rendered conversation against what is already stored and push only
   * the new messages, in order.
   */
  async function syncItems(items) {
    const domSigs = items.map((i) => i.sig);

    const looseSlice = () => {
      const tailSet = new Set(STATE.tail.map((t) => t.sig));
      let anchor = -1;
      for (let i = items.length - 1; i >= 0; i--) {
        if (tailSet.has(domSigs[i])) { anchor = i; break; }
      }
      return { start: anchor + 1, k: 0 };
    };

    let start;
    let k;

    if (STATE.looseDedupe) {
      ({ start, k } = looseSlice());
    } else {
      const res = align(domSigs, STATE.tail);
      start = res.start;
      k = res.k;
      if (res.behind) {
        STATE.behindScans++;
        if (STATE.behindScans < CONFIG.BEHIND_RECOVERY_SCANS) {
          hud('⏳ Waiting for the thread to catch up…', 'warn');
          return;
        }
        WARN('DOM is behind the database — switching to signature dedupe');
        STATE.looseDedupe = true;
        ({ start, k } = looseSlice());
      }
    }
    STATE.behindScans = 0;

    const keyByIndex = new Map();
    for (let j = 0; j < k; j++) {
      keyByIndex.set(start + j, STATE.tail[STATE.tail.length - k + j].key);
    }
    const fresh = [];
    for (let i = start + k; i < items.length; i++) fresh.push(items[i]);

    if (fresh.length) {
      hud('⬆️ Syncing ' + fresh.length + ' new message' + (fresh.length > 1 ? 's' : '') + '…');
      for (const item of fresh) {
        try {
          await pushItem(item);
        } catch (e) {
          WARN('push failed', e.message);
          STATE.lastError = e.message;
          await sleep(400);
        }
        await sleep(CONFIG.POST_DELAY_MS);
      }
    }

    // reactions: patch only what changed
    for (const [idx, key] of keyByIndex.entries()) {
      const item = items[idx];
      const next = item.reaction || null;
      const prev = STATE.reactions.has(key) ? STATE.reactions.get(key) : null;
      if ((next || null) === (prev || null)) continue;
      try {
        await patchReactions(key, next);
        STATE.reactions.set(key, next);
        LOG('reaction updated', key, prev, '→', next);
      } catch (e) {
        WARN('reaction patch failed', e.message);
      }
      await sleep(30);
    }

    hud('🔴 Live · ' + STATE.wrote + ' relayed', 'ok');
  }

  /* ===================================================================================
   * 9. BOOT
   * =================================================================================== */

  let bootAttempts = 0;

  function configProblems() {
    const problems = [];
    if (/YOUR-PROJECT-ID/.test(DB)) problems.push('FIREBASE_DB_URL still says YOUR-PROJECT-ID');
    else if (!/^https?:\/\//i.test(DB)) problems.push('FIREBASE_DB_URL must start with https://');
    else if (!/firebaseio\.com|firebasedatabase\.app/.test(DB)) problems.push('FIREBASE_DB_URL is not a Firebase host');
    if (/YOUR_THREAD_ID/.test(String(CONFIG.TARGET_CHAT_ID))) problems.push('TARGET_CHAT_ID still says YOUR_THREAD_ID');
    return problems;
  }

  function boot() {
    ensureHud();
    bootAttempts++;

    const problems = configProblems();
    if (problems.length) {
      WARN('config problems:', problems.join(' · '));
      hud('⚠️ Setup needed · tap for details', 'bad');
      if (!panelEl) buildPanel();
      panelEl.style.display = 'block';
      renderPanel();
      return;
    }

    hud('🔄 Connecting to Firebase… (attempt ' + bootAttempts + ')');

    loadTail()
      .then(() => {
        STATE.ready = true;
        STATE.lastError = '';
        LOG('ready for thread', CONFIG.TARGET_CHAT_ID, '· transport:', STATE.transport);
        hud('🔴 Live · 0 relayed', 'ok');
        scan();
      })
      .catch((e) => {
        WARN('could not load Firebase:', e.message);
        STATE.lastError = e.message;
        const diag = classify();
        // Show the *reason* on screen — essential on a phone with no console.
        hud('⚠️ ' + (diag ? diag.title : 'Firebase unreachable') + ' · tap', 'bad');
        if (!panelEl) buildPanel();
        panelEl.style.display = 'block';
        renderPanel();
        // retry with a gentle backoff, but never push until we know what exists
        const wait = Math.min(60000, 5000 * bootAttempts);
        setTimeout(boot, wait);
      });

    // ── schedulers ───────────────────────────────────────────────────────────────
    setInterval(scan, CONFIG.SCAN_INTERVAL_MS);

    let t = null;
    const obs = new MutationObserver(() => {
      if (t) return;
      t = setTimeout(() => { t = null; if (STATE.ready) scan(); }, 450);
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });

    // Instagram is an SPA — re-evaluate pause state on navigation.
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        setTimeout(scan, 800);
      }
    }, 600);

    // Android: catch up the moment the tab comes back to the foreground.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && STATE.ready) {
        VLOG('tab visible again — catching up');
        scan();
      }
    });
    window.addEventListener('focus', () => { if (STATE.ready) scan(); });
    window.addEventListener('online', () => { if (STATE.ready) scan(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();

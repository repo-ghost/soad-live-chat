// ==UserScript==
// @name         IG Direct → Live Mirror Relay (read-only)
// @namespace    https://github.com/orin/soad-live-chat
// @version      1.2.0
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

    // Small status pill in the corner (tap it to open diagnostics).
    SHOW_HUD: true,

    // Extra logging in the browser console.
    VERBOSE: false,
  };

  /* ===================================================================================
   * 2. INTERNALS
   * =================================================================================== */

  const VERSION = '1.2.0';
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
    try { return getRows().length; } catch (_) { return -1; }
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

  function pickThreadRoot() {
    let best = null;
    let bestCount = 0;
    document.querySelectorAll('div[role="grid"]').forEach((g) => {
      if (g.closest('[role="dialog"]')) return;
      const n = g.querySelectorAll('div[role="row"]').length;
      if (n > bestCount) { bestCount = n; best = g; }
    });
    if (best) return best;
    // Desktop-site mode on some builds uses a listbox instead of a grid
    document.querySelectorAll('[role="listbox"]').forEach((g) => {
      if (g.closest('[role="dialog"]')) return;
      const n = g.querySelectorAll('[role="row"],[role="listitem"]').length;
      if (n > bestCount) { bestCount = n; best = g; }
    });
    if (best) return best;
    const main = document.querySelector('main') || document.body;
    return main;
  }

  function looksLikeMessageRow(row) {
    if (row.closest('[role="dialog"]')) return false;
    const rect = row.getBoundingClientRect();
    if (rect.width < 60 || rect.height < 4) return false;
    if (row.querySelector('[dir="auto"]')) return true;
    if (row.querySelector('audio, video')) return true;
    if (row.querySelector('img')) return true;
    return !!row.querySelector('a[href*="/reel/"], a[href*="/p/"], a[href*="/tv/"]');
  }

  function getRows() {
    const root = pickThreadRoot();
    if (!root) return [];

    let rows = Array.from(root.querySelectorAll('div[role="row"]')).filter(looksLikeMessageRow);
    if (!rows.length) {
      rows = Array.from(root.querySelectorAll('[role="listitem"]')).filter(looksLikeMessageRow);
    }

    // ── structural fallback ──────────────────────────────────────────────────────
    // If Instagram's wrappers change (or desktop-mode differs), group the message
    // text nodes by their nearest meaningful ancestor and treat those as rows.
    if (!rows.length) {
      const texts = Array.from(root.querySelectorAll('[dir="auto"]')).filter(
        (n) => (n.innerText || '').trim() && !n.closest('[role="dialog"]')
      );
      const seen = new Set();
      texts.forEach((n) => {
        const group = n.parentElement?.parentElement || n.parentElement;
        if (!group || seen.has(group)) return;
        seen.add(group);
        if (looksLikeMessageRow(group)) rows.push(group);
      });
    }
    return rows;
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
    parts.forEach((p) => { if (out[out.length - 1] !== p) out.push(p); });
    return out.join('\n').trim();
  }

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

  function extractRow(row) {
    const side = isMine(row) ? 'me' : 'friend';
    const reaction = findReaction(row);
    const text = extractText(row);

    const mediaImgs = Array.from(row.querySelectorAll('img')).filter(
      (img) => img.src && !isLikelyAvatar(img) && !img.closest('a[href*="/reel/"], a[href*="/p/"], a[href*="/tv/"]')
    );

    const reels = extractReels(row);
    const audio = row.querySelector('audio');
    const audioSrc = audio ? audio.currentSrc || audio.src || null : null;

    let kind = 'text';
    if (audioSrc) kind = 'voice';
    else if (reels.length) kind = 'reel';
    else if (mediaImgs.length) kind = 'photo';

    const hasBoth = text && (reels.length || mediaImgs.length);
    const imgSrc = kind === 'photo' ? mediaImgs[0].src : null;
    const reelThumbSrc = kind === 'reel' ? (reels[0].thumb || mediaImgs[0]?.src || null) : null;

    const sig = hash(
      [
        side,
        kind,
        hasBoth ? 'caption' : '',
        text || '',
        imgSrc ? 'img:' + imageFingerprint(imgSrc) : '',
        audioSrc ? 'aud' : '',
        reels.length ? 'reel:' + reels[0].url : '',
        mediaImgs.length > 1 ? '+' + (mediaImgs.length - 1) : '',
      ].join('|')
    );

    return {
      row, side, kind, text, sig, reaction,
      imgSrc, audioSrc,
      reel: reels[0] ? reels[0].url : null,
      reelThumbSrc,
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
    if (item.kind === 'photo') {
      if (media.img) payload.img = media.img;
      if (!media.img && item.imgSrc) payload.imgUrl = item.imgSrc;
      if (item.text) payload.caption = item.text;
    }
    if (item.kind === 'voice') {
      if (media.audio) payload.audio = media.audio;
      else if (item.audioSrc && !item.audioSrc.startsWith('blob:')) payload.audioUrl = item.audioSrc;
      payload.duration = media.duration || null;
    }
    if (item.kind === 'reel') {
      payload.reel = item.reel;
      if (media.thumb) payload.reelThumb = media.thumb;
      else if (item.reelThumbSrc) payload.reelThumbUrl = item.reelThumbSrc;
      if (item.text) payload.caption = item.text;
    }
    if (item.reaction) payload.reactions = item.reaction;
    Object.keys(payload).forEach((k) => {
      if (payload[k] === null || payload[k] === undefined) delete payload[k];
    });
    return payload;
  }

  async function prepareMedia(item) {
    const media = { img: null, audio: null, thumb: null, duration: null };
    if (item.kind === 'photo' && item.imgSrc) {
      media.img = await mediaDataUrl(item.imgSrc);
    }
    if (item.kind === 'reel' && item.reelThumbSrc) {
      media.thumb = await mediaDataUrl(item.reelThumbSrc, { maxPx: 480, quality: 0.6 });
    }
    if (item.kind === 'voice' && item.audioSrc) {
      try {
        const res = await getBytes(item.audioSrc);
        if (res && res.buf && res.buf.byteLength && res.buf.byteLength <= CONFIG.MAX_AUDIO_BYTES) {
          media.audio = 'data:' + (res.mime || 'audio/mp4') + ';base64,' + abToBase64(res.buf);
        } else if (res && res.buf) {
          WARN('voice note too large, sending URL only');
        }
      } catch (e) {
        WARN('voice note failed', e.message);
      }
    }
    return media;
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
   * 8. MAIN SCAN LOOP
   * =================================================================================== */

  async function scan() {
    if (!STATE.ready || STATE.scanning) return;
    if (CONFIG.PAUSE_WHEN_HIDDEN && document.hidden) return;   // Android froze us — catch up on return

    const id = chatIdFromUrl();
    if (!id || id !== String(CONFIG.TARGET_CHAT_ID)) {
      if (!STATE.paused) { STATE.paused = true; LOG('paused — not the target thread'); }
      hud('⏸ Relay paused · open the target chat', 'warn');
      return;
    }

    const rows = getRows();
    STATE.lastRows = rows.length;
    if (!rows.length) {
      hud('⏳ Waiting for messages to render…', 'warn');
      return;
    }

    STATE.scanning = true;
    STATE.paused = false;
    STATE.lastScanAt = nowMs();
    try {
      const items = rows.map(extractRow);
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
    } catch (e) {
      WARN('scan error', e);
      STATE.lastError = e.message;
      hud('⚠️ Relay error · tap for details', 'bad');
    } finally {
      STATE.scanning = false;
    }
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

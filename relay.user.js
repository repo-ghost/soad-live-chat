// ==UserScript==
// @name         IG Direct → Live Mirror Relay (read-only)
// @namespace    https://github.com/orin/soad-live-chat
// @version      3.0.0
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
 *  HOW IT WORKS  (v3 — manual, start/pause driven)
 *  ---------------------------------------------------------------------------------
 *  The script does NOT scroll the chat for you. You scroll; it saves.
 *
 *    1. Scroll the conversation up to the very first message yourself.
 *    2. Press ▶ START (top-right). From then on it saves every message reachable
 *       from where you are downward, and keeps saving as new ones appear.
 *    3. Every message it saves gets a ✅ drawn next to it, so you can see the
 *       progress with your own eyes.
 *    4. Press ⏸ PAUSE any time. Nothing is read and nothing is written.
 *    5. Next session: press ▶ START and it saves only what is genuinely missing
 *       (anything already in the database is skipped before any media fetch).
 *
 *  WHY THIS IS BAN-SAFE
 *  ---------------------------------------------------------------------------------
 *  It never logs in, never stores cookies, never calls a private API, never sends a
 *  message, never reacts, and never touches anything outside the one thread you open.
 *  It reads the DOM that Instagram already rendered in a tab *you* are logged into,
 *  and it writes only to your own Firebase. All activity is driven by your finger on
 *  a button — there is no autonomous loop hammering the page.
 *
 *  Every message is saved at most once. Media is fetched only for messages that are
 *  not yet in the database, so re-running this never re-downloads old photos.
 * ===================================================================================== */

(function () {
  'use strict';

  /* ===================================================================================
   * 1. CONFIGURATION  — ✅ ALREADY FILLED IN FOR ORIN
   * =================================================================================== */

  const CONFIG = {
    // Firebase Realtime Database REST base for the *messages* node.
    FIREBASE_DB_URL: 'https://soad-live-default-rtdb.asia-southeast1.firebasedatabase.app/messages',

    // The numeric thread id from https://www.instagram.com/direct/t/<THIS_NUMBER>/
    TARGET_CHAT_ID: '18063962657394896',

    // While ▶ is pressed, how often we look at the screen (ms).
    SCAN_INTERVAL_MS: 1600,

    // Gap between sequential writes so message order is preserved (ms).
    POST_DELAY_MS: 80,

    // Media encoding.
    MAX_IMAGE_PX: 800,
    JPEG_QUALITY: 0.70,
    MAX_AUDIO_BYTES: 1400000, // ~1.4 MB raw ≈ 1.9 MB base64; bigger clips keep only the URL.

    // How many recent Firebase rows to compare against when catching up.
    HISTORY_LOOKBACK: 600,

    // Retries for a single message that fails to save (media fetch, network…).
    MAX_ATTEMPTS: 3,

    // Skip scans while the tab is in the background; catch up on return.
    PAUSE_WHEN_HIDDEN: true,

    // Start in the paused state. You press ▶ when you are ready.
    START_RUNNING: false,

    // Show the tiny status pill + the ✅ markers.
    SHOW_HUD: true,
    SHOW_SAVED_MARKS: true,

    // Extra logging in the browser console.
    VERBOSE: false,
  };

  /* ===================================================================================
   * 2. INTERNALS
   * =================================================================================== */

  const VERSION = '3.0.0';
  const DB = String(CONFIG.FIREBASE_DB_URL).replace(/\/+$/, '');
  const LOG = (...a) => console.log('%c[relay]', 'color:#A800FF;font-weight:700', ...a);
  const WARN = (...a) => console.warn('%c[relay]', 'color:#ff9f0a;font-weight:700', ...a);
  const VLOG = (...a) => { if (CONFIG.VERBOSE) LOG(...a); };

  const STATE = {
    ready: false,            // Firebase tail has been loaded
    running: false,          // ▶ pressed (vs ⏸ paused)
    scanning: false,
    writeLock: false,        // a save batch is in flight
    wrote: 0,                // messages saved this session
    tail: [],                // [{ key, sig }] ascending — what Firebase already knows
    sigCounts: new Map(),    // sig -> how many times it exists in the database
    seenThisSession: new Map(), // sig -> count pushed this session (before reload)
    reactions: new Map(),    // key -> reaction string | null
    mediaCache: new Map(),   // src -> data URL
    lastHudText: '',
    // diagnostics
    transport: 'unknown',
    lastStatus: null,
    lastError: '',
    lastRows: 0,
    lastScanAt: 0,
    pausedReason: 'starting',
    posSeq: new Map(),     // sig -> chat position (0 = oldest) learned from scrolling
    posMode: 'forward',    // positions are known → written as `seq`
    maxSeq: -1,
    minSeq: 0,
    orderDecided: false,
    frontLine: null,       // topmost sig saved by the LATEST pass (you are scrolling up)
    frontLineKey: '',
    bootAt: Date.now(),
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nowMs = () => Date.now();

  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  /* ===================================================================================
   * 3. UI — one green/red button (top-right), a status pill, and ✅ marks
   * =================================================================================== */

  let btnEl = null;
  let hudEl = null;
  let marksLayer = null;
  const markFor = new Map();   // sig -> {count, els:[badge]}
  let markRaf = 0;

  function el(tag, style, text) {
    const e = document.createElement(tag);
    if (style) e.setAttribute('style', style);
    if (text != null) e.textContent = text;
    return e;
  }

  /** The state of the page relative to what we can actually do right now. */
  function currentState() {
    const id = chatIdFromUrl();
    if (!id) return { code: 'no-thread', label: 'No chat open', hint: 'Open the MD.Soad chat' };
    if (id !== String(CONFIG.TARGET_CHAT_ID)) {
      return { code: 'wrong-thread', label: 'Wrong chat', hint: 'This relay only mirrors the MD.Soad thread' };
    }
    if (!STATE.ready) return { code: 'connecting', label: 'Connecting…', hint: 'Loading the database index' };
    if (!STATE.running) return { code: 'paused', label: 'Paused', hint: 'Press ▶ to start saving' };
    return { code: 'running', label: 'Saving', hint: 'Saving what is on screen' };
  }

  function ensureStartButton() {
    if (btnEl) return;
    btnEl = el('div');
    btnEl.id = 'ig-relay-toggle';
    btnEl.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); });
    btnEl.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleRunning();
    });
    document.documentElement.appendChild(btnEl);
    paintButton();
  }

  function paintButton() {
    if (!btnEl) return;
    const s = currentState();
    const live = s.code === 'running';
    const blocked = s.code === 'no-thread' || s.code === 'wrong-thread' || s.code === 'connecting';

    // green ▶ when paused and ready, red ⏸ when saving, grey when we cannot act
    const bg = blocked
      ? 'linear-gradient(135deg,#3a3a3a,#2a2a2a)'
      : live
        ? 'linear-gradient(135deg,#ff3b30,#c1121f)'
        : 'linear-gradient(135deg,#22c55e,#15803d)';

    btnEl.setAttribute('style', [
      'position:fixed', 'top:10px', 'right:10px', 'z-index:2147483600',
      'display:flex', 'align-items:center', 'gap:6px',
      'padding:9px 14px', 'border-radius:999px',
      'background:' + bg, 'color:#fff',
      'font:700 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'letter-spacing:.3px',
      'border:1px solid rgba(255,255,255,.25)',
      'box-shadow:0 4px 16px rgba(0,0,0,.5)',
      'cursor:pointer', 'user-select:none', 'touch-action:manipulation',
      'opacity:' + (blocked ? '0.75' : '1'),
    ].join(';'));

    const glyph = live ? '⏸' : '▶';
    const text = blocked ? s.label : (live ? 'PAUSE' : 'START');
    btnEl.textContent = glyph + ' ' + text;
    btnEl.title = s.hint;
  }

  function ensureHud() {
    if (!CONFIG.SHOW_HUD || hudEl) return;
    hudEl = el('div');
    hudEl.id = 'ig-relay-hud';
    hudEl.title = 'Tap for details';
    hudEl.setAttribute('style', [
      'position:fixed', 'top:56px', 'right:10px', 'z-index:2147483500',
      'font:600 11px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'padding:7px 11px', 'border-radius:999px', 'letter-spacing:.2px',
      'background:rgba(18,18,18,.94)', 'color:#fff',
      'border:1px solid rgba(255,255,255,.16)',
      'box-shadow:0 6px 22px rgba(0,0,0,.55)',
      'cursor:pointer', 'user-select:none', 'max-width:70vw',
      'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
      'touch-action:manipulation', 'display:none',
    ].join(';'));
    hudEl.addEventListener('click', () => { togglePanel(); });
    document.documentElement.appendChild(hudEl);
  }

  function hud(text, tone) {
    if (!CONFIG.SHOW_HUD) return;
    ensureHud();
    if (!hudEl) return;
    hudEl.style.display = 'block';
    if (text !== STATE.lastHudText) {
      STATE.lastHudText = text;
      hudEl.textContent = text;
    }
    hudEl.style.color =
      tone === 'warn' ? '#ffd60a' : tone === 'bad' ? '#ff6b6b' : tone === 'ok' ? '#4ade80' : '#fff';
    if (panelEl && panelEl.style.display !== 'none') renderPanel();
  }

  /* ── ✅ marks beside saved messages ────────────────────────────────────────── */

  function ensureMarksLayer() {
    if (!CONFIG.SHOW_SAVED_MARKS || marksLayer) return;
    marksLayer = el('div');
    marksLayer.id = 'ig-relay-marks';
    marksLayer.setAttribute('style',
      'position:fixed;inset:0;pointer-events:none;z-index:2147483400;overflow:hidden');
    document.documentElement.appendChild(marksLayer);
  }

  /** Remember that messages with this signature are already saved. */
  function noteSaved(sig) {
    const cur = markFor.get(sig) || { count: 0, badges: [] };
    cur.count = Math.max(cur.count, savedCountOf(sig));
    markFor.set(sig, cur);
    scheduleMarks();
  }

  function savedCountOf(sig) {
    return (STATE.sigCounts.get(sig) || 0) + (STATE.seenThisSession.get(sig) || 0);
  }

  function scheduleMarks() {
    if (markRaf) return;
    markRaf = requestAnimationFrame(() => { markRaf = 0; drawMarks(); });
  }

  /**
   * Draw a ✅ next to each saved message. Purely decorative — positions are read
   * from the live rects every frame, so scrolling and lazy-loading cannot desync
   * it, and nothing is ever injected into Instagram's own DOM.
   */
  function drawMarks() {
    if (!CONFIG.SHOW_SAVED_MARKS) return;
    ensureMarksLayer();
    if (!marksLayer) return;
    if (!STATE.running && !markFor.size) { marksLayer.textContent = ''; return; }

    const bubbles = (() => { try { return getBubbles().bubbles; } catch (_) { return []; } })();
    if (!bubbles.length) {
      marksLayer.textContent = '';
      return;
    }

    const overflow = markFor.size > 400 ? null : null; // bounds are handled below
    const html = [];
    const used = new Map();

    for (const b of bubbles) {
      const r = b.getBoundingClientRect();
      if (r.bottom < -20 || r.top > window.innerHeight + 20) continue;

      let item;
      try { item = extractRow(b); } catch (_) { continue; }
      if (!item || isJunkItem(item)) continue;

      const have = savedCountOf(item.sig);
      if (!have) continue;

      const nth = (used.get(item.sig) || 0) + 1;
      used.set(item.sig, nth);
      if (nth > have) continue;      // duplicate on screen that is not saved yet

      const left = Math.min(window.innerWidth - 22, Math.max(4, r.right - 16));
      html.push(
        '<span style="position:absolute;left:' + Math.round(left) + 'px;top:' +
        Math.round(r.top + 2) + 'px;color:#22c55e;font-size:12px;line-height:1;' +
        'text-shadow:0 0 4px #000,0 0 2px #000">✅</span>'
      );
      if (html.length > 120) break;
    }

    marksLayer.innerHTML = html.join('');
    if (overflow) { /* no-op, kept for clarity */ }
  }

  /* ── PANEL (diagnostics) ──────────────────────────────────────────────────── */

  let panelEl = null;

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

  function maskedUrl() {
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
    panelEl = el('div');
    panelEl.id = 'ig-relay-panel';
    panelEl.setAttribute('style', [
      'position:fixed', 'right:10px', 'top:92px', 'z-index:2147483500',
      'width:min(340px, 92vw)', 'max-height:62vh', 'overflow:auto',
      'background:rgba(12,12,12,.98)', 'color:#eee',
      'border:1px solid rgba(255,255,255,.16)', 'border-radius:14px',
      'padding:12px 13px',
      'font:500 11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'box-shadow:0 14px 40px rgba(0,0,0,.7)', 'white-space:pre-wrap',
      'word-break:break-word', 'display:none', '-webkit-user-select:text', 'user-select:text',
    ].join(';'));
    document.documentElement.appendChild(panelEl);
  }

  function renderPanel() {
    if (!panelEl) return;
    const s = currentState();
    const bubbles = (() => { try { return getBubbles().bubbles.length; } catch (_) { return -1; } })();
    const lines = [
      `IG Relay v${VERSION}`,
      ``,
      `state         : ${s.label.toUpperCase()}`,
      `hint          : ${s.hint}`,
      `match         : ${chatIdFromUrl() === String(CONFIG.TARGET_CHAT_ID) ? 'YES' : 'NO'}`,
      `messages now  : ${bubbles}`,
      `saved session : ${STATE.wrote}`,
      `known in DB   : ${STATE.tail.length}`,
      `last scan     : ${STATE.lastScanAt ? Math.round((nowMs() - STATE.lastScanAt) / 1000) + 's ago' : '—'}`,
      ``,
      `database      : ${maskedUrl()}`,
      `transport     : ${STATE.transport === 'gm' ? 'GM_xmlhttpRequest ✓' : STATE.transport === 'fetch' ? 'fetch' : 'not used yet'}`,
      `last HTTP     : ${STATE.lastStatus == null ? '—' : STATE.lastStatus}`,
    ];
    if (STATE.lastError) lines.push('', `last error    : ${STATE.lastError}`);
    lines.push('', '── page report ──');
    try { lines.push(pageReport()); } catch (e) { lines.push('report failed: ' + e.message); }

    panelEl.innerHTML = lines
      .map((l) => {
        if (/^IG Relay/.test(l)) return `<b style="color:#c084fc">${esc(l)}</b>`;
        if (/^last error/.test(l)) return `<b style="color:#ffb4a2">${esc(l)}</b>`;
        if (/^(database|transport|last HTTP)/.test(l)) return `<span style="color:#9ad">${esc(l)}</span>`;
        if (/^(state|match|messages now|saved session)/.test(l)) return `<span style="color:#dfe">${esc(l)}</span>`;
        return esc(l);
      })
      .join('\n') +
      `<div style="margin-top:10px;padding-top:9px;border-top:1px solid #2a2a2a;color:#888;font-family:system-ui">
         Tap the pill to close. Long-press ▶ to copy this report.
       </div>`;
  }

  function pageReport() {
    const sc = findThreadScroller();
    const bubbles = (() => { try { return getBubbles().bubbles; } catch (_) { return []; } })();
    const out = [];
    out.push('url: ' + location.pathname);
    out.push('composer: ' + (findComposer() ? 'FOUND' : 'NOT FOUND'));
    if (sc) {
      out.push('transcript: h=' + sc.scrollHeight + ' ch=' + sc.clientHeight +
               ' top=' + Math.round(sc.scrollTop) + ' kids=' + sc.children.length);
      if (sc.__relayDebug) out.push('  ' + sc.__relayDebug);
    } else {
      out.push('transcript: NOT FOUND');
    }
    out.push('bubbles: ' + bubbles.length);
    out.push('text nodes: ' + document.querySelectorAll('[dir="auto"]').length);
    out.push('first detected:');
    bubbles.slice(0, 6).forEach((b, i) => {
      const r = b.getBoundingClientRect();
      out.push('  ' + i + ': "' + (b.innerText || '').replace(/\n/g, ' ').slice(0, 30) +
               '" ' + Math.round(r.width) + 'x' + Math.round(r.height));
    });
    if (!bubbles.length) out.push('  (nothing detected)');
    return out.join('\n');
  }

  async function copyReport() {
    const text = pageReport();
    let copied = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch (_) {}
    if (!copied) {
      const box = el('textarea');
      box.value = text;
      box.setAttribute('style',
        'position:fixed;left:6px;right:6px;top:6px;height:38vh;z-index:2147483647;' +
        'background:#000;color:#0f0;font:11px ui-monospace,monospace;border:2px solid #A800FF;' +
        'border-radius:10px;padding:8px;white-space:pre;overflow:auto');
      document.documentElement.appendChild(box);
      box.focus(); box.select();
      setTimeout(() => { try { box.remove(); } catch (_) {} }, 30000);
    }
    hud(copied ? '📋 Report copied' : '📋 Select & copy the report', 'ok');
  }

  /* ===================================================================================
   * 4. FIREBASE (REST)
   * =================================================================================== */

  const GMXHR = (typeof GM_xmlhttpRequest === 'function' && GM_xmlhttpRequest) ||
    (typeof GM !== 'undefined' && GM && GM.xmlHttpRequest) || null;
  const hasGM = !!GMXHR;

  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      try {
        GMXHR({
          method: opts.method,
          url: opts.url,
          headers: opts.headers || {},
          data: opts.data,
          responseType: opts.responseType || 'text',
          timeout: opts.timeout || 25000,
          onload: resolve,
          onerror: (e) => reject(new Error('network error')),
          ontimeout: () => reject(new Error('timeout')),
        });
      } catch (e) { reject(e); }
    });
  }

  async function fbRequest(method, path, body) {
    const url = DB + path;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json' };

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
        err.final = r.status === 401 || r.status === 403 || r.status === 404;
        throw err;
      } catch (e) {
        if (e && e.final) throw e;
        if (!e.status) STATE.lastError = e.message;
      }
    }

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
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /** Load the signature index of everything already in the database. */
  async function loadIndex() {
    const q = '?orderBy=' + encodeURIComponent('"$key"') + '&limitToLast=' + CONFIG.HISTORY_LOOKBACK;
    const data = await fbRequest('GET', '.json' + q);
    const entries = data && typeof data === 'object' ? Object.entries(data) : [];
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    STATE.tail = entries.map(([key, v]) => ({ key, sig: (v && v.sig) || '' }));
    STATE.sigCounts = new Map();
    STATE.reactions.clear();
    entries.forEach(([key, v]) => {
      const sig = v && v.sig;
      if (sig) STATE.sigCounts.set(sig, (STATE.sigCounts.get(sig) || 0) + 1);
      STATE.reactions.set(key, v && v.reactions ? v.reactions : null);
    });
    markFor.clear();
    scheduleMarks();

    // Existing rows may carry `seq`, which tells us how they were ordered.
    const withSeq = entries.filter(([, v]) => v && typeof v.seq === 'number');
    if (withSeq.length >= Math.max(3, entries.length * 0.6)) {
      entries.forEach(([, v]) => { if (v && v.sig && typeof v.seq === 'number') STATE.posSeq.set(v.sig, v.seq); });
      STATE.posMode = 'forward';
    }
    LOG('index loaded:', STATE.tail.length, 'rows,', STATE.sigCounts.size,
        'distinct signatures, order mode:', withSeq.length ? 'forward' : 'newest-first');
  }

  async function pushItem(item) {
    const media = await prepareMedia(item);

    // If the message carried media we could not obtain, record that honestly
    // instead of saving an empty bubble the viewer can never fill.
    if (media.failed) {
      const label = {
        photo: "⚠️ Can't load this photo!",
        reel: "⚠️ Can't load this reel!",
        voice: "⚠️ Can't load this audio!",
        video: "⚠️ Can't load this video!",
        file: "⚠️ Can't load this file!",
      }[item.kind] || "⚠️ Can't load this message!";
      const payload = {
        side: item.side,
        kind: item.kind,
        text: '',
        ts: nowMs(),
        sig: item.sig,
        author: item.side === 'me' ? 'Orin' : 'MD.Soad',
        failed: label,
      };
      if (item.reel) payload.reel = item.reel;
      if (STATE.posMode === 'forward' && STATE.posSeq.has(item.sig)) payload.seq = STATE.posSeq.get(item.sig);
      const r2 = await fbRequest('POST', '.json', payload);
      const k2 = r2 && r2.name;
      if (!k2) throw new Error('no key returned');
      STATE.tail.push({ key: k2, sig: item.sig });
      STATE.sigCounts.set(item.sig, (STATE.sigCounts.get(item.sig) || 0) + 1);
      STATE.seenThisSession.set(item.sig, (STATE.seenThisSession.get(item.sig) || 0) + 1);
      noteSaved(item.sig);
      STATE.wrote++;
      return k2;
    }

    const payload = buildPayload(item, media);
    const res = await fbRequest('POST', '.json', payload);
    const key = res && res.name;
    if (!key) throw new Error('no key returned');

    STATE.tail.push({ key, sig: item.sig });
    if (STATE.tail.length > CONFIG.HISTORY_LOOKBACK * 2) {
      STATE.tail.splice(0, STATE.tail.length - CONFIG.HISTORY_LOOKBACK);
    }
    STATE.sigCounts.set(item.sig, (STATE.sigCounts.get(item.sig) || 0) + 1);
    STATE.seenThisSession.set(item.sig, (STATE.seenThisSession.get(item.sig) || 0) + 1);
    noteSaved(item.sig);
    STATE.wrote++;
    return key;
  }

  async function patchReactions(key, value) {
    await fbRequest('PATCH', '/' + key + '.json', { reactions: value || null });
    STATE.reactions.set(key, value || null);
  }

  /* ===================================================================================
   * 5. MEDIA HELPERS
   * =================================================================================== */

  async function getBytes(url) {
    if (!url) return null;
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
          const mime = r.responseHeaders?.match(/content-type:\s*([^\r\n;]+)/i)?.[1] || 'image/jpeg';
          return { buf: r.response, mime };
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
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image load failed'));
      img.src = url;
    });
  }

  async function toCompressedDataUrl(buf, mime, maxPx, quality) {
    const blob = new Blob([buf], { type: mime || 'image/jpeg' });
    const objUrl = URL.createObjectURL(blob);
    try {
      const img = await loadImageFromUrl(objUrl);
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (!w || !h) throw new Error('zero-size image');
      const scale = Math.min(1, maxPx / Math.max(w, h));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * scale));
      c.height = Math.max(1, Math.round(h * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', quality);
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
   * 6. PAGE SCAFFOLDING — where is the conversation?
   * =================================================================================== */

  function chatIdFromUrl() {
    const m = location.pathname.match(/\/direct\/t\/([\w.:-]+)/);
    return m ? m[1] : null;
  }

  function findComposer() {
    const sel = [
      '[contenteditable="true"][role="textbox"]',
      'div[role="textbox"][contenteditable="true"]',
      'textarea[placeholder]',
      '[aria-label*="Message" i][contenteditable="true"]',
      'div[contenteditable="true"]',
    ].join(',');
    const nodes = Array.from(document.querySelectorAll(sel));
    for (const n of nodes) {
      if (n.closest('[role="dialog"]')) continue;
      const r = n.getBoundingClientRect();
      if (r.width < 40 || r.height < 12) continue;
      if (r.top < window.innerHeight * 0.30) continue;   // composer sits low
      return n;
    }
    return null;
  }

  function isScrollable(el) {
    if (!el || !el.getBoundingClientRect) return false;
    try {
      const st = getComputedStyle(el);
      if (!/(auto|scroll)/.test(st.overflowY)) return false;
      return el.scrollHeight > el.clientHeight + 12;
    } catch (_) { return false; }
  }

  function canScroll(el) {
    if (!el || !el.getBoundingClientRect) return false;
    try {
      const st = getComputedStyle(el);
      if (!/(auto|scroll)/.test(st.overflowY)) return false;
      const r = el.getBoundingClientRect();
      return r.height >= 120 && r.height <= window.innerHeight + 40;
    } catch (_) { return false; }
  }

  function looksLikeRail(el) {
    return !!el.closest('nav, [aria-label*="Chats" i], [aria-label*="Inbox" i], [aria-label*="Conversations" i]') ||
      !!el.querySelector('a[href*="/direct/t/"]');
  }

  /**
   * The scrollable region that holds the conversation.
   *
   * Your page reports no `role="listbox"`, so we cannot rely on it. The composer
   * is the reliable anchor: the transcript is the scrollable box ABOVE it and
   * NOT containing it.
   */
  function findThreadScroller() {
    const composer = findComposer();
    const composerTop = composer ? composer.getBoundingClientRect().top : window.innerHeight;

    const holdsMessages = (el) => {
      if (!el) return false;
      if (looksLikeRail(el)) return false;
      return el.querySelectorAll('[dir="auto"], img, audio, video').length >= 1;
    };

    // 1. explicit transcript markers, when the build has them
    const explicit = [];
    document.querySelectorAll('[role="listbox"], [aria-label*="Messages" i]').forEach((e) => {
      if (e.closest('[role="dialog"]')) return;
      if (!holdsMessages(e)) return;
      const r = e.getBoundingClientRect();
      if (r.height < 120) return;
      explicit.push(e);
    });
    for (const cand of explicit) {
      if (isScrollable(cand)) return cand;
      let up = cand.parentElement;
      for (let i = 0; i < 8 && up && up !== document.body; i++, up = up.parentElement) {
        if (isScrollable(up) && !looksLikeRail(up)) return up;
      }
      const inner = Array.from(cand.querySelectorAll('div, ul'))
        .filter((e) => isScrollable(e) && !looksLikeRail(e))
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
      if (inner) return inner;
      if (canScroll(cand)) return cand;
    }

    // 2. the scrollable box above the composer
    const cands = [];
    document.querySelectorAll('div, section, main, ul').forEach((e) => {
      if (e === document.body || e === document.documentElement) return;
      if (composer && e.contains(composer)) return;      // the composer itself / its wrapper
      if (looksLikeRail(e)) return;
      if (!holdsMessages(e)) return;
      const r = e.getBoundingClientRect();
      if (r.width < 120 || r.height < 120) return;
      if (r.top < -8) return;                            // header / off-screen
      if (r.bottom > composerTop + 8) return;            // must sit above the input
      // Must be scroll-CAPABLE, not necessarily overflowing: a short chat (or a
      // freshly opened thread that has only loaded the last screenful) has
      // scrollHeight === clientHeight and would otherwise be rejected.
      if (!isScrollable(e) && !canScroll(e)) return;
      if (e.querySelectorAll('[dir="auto"], img, audio, video').length < 2) return;
      const over = e.scrollHeight - e.clientHeight;
      cands.push({ e, over, texts: e.querySelectorAll('[dir="auto"]').length });
    });

    if (cands.length) {
      // the transcript is the one with the most content, not the tallest
      cands.sort((a, b) => (b.texts + b.over / 1000) - (a.texts + a.over / 1000));
      return cands[0].e;
    }

    // 3. last resort: biggest scrollable box anywhere that is not the rail
    let best = null;
    let score = 0;
    document.querySelectorAll('div, section, main, ul').forEach((e) => {
      if (looksLikeRail(e) || !isScrollable(e) || !holdsMessages(e)) return;
      const s = (e.scrollHeight - e.clientHeight) + e.querySelectorAll('[dir="auto"]').length * 20;
      if (s > score && e.clientHeight > 150) { score = s; best = e; }
    });
    return best;
  }

  /* ===================================================================================
   * 7. MESSAGE DETECTION  ← the part that must be right
   * ===================================================================================
   *  Your page: transcript children = 1, 87 text nodes, only 2 rows guessed.
   *  Instagram wraps every message in layer after layer of divs, so looking at
   *  "children that look like a message" fails completely.
   *
   *  The reliable model is depth-based: bubble wrappers all live at the SAME
   *  nesting depth inside the transcript, no matter how deep that is. So we take
   *  the text content elements, climb to the transcript, and pick the depth that
   *  yields many candidate blocks — each containing exactly one message.
   * =================================================================================== */

  const AVATAR_ALT = /(profile picture|profile photo|user avatar|^avatar$|\bavatar\b)/i;
  const AVATAR_PATH = /\/(?:profile_pic|avatar|pfp)[\w.-]*/i;
  // "M∂.รσα∂ replied to you" — the name can be in ANY script, so never try to
  // enumerate characters. Match the banner shape instead, anchored at both ends.
  const REPLY_QUOTE_RE = /^.{0,60}?\breplied to\b.{0,40}$/i;
  const IG_CONTENT_RE = /instagram\.com\/(reel|reels|p|tv)\//i;
  const REACTION_ONLY = /^(?:\p{Extended_Pictographic}|\uFE0F|\u200D|\s)+$/u;
  const REACTION_STRIP = /\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*/gu;
  const NOISE_ALT = /^(shared photo|photo shared by|video shared by|image|photo|gif|sticker)/i;
  const MAX_BUBBLE_HEIGHT = 600;

  function isLikelyAvatarImg(img) {
    if (!img) return true;
    const alt = img.getAttribute('alt') || '';
    if (AVATAR_ALT.test(alt)) return true;
    for (const attr of ['aria-label', 'title']) {
      const v = img.getAttribute(attr);
      if (v && AVATAR_ALT.test(v)) return true;
    }
    const src = img.getAttribute('src') || '';
    if (AVATAR_PATH.test(src)) return true;
    const r = img.getBoundingClientRect();
    const rendered = Math.max(r.width, r.height);
    if (rendered > 0 && rendered < 72) return true;
    if (rendered === 0) return true;
    const natW = img.naturalWidth || 0;
    const natH = img.naturalHeight || 0;
    if (natW && natW === natH && natW <= 160 && rendered <= 96) return true;
    return false;
  }

  function fullText(node) {
    return (node.innerText || node.textContent || '').trim();
  }

  /**
   * Does this word appear inside the chat's own UI labels (reply banners,
   * reactions, "Replied to …") rather than in a message body?
   */
  function isUiLabel(text) {
    const t = (text || '').trim();
    if (!t) return true;
    if (REPLY_QUOTE_RE.test(t)) return true;
    if (/^replied to you$/i.test(t)) return true;
    if (/^you replied to/i.test(t)) return true;
    if (/^(seen|delivered|sent)$/i.test(t)) return true;
    if (/^\d{1,2}:\d{2}\s?[AP]M$/i.test(t)) return true;
    if (/^\d+[smhdwy]$/i.test(t)) return true;
    if (/^active (now|\d)/i.test(t)) return true;
    if (/^(liked a message|reacted to)/i.test(t)) return true;
    return false;
  }

  const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
  const WEEKDAY = '(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*';
  const DATE_SEPARATOR = new RegExp(
    '^\\s*(?:' + WEEKDAY + '\\.?,?\\s+)?' + MONTH +
    '\\s+\\d{1,2}(?:,?\\s+\\d{2,4})?(?:\\s*[·,]\\s*\\d{1,2}:\\d{2}\\s*[ap]\\.?m\\.?)?\\s*$' +
    '|^\\s*\\d{1,2}:\\d{2}\\s*[ap]\\.?m\\.?\\s*$' +
    '|^\\s*(?:yesterday|today)(?:\\s*[·,]?\\s*\\d{1,2}:\\d{2}\\s*[ap]\\.?m\\.?)?\\s*$' +
    '|^\\s*\\d{1,2}/\\d{1,2}/\\d{2,4}\\s*$',
    'i'
  );

  function isDateSeparator(txt) {
    if (!txt) return false;
    const clean = String(txt).replace(/\s+/g, ' ').trim();
    if (clean.length > 40) return false;
    return DATE_SEPARATOR.test(clean);
  }

  /** Depth of `node` below `root` (root itself = 0). */
  function depthBelow(node, root) {
    let d = 0;
    let cur = node;
    while (cur && cur !== root) { cur = cur.parentElement; d++; if (d > 60) return -1; }
    return cur === root ? d : -1;
  }

  /** Real shared media inside an element (avatars excluded). */
  function realImages(node) {
    return Array.from(node.querySelectorAll('img')).filter((im) => {
      if (!im.src) return false;
      if (isLikelyAvatarImg(im)) return false;
      if (im.closest('a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"], a[href*="/tv/"]')) return false;
      return true;
    });
  }

  function hasRealMedia(node) {
    if (node.querySelector('audio, video')) return true;
    if (realImages(node).length) return true;
    if (node.querySelector('a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"], a[href*="/tv/"]')) return true;
    if (/\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|txt|csv|apk)\b/i.test(fullText(node))) return true;
    return false;
  }

  /** DOM order comparator for two elements. */
  function domOrder(a, b) {
    if (a === b) return 0;
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  /** Sanity checks for one candidate message block. */
  function blockLooksValid(node, root) {
    if (!node || node === root || node.nodeType !== 1) return false;
    if (node.closest('[role="dialog"]')) return false;
    if (looksLikeRail(node)) return false;

    const r = node.getBoundingClientRect();
    if (r.height < 8 || r.width < 20) return false;
    if (r.height > MAX_BUBBLE_HEIGHT) return false;

    const txt = fullText(node);
    if (isDateSeparator(txt)) return false;

    // A message holds ONE body. More than a few [dir=auto] means we climbed too
    // far and grabbed the list instead of a single message.
    const textNodes = node.querySelectorAll('[dir="auto"]').length;
    if (textNodes > 4) return false;

    if (!txt && !hasRealMedia(node)) return false;
    // a reply banner with no body and no media is chrome, not a message
    if (txt && isUiLabel(txt) && !hasRealMedia(node)) return false;
    return true;
  }

  /** Is this node part of the open conversation (not the rail, a dialog, or hidden)? */
  function inChat(node, root) {
    if (!root || !root.contains(node)) return false;
    if (node.closest('[role="dialog"]')) return false;
    if (looksLikeRail(node)) return false;
    const r = node.getBoundingClientRect();
    // Instagram keeps a hidden "measure" copy of every message: height 0 but
    // FULL WIDTH, so testing width alone let them through and every message was
    // saved twice.
    if (r.height < 4 || r.width < 4) return false;
    try {
      const st = getComputedStyle(node);
      if (st.visibility === 'hidden' || st.display === 'none' || parseFloat(st.opacity) === 0) return false;
    } catch (_) {}
    return true;
  }

  /** One "piece of content" that belongs to exactly one message. */
  function contentSeeds(root) {
    const seeds = [];
    root.querySelectorAll('[dir="auto"]').forEach((n) => {
      const t = (n.innerText || '').trim();
      if (!t) return;
      if (isUiLabel(t) || isDateSeparator(t)) return;
      if (!inChat(n, root)) return;
      seeds.push(n);
    });
    root.querySelectorAll('img, audio, video').forEach((n) => {
      if (n.tagName === 'IMG' && isLikelyAvatarImg(n)) return;
      // NOTE: a reel/post poster lives inside a link to the post — it IS the
      // message preview, so it must be a seed. Excluding it made shared reels
      // invisible and they were never saved.
      if (!inChat(n, root)) return;
      seeds.push(n);
    });
    return seeds;
  }

  /**
   * Climb from one content node to the wrapper that holds exactly ONE message.
   *
   * We stop as soon as the parent holds two or more separate content groups —
   * that parent is the message list, so the child is a single message. This is
   * what keeps photos, reels and voice notes attached to their own message
   * instead of being chopped off by a text-only depth heuristic.
   */
  function wrapperFor(seed, root) {
    let cur = seed;
    for (let i = 0; i < 14; i++) {
      const parent = cur.parentElement;
      if (!parent || parent === root || parent === document.body) return cur;
      if (contentGroupsIn(parent, root) >= 2) return cur;
      cur = parent;
    }
    return cur;
  }

  /** How many separate content pieces does this element directly hold? */
  function contentGroupsIn(node, root) {
    let groups = 0;
    for (const child of node.children) {
      if (child.querySelector('[dir="auto"]') ||
          realImages(child).length ||
          child.querySelector('audio, video') ||
          (child.matches && child.matches('img') && !isLikelyAvatarImg(child))) {
        groups++;
      }
      if (groups > 6) break;
    }
    return groups;
  }

  /**
   * Candidate message blocks, top → bottom.
   *
   * Primary path: climb each content seed to its single-message wrapper.
   * Fallback: the depth-histogram method (for layouts where every message is a
   * direct child of a deep wrapper).
   */
  function findMessageBlocks(scroller) {
    const root = scroller || document.body;
    const seeds = contentSeeds(root);
    if (!seeds.length) return [];

    const blocks = [];
    const seen = new Set();
    for (const seed of seeds) {
      const w = wrapperFor(seed, root);
      if (!w || seen.has(w)) continue;
      seen.add(w);
      if (!blockLooksValid(w, root)) continue;
      blocks.push(w);
    }

    // keep the innermost of any nested pair
    let out = blocks.filter((b, i, arr) => !arr.some((o) => o !== b && b.contains(o)));

    if (out.length < 2) {
      // fallback: deepest repeating depth
      const depthHit = depthBasedBlocks(root, seeds);
      if (depthHit.length > out.length) out = depthHit;
    }

    return out.sort(domOrder);
  }

  function depthBasedBlocks(root, seeds) {
    const hist = new Map();
    const byDepth = new Map();
    for (const s of seeds) {
      const d = depthBelow(s, root);
      if (d < 2) continue;
      hist.set(d, (hist.get(d) || 0) + 1);
      if (!byDepth.has(d)) byDepth.set(d, []);
      byDepth.get(d).push(s);
    }
    let best = [];
    for (const d of Array.from(hist.keys()).sort((a, b) => b - a)) {
      const blocks = [];
      const seen = new Set();
      for (const seed of byDepth.get(d) || []) {
        const anc = ancestorAtDepth(seed, root, d);
        if (!anc || seen.has(anc)) continue;
        seen.add(anc);
        if (!blockLooksValid(anc, root)) continue;
        blocks.push(anc);
      }
      if (blocks.length > best.length) best = blocks;
      if (blocks.length >= 6) break;
    }
    return best;
  }

  /** Every message currently rendered, top → bottom. */
  function getBubbles() {
    const scroller = findThreadScroller();
    let bubbles = findMessageBlocks(scroller);

    if (!bubbles.length) {
      // structure-free fallback: text nodes grouped by their nearest ancestor
      const root = scroller || document.body;
      const seeds = Array.from(root.querySelectorAll('[dir="auto"]')).filter((n) => inChat(n, root));
      const groups = [];
      const seen = new Set();
      for (const n of seeds) {
        let g = n;
        for (let i = 0; i < 4; i++) {
          if (!g.parentElement || g.parentElement === root) break;
          if (g.parentElement.querySelectorAll('[dir="auto"]').length > 1) break;
          g = g.parentElement;
        }
        if (seen.has(g)) continue;
        seen.add(g);
        if (blockLooksValid(g, root)) groups.push(g);
      }
      bubbles = groups;
    }

    // de-duplicate nested blocks, keep the innermost
    bubbles = bubbles.filter((b, i, arr) => !arr.some((o) => o !== b && b.contains(o)));

    const out = [];
    const seen = new Set();
    for (const b of bubbles) {
      const r = b.getBoundingClientRect();
      const key = Math.round(r.top) + '|' + Math.round(r.left) + '|' + fullText(b).slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(b);
    }
    out.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return ra.top - rb.top || ra.left - rb.left;
    });
    return { bubbles: out, scroller };
  }

  /* ===================================================================================
   * 8. EXTRACTION
   * =================================================================================== */

  /** "Me" = rendered right-to-left, with a geometry fallback. */
  function isMine(row) {
    let el = row;
    for (let i = 0; i < 9 && el && el !== document.body; i++, el = el.parentElement) {
      const inline = el.getAttribute && el.getAttribute('style');
      if (inline && /flex-direction\s*:\s*row-reverse/i.test(inline)) return true;
      try {
        if (getComputedStyle(el).flexDirection === 'row-reverse') return true;
      } catch (_) { /* ignore */ }
    }
    const marker = row.querySelector('[dir="auto"]') || row.querySelector('img') || row;
    const mr = marker.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    if (!rr.width || !mr.width) return false;
    return (mr.left + mr.width / 2 - rr.left) / rr.width > 0.55;
  }

  /**
   * Text of one message, with every piece of chat chrome removed.
   *
   * This is where "M∂.รσα∂ replied to you" came from: Instagram renders the reply
   * banner inside the same block as the message. Banners are recognised and
   * dropped, and a banner that is the ONLY text means "this is a reply with no
   * new text" → return '' so the block can be skipped instead of saved as junk.
   */
  function extractTextFor(row, excludeEls) {
    const skip = new Set(excludeEls || []);
    const parts = [];
    const nodes = Array.from(row.querySelectorAll('[dir="auto"]'));

    for (const n of nodes) {
      let blocked = false;
      for (const s of skip) { if (s === n || s.contains(n)) { blocked = true; break; } }
      if (blocked) continue;

      const t = (n.innerText || '').trim();
      if (!t) continue;
      if (t.length > 4000) continue;

      if (isUiLabel(t)) continue;            // reply banner, "seen", clock, "2h"
      if (isDateSeparator(t)) continue;
      if (NOISE_ALT.test(t)) continue;

      // quoted reply payload: a nested block that repeats the quoted text
      if (n.closest('blockquote')) continue;

      if (parts[parts.length - 1] !== t) parts.push(t);
    }

    let text = parts.join('\n').trim();
    // strip a trailing/leading banner that survived as one line among many
    text = text.split('\n').filter((l) => !isUiLabel(l)).join('\n').trim();
    return text;
  }

  function findReaction(row) {
    // 1) labelled react buttons ("React with ❤️")
    for (const e of row.querySelectorAll('[aria-label]')) {
      const label = e.getAttribute('aria-label') || '';
      if (!/react/i.test(label)) continue;
      const txt = (e.innerText || e.textContent || '').trim();
      const emoji = txt.match(REACTION_STRIP);
      if (emoji && emoji.length) return emoji.join('');
      const byLabel = label.match(REACTION_STRIP);
      if (byLabel && byLabel.length) return byLabel.join('');
    }
    // 2) a tiny emoji-only element that is not the message body
    const textNodes = new Set(Array.from(row.querySelectorAll('[dir="auto"]')));
    for (const e of row.querySelectorAll('span, div')) {
      if (e.children.length > 1) continue;
      const txt = (e.textContent || '').trim();
      if (!txt || txt.length > 14) continue;
      const emoji = txt.match(REACTION_STRIP);
      if (!emoji) continue;
      if (!REACTION_ONLY.test(txt.replace(/[\d+]/g, ''))) continue;
      let isText = false;
      for (const tn of textNodes) { if (tn === e || tn.contains(e)) { isText = true; break; } }
      if (isText) continue;
      const r = e.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.width <= 64 && r.height <= 44) return emoji.slice(0, 3).join('');
    }
    return null;
  }

  function extractReels(row) {
    const links = new Map();
    row.querySelectorAll('a[href]').forEach((a) => {
      const href = a.href || '';
      if (!IG_CONTENT_RE.test(href)) return;
      const img = a.querySelector('img');
      links.set(href.split('?')[0], img ? img.src : null);
    });
    if (!links.size) {
      const m = fullText(row).match(/https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p|tv)\/[^\s]+/i);
      if (m) links.set(m[0].split('?')[0], null);
    }
    return Array.from(links.entries()).map(([url, thumb]) => ({ url, thumb }));
  }

  function imageFingerprint(src) {
    try {
      const u = new URL(src);
      const file = u.pathname.split('/').filter(Boolean).pop() || u.pathname;
      return file.replace(/\.(jpg|jpeg|png|webp|heic)$/i, '');
    } catch (_) {
      return hash(String(src)).slice(0, 8);
    }
  }

  function extractAttachment(row) {
    const txt = fullText(row);
    const sizeRe = /\b\d+(\.\d+)?\s?(B|KB|MB|GB)\b/i;
    const extRe = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|txt|csv|apk|mp3|mp4|mov|heic|jpg|png)\b/i;
    const size = (txt.match(sizeRe) || [''])[0];
    const hasExt = extRe.test(txt);
    const cardLike = !!row.querySelector('[aria-label*="document" i], [aria-label*="file" i], [aria-label*="attachment" i]');
    if (!hasExt && !(cardLike && size)) return null;
    const lines = txt.split('\n').map((t) => t.trim()).filter(Boolean);
    let name = lines.find((l) => extRe.test(l));
    if (!name) name = lines[0] || (cardLike ? 'Attachment' : '');
    if (!name) return null;
    return { name: name.slice(0, 120), size };
  }

  /** One bubble → a normalised record. */
  function extractRow(row) {
    const side = isMine(row) ? 'me' : 'friend';

    const imgs = realImages(row);
    const reels = extractReels(row);
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

    let caption = extractTextFor(row, []);
    if (kind === 'file' && file && caption.includes(file.name)) caption = '';
    if (NOISE_ALT.test(caption || '')) caption = '';

    const imgSrc = kind === 'photo' ? imgs[0].src : null;
    const reelThumbSrc = kind === 'reel' ? (reels[0].thumb || (imgs[0] && imgs[0].src) || null) : null;

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
      row, side, kind, text: caption || '', sig,
      reaction: findReaction(row),
      imgSrc, audioSrc,
      videoSrc: video ? (video.currentSrc || video.src || null) : null,
      reel: reels[0] ? reels[0].url : null,
      reelThumbSrc,
      file,
    };
  }

  /** Chrome that must never be saved as a message. */
  function isJunkItem(item) {
    const t = (item.text || '').trim();
    if (item.kind !== 'text') return false;
    if (!t) return true;
    if (isUiLabel(t)) return true;
    if (isDateSeparator(t)) return true;
    if (/sent an attachment\.?$/i.test(t) && t.length < 40) return true;
    return false;
  }

  /* ===================================================================================
   * 9. PAYLOAD
   * =================================================================================== */

  function buildPayload(item, media) {
    const payload = {
      side: item.side,
      kind: item.kind,
      text: item.text || '',
      ts: nowMs(),
      sig: item.sig,
      author: item.side === 'me' ? 'Orin' : 'MD.Soad',
    };
    // True chat position, only when we actually know it. The viewer sorts on it,
    // so writing a guess would be worse than writing nothing.
    if (STATE.posMode === 'forward' && STATE.posSeq.has(item.sig)) {
      payload.seq = STATE.posSeq.get(item.sig);
    }
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

  /**
   * Fetch and compress the media for one message. `failed` is true when the
   * message carries media we could not obtain — the caller then saves an honest
   * placeholder instead of inventing an empty bubble.
   */
  async function prepareMedia(item) {
    const media = { img: null, audio: null, thumb: null, videoThumb: null, failed: false };
    const attempt = async (fn, label) => {
      for (let i = 1; i <= CONFIG.MAX_ATTEMPTS; i++) {
        try {
          const out = await fn();
          if (out) return out;
        } catch (e) {
          VLOG(label + ' attempt ' + i + ' failed:', e.message);
        }
        await sleep(250 * i);
      }
      WARN(label + ' failed after ' + CONFIG.MAX_ATTEMPTS + ' attempts');
      return null;
    };

    if (item.kind === 'photo' && item.imgSrc) {
      media.img = await attempt(() => mediaDataUrl(item.imgSrc), 'photo');
      if (!media.img) media.failed = true;
    }
    if (item.kind === 'reel') {
      if (item.reelThumbSrc) {
        media.thumb = await attempt(
          () => mediaDataUrl(item.reelThumbSrc, { maxPx: 480, quality: 0.62 }), 'reel thumb');
      }
      if (!item.reel) media.failed = true;
    }
    if (item.kind === 'video' && item.videoSrc && !item.videoSrc.startsWith('blob:')) {
      media.videoThumb = await attempt(() => makeVideoThumb(item.videoSrc), 'video thumb');
    }
    if (item.kind === 'voice' && item.audioSrc) {
      const raw = await attempt(() => getBytes(item.audioSrc), 'voice');
      if (raw && raw.buf && raw.buf.byteLength) {
        if (raw.buf.byteLength <= CONFIG.MAX_AUDIO_BYTES) {
          media.audio = 'data:' + (raw.mime || 'audio/mp4') + ';base64,' + abToBase64(raw.buf);
        } else {
          WARN('voice note too large, keeping URL only');
        }
      }
      if (!media.audio && (!item.audioSrc || item.audioSrc.startsWith('blob:'))) media.failed = true;
    }
    return media;
  }

  async function makeVideoThumb(src) {
    const v = document.querySelector('video');
    if (v && v.videoWidth) {
      const c = document.createElement('canvas');
      const w = v.videoWidth, h = v.videoHeight;
      c.width = Math.min(480, w);
      c.height = Math.round((c.width / w) * h);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.6);
    }
    const bytes = await getBytes(src);
    if (!bytes || !bytes.buf) return null;
    return toCompressedDataUrl(bytes.buf, bytes.mime, 480, 0.6);
  }

  /* ===================================================================================
   * 10. THE SAVE LOOP
   * ===================================================================================
   *  Save everything on screen that is not in the database yet, top → bottom.
   *  Two guards stop duplicates:
   *    • the database index (sigCounts) — global truth
   *    • seenThisSession — sigs pushed before the index could reflect them
   * =================================================================================== */

  /**
   * Give every message in this batch a `seq` (its place in the chat).
   * First batch of a session anchors at 0..n-1; older batches go negative.
   */
  function assignPositions(todo) {
    if (!STATE.orderDecided) {
      STATE.orderDecided = true;
      let n = 0;
      for (const it of todo) {
        if (!STATE.posSeq.has(it.sig)) STATE.posSeq.set(it.sig, n++);
      }
      STATE.maxSeq = Math.max(STATE.maxSeq, n - 1);
      STATE.minSeq = Math.min(STATE.minSeq, 0);
      LOG('positions: batch anchored at 0..' + (n - 1));
      return;
    }
    // messages with no position yet were reached by scrolling ABOVE what we know
    const fresh = todo.filter((it) => !STATE.posSeq.has(it.sig));
    let minSeq = STATE.minSeq;
    for (let i = fresh.length - 1; i >= 0; i--) {
      STATE.posSeq.set(fresh[i].sig, --minSeq);
    }
    STATE.minSeq = minSeq;
    if (fresh.length) VLOG('assigned', fresh.length, 'positions from', minSeq);
  }

  function missingOnScreen() {
    let bubbles;
    try { bubbles = getBubbles().bubbles; } catch (_) { return []; }
    const out = [];
    const planned = new Map();     // sig -> how many we are about to write

    for (const b of bubbles) {
      let item;
      try { item = extractRow(b); } catch (_) { continue; }
      if (!item) continue;
      if (isJunkItem(item)) continue;
      if (!item.text && item.kind === 'text') continue;

      const have = (STATE.sigCounts.get(item.sig) || 0) + (STATE.seenThisSession.get(item.sig) || 0);
      const taking = planned.get(item.sig) || 0;
      if (taking < have) { planned.set(item.sig, taking + 1); continue; }  // already saved copy

      planned.set(item.sig, taking + 1);
      out.push(item);
    }
    return out;
  }

  async function savePass() {
    if (STATE.writeLock) return;
    STATE.writeLock = true;
    try {
      const todo = missingOnScreen();
      STATE.lastRows = todo.length;
      if (!todo.length) {
        hud('✅ All caught up · ' + STATE.wrote + ' saved', 'ok');
        return;
      }

      // Remember where this batch begins. You scroll upward, so a later batch is
      // always OLDER than the previous one — but only if the view actually moved.
      const batchTop = { sig: todo[0].sig, key: todo[0].sig + '@' + todo[0].side };
      const continuingUp = STATE.frontLine && STATE.frontLineKey !== batchTop.key;

      // If the database is empty this is the FIRST batch. Whether it covers the
      // oldest message decides the direction for the whole session.
      const dbEmptyAtStart = STATE.sigCounts.size === 0;

      // ── Chat position, BEFORE writing ────────────────────────────────────────
      // Numbering is anchored on the FIRST batch of the session: that is the
      // oldest range reached so far, so it gets 0..n-1. Batches you scroll up to
      // later are older still, so they take negative positions. Nothing already
      // stored is ever renumbered.
      assignPositions(todo);

      for (let i = 0; i < todo.length; i++) {
        if (!STATE.running) break;                     // ⏸ respected mid-batch
        if (CONFIG.PAUSE_WHEN_HIDDEN && document.hidden) break;

        const item = todo[i];
        let saved = false;
        let lastErr = '';
        for (let a = 1; a <= CONFIG.MAX_ATTEMPTS && !saved; a++) {
          try {
            await pushItem(item);
            saved = true;
          } catch (e) {
            lastErr = e.message;
            STATE.lastError = e.message;
            await sleep(200 * a);
          }
        }

        if (!saved) {
          // Honest placeholder: the message existed but could not be obtained.
          try {
            const label = {
              photo: '⚠️ Can\'t load this photo!',
              reel: '⚠️ Can\'t load this reel!',
              voice: '⚠️ Can\'t load this audio!',
              video: '⚠️ Can\'t load this video!',
              file: '⚠️ Can\'t load this file!',
              text: '⚠️ Can\'t load this message!',
            }[item.kind] || '⚠️ Can\'t load this message!';
            const payload = {
              side: item.side,
              kind: item.kind,
              text: item.text || '',
              ts: nowMs(),
              sig: item.sig + ':failed',
              author: item.side === 'me' ? 'Orin' : 'MD.Soad',
              failed: label,
            };
            if (item.reel) payload.reel = item.reel;
            const res = await fbRequest('POST', '.json', payload);
            const key = res && res.name;
            if (key) {
              STATE.tail.push({ key, sig: payload.sig });
              STATE.sigCounts.set(payload.sig, (STATE.sigCounts.get(payload.sig) || 0) + 1);
              STATE.seenThisSession.set(payload.sig, (STATE.seenThisSession.get(payload.sig) || 0) + 1);
              noteSaved(item.sig);          // the message IS recorded, mark it
              STATE.wrote++;
            }
          } catch (e) {
            WARN('placeholder save failed', e.message);
            STATE.lastError = 'save failed: ' + (lastErr || e.message);
          }
        }

        hud('⬆ Saving ' + (i + 1) + '/' + todo.length + ' · ' + STATE.wrote + ' done');
        await sleep(CONFIG.POST_DELAY_MS);
      }

      // A batch that starts with a message we already know is a repeat of the
      // same screen (nothing scrolled). A batch that starts with a NEW message
      // while we were already saving means the view jumped down, which would
      // break chronological order — flag it rather than silently mis-ordering.
      STATE.frontLine = batchTop.sig;
      STATE.frontLineKey = batchTop.key;
      STATE.reversed = !!(STATE.lastFrontLine && STATE.lastFrontLine === batchTop.sig);
      STATE.lastFrontLine = batchTop.sig;

      if (STATE.running) hud('🔴 Saving · ' + STATE.wrote + ' done', 'ok');
    } finally {
      STATE.writeLock = false;
    }
  }

  /* ===================================================================================
   * 11. REACTIONS on already-saved messages
   * =================================================================================== */

  async function syncReactions() {
    if (!STATE.tail.length) return;
    const bubbles = (() => { try { return getBubbles().bubbles; } catch (_) { return []; } })();
    if (!bubbles.length) return;

    const keyBySig = new Map();
    STATE.tail.forEach(({ key, sig }) => { if (sig) keyBySig.set(sig, key); });

    for (const b of bubbles) {
      let item;
      try { item = extractRow(b); } catch (_) { continue; }
      const key = keyBySig.get(item.sig);
      if (!key) continue;
      const current = STATE.reactions.get(key) || null;
      if ((item.reaction || null) === current) continue;
      try {
        await patchReactions(key, item.reaction);
        LOG('reaction updated', key, current, '→', item.reaction);
      } catch (_) { /* non-fatal */ }
    }
  }

  /* ===================================================================================
   * 12. MAIN LOOP (ticks only while ▶ is pressed)
   * =================================================================================== */

  let bootAttempts = 0;

  async function tick() {
    if (STATE.scanning || STATE.writeLock) return;
    if (!STATE.ready || !STATE.running) return;
    if (CONFIG.PAUSE_WHEN_HIDDEN && document.hidden) return;

    const s = currentState();
    if (s.code === 'wrong-thread' || s.code === 'no-thread') {
      hud('⏸ ' + s.hint, 'warn');
      return;
    }

    STATE.scanning = true;
    STATE.lastScanAt = nowMs();
    try {
      await savePass();
      await syncReactions();
      scheduleMarks();
    } catch (e) {
      WARN('tick error', e);
      STATE.lastError = e.message;
      hud('⚠️ ' + e.message.slice(0, 48), 'bad');
    } finally {
      STATE.scanning = false;
      paintButton();
    }
  }

  function toggleRunning() {
    const s = currentState();
    if (s.code === 'no-thread' || s.code === 'wrong-thread') {
      hud('⏸ ' + s.hint, 'warn');
      return;
    }
    if (s.code === 'connecting') {
      hud('⏳ Still loading the database index…', 'warn');
      return;
    }
    STATE.running = !STATE.running;
    paintButton();
    if (STATE.running) {
      hud('🔴 Saving · press ⏸ to stop', 'ok');
      tick();
    } else {
      hud('⏸ Paused · nothing is being saved');
    }
  }

  /* ===================================================================================
   * 13. BOOT
   * =================================================================================== */

  function configProblems() {
    const out = [];
    if (!/^https?:\/\//i.test(CONFIG.FIREBASE_DB_URL)) out.push('FIREBASE_DB_URL is not a URL');
    if (/YOUR-PROJECT-ID/.test(CONFIG.FIREBASE_DB_URL)) out.push('FIREBASE_DB_URL has a placeholder');
    if (/YOUR_THREAD_ID/.test(String(CONFIG.TARGET_CHAT_ID))) out.push('TARGET_CHAT_ID has a placeholder');
    return out;
  }

  function boot() {
    ensureStartButton();
    ensureHud();
    bootAttempts++;

    const problems = configProblems();
    if (problems.length) {
      hud('⚠️ Setup needed', 'bad');
      LOG('config problems:', problems.join(' · '));
      return;
    }

    hud('⏳ Connecting…');

    loadIndex()
      .then(() => {
        STATE.ready = true;
        STATE.lastError = '';
        STATE.running = CONFIG.START_RUNNING;
        paintButton();
        hud(STATE.running ? '🔴 Saving · press ⏸ to stop' : '⏸ Paused · scroll up and press ▶', 'ok');
        LOG('ready ·', STATE.tail.length, 'rows indexed');
        scheduleMarks();
      })
      .catch((e) => {
        WARN('could not load Firebase index:', e.message);
        STATE.lastError = e.message;
        hud('⚠️ Database unreachable · tap', 'bad');
        buildPanel();
        panelEl.style.display = 'block';
        renderPanel();
      });

    // periodic tick, only meaningful while running
    setInterval(tick, CONFIG.SCAN_INTERVAL_MS);

    // new messages arriving while running
    let t = null;
    const obs = new MutationObserver(() => {
      if (!STATE.running) return;
      if (t) return;
      t = setTimeout(() => { t = null; tick(); }, 500);
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });

    // keep the ✅ marks glued to the right bubbles while scrolling
    const onScroll = () => scheduleMarks();
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll);

    // repaint the button when the route changes (Instagram is an SPA)
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        paintButton();
        setTimeout(() => { scheduleMarks(); if (STATE.running) tick(); }, 700);
      }
    }, 700);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && STATE.ready && STATE.running) tick();
    });
  }

  /* ── Debug handle ───────────────────────────────────────────────────────── */
  try {
    window.__relayDebug = {
      version: VERSION,
      scroller: () => findThreadScroller(),
      bubbles: () => getBubbles().bubbles,
      items: () => getBubbles().bubbles.map((b) => {
        try { const i = extractRow(b); return { kind: i.kind, side: i.side, text: i.text, sig: i.sig }; }
        catch (e) { return { error: e.message }; }
      }),
      missing: () => missingOnScreen().map((i) => ({ kind: i.kind, text: i.text })),
      report: () => pageReport(),
      stateSigs: () => ({ count: STATE.sigCounts.size, sigs: Array.from(STATE.sigCounts.keys()).slice(0, 20) }),
      snapshot() {
        const sc = findThreadScroller();
        const items = this.items();
        return {
          version: VERSION,
          url: location.pathname,
          running: STATE.running,
          ready: STATE.ready,
          composer: !!findComposer(),
          scroller: sc ? {
            h: sc.scrollHeight, ch: sc.clientHeight, top: Math.round(sc.scrollTop),
            kids: sc.children.length, debug: sc.__relayDebug,
          } : null,
          bubbles: items.length,
          items: items.slice(0, 12),
          missing: this.missing().length,
          savedThisSession: STATE.wrote,
          inDb: STATE.tail.length,
          lastError: STATE.lastError,
        };
      },
    };
  } catch (_) {}

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();

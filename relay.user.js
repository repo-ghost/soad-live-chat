// ==UserScript==
// @name         IG Direct → Live Mirror Relay (read-only)
// @namespace    https://github.com/orin/soad-live-chat
// @version      1.0.0
// @description  Mirrors ONE Instagram Direct thread to Firebase Realtime Database for a public read-only page. Client-side DOM observation only — no login automation, no private APIs.
// @author       Orin
// @match        https://www.instagram.com/direct/*
// @match        https://instagram.com/direct/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @connect      firebaseio.com
// @connect      firebasedatabase.app
// @connect      cdninstagram.com
// @connect      fbcdn.net
// @connect      instagram.com
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
 * ===================================================================================== */

(function () {
  'use strict';

  /* ===================================================================================
   * 1. CONFIGURATION  — EDIT THESE TWO LINES ONLY
   * =================================================================================== */

  const CONFIG = {
    // Firebase Realtime Database REST base for the *messages* node.
    // Use the exact URL shown in your Firebase console (region-specific URLs differ).
    FIREBASE_DB_URL: 'https://YOUR-PROJECT-ID-default-rtdb.firebaseio.com/messages',

    // The numeric thread id from https://www.instagram.com/direct/t/<THIS_NUMBER>/
    TARGET_CHAT_ID: 'YOUR_THREAD_ID',

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

    // Small status pill in the corner (click it to hide / show).
    SHOW_HUD: true,
  };

  /* ===================================================================================
   * 2. INTERNALS
   * =================================================================================== */

  const DB = String(CONFIG.FIREBASE_DB_URL).replace(/\/+$/, '');
  const LOG = (...a) => console.log('%c[relay]', 'color:#A800FF;font-weight:700', ...a);
  const WARN = (...a) => console.warn('%c[relay]', 'color:#ff9f0a;font-weight:700', ...a);

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

  // ── tiny HUD ──────────────────────────────────────────────────────────────────────
  let hudEl = null;
  function hud(text, tone) {
    if (!CONFIG.SHOW_HUD) return;
    if (!hudEl) {
      hudEl = document.createElement('div');
      hudEl.id = 'ig-relay-hud';
      hudEl.setAttribute(
        'style',
        [
          'position:fixed', 'right:14px', 'bottom:14px', 'z-index:2147483000',
          'font:600 11.5px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
          'padding:7px 11px', 'border-radius:999px', 'letter-spacing:.2px',
          'background:rgba(18,18,18,.92)', 'color:#fff',
          'border:1px solid rgba(255,255,255,.14)',
          'box-shadow:0 6px 22px rgba(0,0,0,.5)', 'backdrop-filter:blur(8px)',
          'cursor:pointer', 'user-select:none', 'max-width:60vw',
          'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
        ].join(';')
      );
      hudEl.title = 'IG Relay — click to hide';
      hudEl.addEventListener('click', (e) => {
        if (e.altKey) { hudEl.remove(); hudEl = null; }
      });
      document.documentElement.appendChild(hudEl);
    }
    if (text === STATE.lastHudText) return;
    STATE.lastHudText = text;
    hudEl.textContent = text;
    hudEl.style.color = tone === 'warn' ? '#ffd60a' : tone === 'bad' ? '#ff6961' : '#fff';
  }

  /* ===================================================================================
   * 3. HTTP LAYER (GM_xmlhttpRequest first — Instagram's CSP can block page fetches)
   * =================================================================================== */

  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest(
        Object.assign({}, opts, {
          onload: (r) => resolve(r),
          onerror: () => reject(new Error('network error')),
          ontimeout: () => reject(new Error('timeout')),
          onabort: () => reject(new Error('abort')),
        })
      );
    });
  }

  const hasGM = typeof GM_xmlhttpRequest === 'function';

  async function fbRequest(method, path, body) {
    const url = DB + path;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json' };

    if (hasGM) {
      const r = await gmRequest({ method, url, headers, data: payload, timeout: 25000 });
      if (r.status >= 200 && r.status < 300) {
        return r.responseText ? JSON.parse(r.responseText) : null;
      }
      throw new Error('FB ' + r.status + ' ' + String(r.responseText).slice(0, 200));
    }
    const res = await fetch(url, { method, headers, body: payload, cache: 'no-store' });
    if (!res.ok) throw new Error('FB ' + res.status + ' ' + (await res.text()).slice(0, 200));
    const txt = await res.text();
    return txt ? JSON.parse(txt) : null;
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
   * 4. DOM HELPERS
   * =================================================================================== */

  function chatIdFromUrl() {
    const m = location.pathname.match(/\/direct\/t\/(\d+)/);
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
    // 1) prefer an explicitly labelled react button
    for (const el of row.querySelectorAll('[aria-label]')) {
      const label = el.getAttribute('aria-label') || '';
      if (!/react/i.test(label)) continue;
      const txt = (el.innerText || el.textContent || '').trim();
      const emoji = txt.match(REACTION_STRIP);
      if (emoji && emoji.length) return emoji.join('');
      const byLabel = label.match(REACTION_STRIP);
      if (byLabel && byLabel.length) return byLabel.join('');
    }
    // 2) heuristic: leaf node holding only 1–2 emoji, small box, outside message text
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
    // de-dupe adjacent identical spans (Instagram nests text spans)
    const out = [];
    parts.forEach((p) => { if (out[out.length - 1] !== p) out.push(p); });
    return out.join('\n').trim();
  }

  const IG_CONTENT_RE = /instagram\.com\/(reel|reels|p|tv)\//i;

  function extractReels(row) {
    const links = new Map(); // href -> thumb
    row.querySelectorAll('a[href]').forEach((a) => {
      const href = a.href || '';
      if (!IG_CONTENT_RE.test(href)) return;
      const img = a.querySelector('img');
      links.set(href.split('?')[0], img ? img.src : null);
    });
    // also catch a bare URL typed in the text
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

    // a text bubble that also holds a link (caption + reel preview)
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
      row,
      side,
      kind,
      text,
      sig,
      reaction,
      imgSrc,
      audioSrc,
      reel: reels[0] ? reels[0].url : null,
      reelThumbSrc,
    };
  }

  /* ===================================================================================
   * 5. SEQUENCE ALIGNMENT (catch-up without duplicates)
   * =================================================================================== */

  /**
   * Longest suffix of the Firebase tail that appears contiguously in the DOM sequence.
   * Everything after the match is "new" and gets pushed.
   *
   * Rank-aware: each element also carries its occurrence index for that signature, so
   * repeated messages ("ok", "lol", "😂") align to the right copy instead of the newest.
   * Robust to virtualised lists (scrolled-up history dropped from the DOM).
   */
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

    // Empty database → bootstrap the whole rendered history.
    if (!m) return { start: 0, k: 0, behind: false };
    // Nothing rendered → nothing to do.
    if (!n) return { start: 0, k: 0, behind: false };

    // ── 1. longest tail-suffix that appears contiguously in the DOM ──────────────
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

    // ── 2. anchored fallback: locate the newest relayed message in the DOM ──────
    // (covers a viewport that no longer holds the full tail, e.g. Instagram
    //  virtualising old rows). Everything rendered after it is new.
    const lastSig = tail[m - 1].sig;
    for (let i = n - 1; i >= 0; i--) {
      if (domSigs[i] === lastSig) return { start: i, k: 1, behind: false };
    }

    // ── 3. the newest relayed message is not on screen at all ──────────────────
    // The DOM is *behind* the database. Pushing now would duplicate the entire
    // visible history, so wait for the thread to render to the bottom instead.
    return { start: 0, k: 0, behind: true };
  }

  /* ===================================================================================
   * 6. FIREBASE SYNC
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
    // strip null/undefined — Firebase rejects undefined
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
   * 7. MAIN SCAN LOOP
   * =================================================================================== */

  async function scan() {
    if (!STATE.ready || STATE.scanning) return;

    const id = chatIdFromUrl();
    if (!id || id !== String(CONFIG.TARGET_CHAT_ID)) {
      if (!STATE.paused) { STATE.paused = true; LOG('paused — not the target thread'); }
      hud('⏸ Relay paused · open the target chat', 'warn');
      return;
    }

    const rows = getRows();
    if (!rows.length) {
      hud('⏳ Waiting for messages to render…', 'warn');
      return;
    }

    STATE.scanning = true;
    STATE.paused = false;
    try {
      const items = rows.map(extractRow);
      const domSigs = items.map((i) => i.sig);

      // ── 1. figure out what is new ──────────────────────────────────────────────
      /** Push everything rendered after the newest already-known message. */
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
          // Escape hatch: the newest relayed row may have been deleted or edited, which
          // would otherwise stall the relay forever. After a short settle period we
          // switch (stickily) to signature dedupe.
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

      // ── 2. push new messages sequentially (80ms apart → strict order) ─────────
      if (fresh.length) {
        hud('⬆️ Syncing ' + fresh.length + ' new message' + (fresh.length > 1 ? 's' : '') + '…');
        for (const item of fresh) {
          try {
            await pushItem(item);
          } catch (e) {
            WARN('push failed', e.message);
            await sleep(400);
          }
          await sleep(CONFIG.POST_DELAY_MS);
        }
      }

      // ── 3. reaction diff (PATCH only the changed message) ─────────────────────
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

      hud('🔴 Live · ' + STATE.wrote + ' relayed');
    } catch (e) {
      WARN('scan error', e);
      hud('⚠️ Relay error — see console', 'bad');
    } finally {
      STATE.scanning = false;
    }
  }

  /* ===================================================================================
   * 8. BOOT
   * =================================================================================== */

  function boot() {
    if (!/firebaseio\.com|firebasedatabase\.app/.test(DB) || DB.includes('YOUR-PROJECT-ID')) {
      hud('⚠️ Set FIREBASE_DB_URL in the userscript', 'bad');
      WARN('FIREBASE_DB_URL is not configured.');
      return;
    }
    if (/YOUR_THREAD_ID/.test(String(CONFIG.TARGET_CHAT_ID))) {
      hud('⚠️ Set TARGET_CHAT_ID in the userscript', 'bad');
      WARN('TARGET_CHAT_ID is not configured.');
      return;
    }

    hud('🔄 Loading Firebase history…');
    loadTail()
      .then(() => {
        STATE.ready = true;
        LOG('ready for thread', CONFIG.TARGET_CHAT_ID);
        scan();
      })
      .catch((e) => {
        WARN('could not load Firebase', e.message);
        hud('⚠️ Firebase unreachable (check rules/URL)', 'bad');
        // retry, but never push until we know what Firebase already has
        setTimeout(boot, 15000);
      });

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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();

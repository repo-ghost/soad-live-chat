# Orin ⇄ MD.Soad · Live read-only Instagram DM mirror

A public, **read-only** webpage that mirrors one Instagram Direct conversation in real time.

- **Bansafe by design** — no headless browser, no private API, no auto-login. A Tampermonkey
  userscript observes the DOM of a Chrome tab *you* are already logged into.
- **Firebase Realtime Database** (Spark free tier) carries the data.
- **GitHub Pages** serves a single `index.html` (free).

```
    Chrome tab (you, logged in)
    ┌───────────────────────────────┐
    │ instagram.com/direct/t/123     │
    │ ┌───────────────────────────┐ │        Firebase RTDB            GitHub Pages
    │ │  relay.user.js            │ │        (Spark free)             (index.html)
    │ │  reads rendered DOM       │─┼──────▶ messages/{key} ────────▶ read-only viewer
    │ │  POST 1500ms, PATCH react │ │        {side,text,img,…}        onChildAdded
    │ └───────────────────────────┘ │                                 onChildChanged
    └───────────────────────────────┘
```

---

## 1. Firebase Realtime Database rules

Create a project at <https://console.firebase.google.com> → **Build → Realtime Database →
Create Database** (pick a region, start in *locked mode*), then open the **Rules** tab and
paste this:

```json
{
  "rules": {
    "messages": {
      ".read": true,
      ".write": true,
      ".indexOn": ["ts"],
      "$message": {
        ".validate": "newData.hasChildren(['side','kind','sig','ts'])"
      }
    }
  }
}
```

**What each line does**

| Rule | Why |
|---|---|
| `.read: true` | anyone with the URL can *read* the mirror — this is the point |
| `.write: true` | lets the userscript POST/PATCH. Required, because the relay has no auth token |
| `.indexOn: ["ts"]` | keeps ordering queries fast as the thread grows |
| `.validate` | rejects junk writes that would break the viewer |

> ⚠️ **This is a public write endpoint.** Anyone who learns your database URL could add
> messages. That is the trade-off for not storing credentials in a userscript. Mitigations:
> it is a *display-only* mirror (nobody can reply from it), the `.validate` rule blocks
> malformed rows, and you can wipe the `messages` node at any time from the console.
> If you want it locked down harder, see [§6 Hardening](#6-optional-hardening).

Copy your database URL from the console header — it looks like
`https://<project-id>-default-rtdb.firebaseio.com/` (some regions add
`asia-southeast1`, `europe-west1`, … — **copy it exactly**).

---

## 2. Find your `TARGET_CHAT_ID`

1. In Chrome, open <https://www.instagram.com/direct/inbox/> and click **MD.Soad**.
2. Look at the address bar. It becomes:

   ```
   https://www.instagram.com/direct/t/340282366841710300949128137453831912254/
                            └──────────────┬──────────────────────────────┘
                                     TARGET_CHAT_ID
   ```

3. Copy **only the digits** (the trailing `/` is not part of it).

That number is the thread ID. The relay compares it to the URL on every scan, so opening
any other conversation pauses it immediately.

---

## 3. Install the userscript

1. Install the **Tampermonkey** extension in Chrome (or Violentmonkey).
2. Tampermonkey icon → **Create a new script**, delete the boilerplate, paste
   [`relay.user.js`](./relay.user.js).
3. Edit the two lines at the top:

   ```js
   FIREBASE_DB_URL: 'https://your-project-default-rtdb.firebaseio.com/messages',
   TARGET_CHAT_ID: '340282366841710300949128137453831912254',
   ```

4. **Ctrl/Cmd + S** to save. Open the Instagram thread — a small pill appears in the
   bottom-right corner:

   | Pill | Meaning |
   |---|---|
   | `🔄 Loading Firebase history…` | reading what is already stored |
   | `⬆️ Syncing N new messages…` | bootstrapping / catching up |
   | `🔴 Live · N relayed` | healthy, watching |
   | `⏸ Relay paused · open the target chat` | you are on a different thread |
   | `⏳ Waiting for the thread to catch up…` | DOM is behind the DB; it will resolve itself |

   Click the pill to hide it (Alt+click removes it until reload).

First run on an empty database **bootstraps the whole visible history**, 80 ms apart, so
message order is preserved. On later runs it diffs against the last synced message and only
pushes what you missed while offline.

---

## 4. Deploy `index.html` on GitHub Pages (≈2 minutes)

1. Push this folder to a GitHub repo (public).
2. Open `index.html` and set one line near the bottom:

   ```js
   const FIREBASE_CONFIG = {
     databaseURL: "https://your-project-default-rtdb.firebaseio.com"
   };
   ```

   (No other config needed — `ROOT` is already `"messages"`.)
3. Repo → **Settings → Pages** → *Source*: **Deploy from a branch** →
   Branch: **main**, folder: **/ (root)** → **Save**.
4. Wait ~1 minute. Your mirror is live at
   `https://<username>.github.io/<repo>/`.

### Profile pictures

Drop your photos into `icon/` using these exact names:

| File | Used for |
|---|---|
| `icon/soad-pfp.jpg` | the friend (header + every incoming bubble) |
| `icon/orin-pfp.jpg` | favicon + fallback |

Placeholder gradients are already committed, so the page looks finished before you upload.
Overwrite them — no code changes needed.

> **Until `databaseURL` is set**, the page runs in **demo mode** (a yellow "DEMO DATA" ribbon,
> simulated messages, working photo/reel/voice/reaction rendering). That is what you see on
> the preview right now. Replace the placeholder and it switches to live data automatically.

---

## 5. What the scraper records

Per rendered row in `div[role="row"]`:

| Field | Notes |
|---|---|
| `side` | `me` / `friend` — from `flex-direction: row-reverse`, with a geometry fallback |
| `kind` | `text` · `photo` · `reel` · `voice` |
| `text` | `innerText` of `[dir="auto"]`, UTF-8 emoji preserved |
| `img` | **downscaled & re-encoded to JPEG base64** (≤800 px, q `0.70`) — Instagram CDN links 403 after they expire, so bytes are stored, not URLs |
| `reel` / `reelThumb` | `/reel/`, `/reels/`, `/p/`, `/tv/` links + poster thumbnail (≤480 px, q `0.60`) |
| `audio` | voice notes inlined as base64 data URLs (clips over ~1.4 MB fall back to the raw URL) |
| `reactions` | emoji pill text (`❤️`, `😂`, `😮`…), `null` when removed |
| `sig` | content fingerprint used for de-duplication and catch-up alignment |
| `ts` | relay timestamp (ms) |

Reaction changes are detected on every scan and applied as a targeted
`PATCH /messages/{key}.json — {"reactions": "😮"}`, so the viewer updates one bubble
instead of re-rendering the chat.

---

## 6. Optional hardening

To make writes non-public without putting credentials in the userscript, move the relay to a
tiny proxy (Cloudflare Worker free tier) that holds a Firebase **auth token** and accepts
only POSTs with a secret header. Then set the rules to:

```json
{
  "rules": {
    "messages": {
      ".read": true,
      ".write": "auth != null && auth.token.admin === true"
    }
  }
}
```

and point `FIREBASE_DB_URL` at the Worker. Everything else stays identical.

---

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| Pill says *Set FIREBASE_DB_URL* | you left the placeholder in place |
| Pill says *Firebase unreachable* | wrong region URL, or `.write` is `false` in the rules |
| Viewer says *connection failed* | same — check `databaseURL` in `index.html` and the read rule |
| Photos show as "media unavailable" | the userscript could not fetch the image (expired/blocked). It falls back to the original URL; enable `GM_xmlhttpRequest` for `cdninstagram.com` |
| Reel thumbnails 403 | keep `<meta name="referrer" content="no-referrer">` in `<head>` (already set) |
| Duplicate-looking history | the relay only pushes rows it has not seen; a fresh bootstrap on an empty DB is expected to push everything once |
| Relay stops after switching chats | by design — reopen the target thread and it resumes automatically |

### How catch-up avoids duplicates

The relay keeps a short tail of `{key, sig}` pairs from Firebase, then finds the longest
suffix of that tail that appears **contiguously and in rank order** in the DOM. Everything
after the match is new. If the newest stored message is not on screen at all (virtualised
list, or you scrolled up), it waits rather than guessing — and after a few scans it switches
to sticky signature-based de-dupe so it can never stall forever.

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
> If you want it locked down harder, see [§6 Hardening](#6-optional-hardening) and [§7 Login gate](#7-login-gate).

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
| `icon/soad-pfp.jpg` | MD.Soad — header + every incoming bubble |
| `icon/orin-pfp.jpg` | Orin — favicon + fallback |

**Replacing a photo later?** GitHub Pages caches images hard, so simply overwriting the
file can keep showing the old one. Two steps fix it:

1. Overwrite `icon/soad-pfp.jpg` (keep the filename).
2. Bump `ICON_VERSION` in `index.html`:

   ```js
   const ICON_VERSION = "1";   // → "2", then 3, 4 …
   ```

That appends `?v=2` to every avatar URL, so browsers and the Pages CDN fetch the new file
immediately. To check a photo *without* redeploying, open the page with `?v=2` in the URL:

```
https://<username>.github.io/<repo>/?v=2
```

Square images work best (Instagram crops to a circle). ~240×240 px is plenty.

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

## 7. Login gate

The site now asks for a username and password before it renders the chat.

```
Username: live
Password: 5967
```

A signed-in visitor stays signed in for **12 hours** (per browser), then the gate returns.
The header has a **LOG OUT** chip that clears the session immediately.

Change the credentials any time:

```bash
node tools/make-login.js newuser newpass
```

Paste the two printed digests into the `AUTH` block near the top of `index.html`:

```js
const AUTH = {
  user: "27aenj-ykm3ed",   // ← digest of your username
  pass: "yowsi8-yjekao",   // ← digest of your password
  storageKey: "soadMirror.auth",
  sessionHours: 12,
};
```

Rules of thumb: usernames match **case-insensitively**, passwords are **case-sensitive**,
and both are trimmed of surrounding spaces.

### ⚠️ What this login actually protects — read this

`index.html` is a **static file served to every visitor**. Any check written inside it can be
read and bypassed by anyone who opens View Source. What this gate does:

| ✅ It does | ❌ It does not |
|---|---|
| Stops casual visitors from casually browsing the chat | Stop a determined person |
| Keeps the password out of plain sight (digests, not text) | Secure the Firebase data — the database URL is still in the file |
| Hides the chat from link-preview bots that don't run JS | Encrypt anything |
| Gives you a clean "private" front door | Act as identity or access control |

It also cannot stop someone from reading your Firebase **REST** endpoint directly
(`https://<project>-default-rtdb.firebaseio.com/messages.json`), because the rules in §1 are
public-read.

**If you want genuine privacy**, do this instead — it takes about five minutes:

1. Firebase console → **Authentication → Sign-in method → Email/Password → Enable**.
2. **Users → Add user**, e.g. `live@yourdomain.com` with password `5967`.
3. Set the database rules to require auth:

   ```json
   {
     "rules": {
       "messages": {
         ".read": "auth != null",
         ".write": true,
         ".indexOn": ["ts"]
       }
     }
   }
   ```

4. Keep this page's gate (it is a nice first screen), but add the Firebase Auth sign-in so the
   data itself is protected. The viewer already loads the SDK — swap the gate's `digest()`
   comparison for `signInWithEmailAndPassword()` and the database will refuse to serve data
   to anyone without a valid login, no matter what they edit in the page source.

The userscript keeps working either way, because its writes stay permitted by `.write: true`.

---

## 8. Running it from an Android phone (Firefox + Tampermonkey)

This setup is fully supported — the relay is designed to survive Android's aggressive
backgrounding.

### Setup checklist

| Step | What to do |
|---|---|
| 1 | Firefox for Android → menu → **Add-ons** → install **Tampermonkey** |
| 2 | Tampermonkey → **+** → paste `relay.user.js` → set `FIREBASE_DB_URL` and `TARGET_CHAT_ID` → **Save** |
| 3 | Tampermonkey → your script → **Settings** → confirm the `@connect` lines are intact (they let it talk to Firebase) |
| 4 | Instagram in Firefox → menu → **Request desktop site** → open the MD.Soad thread |
| 5 | Tap the pill in the bottom-right corner to open the **diagnostics panel** |

### Keep the tab alive

Android suspends background tabs, so the relay will pause when you switch apps — that is
intentional and lossless:

- Scans stop while the tab is hidden (`PAUSE_WHEN_HIDDEN`).
- The moment you return, it scans immediately and **catches up** from Firebase. Messages
  sent while you were away are relayed then, in order.

Two things you *should* change on the phone:

1. **Firefox → Settings → Data collection → turn OFF "Block trackers"** for `instagram.com`.
   Enhanced tracking protection can kill the extension's Firebase requests.
2. **Firefox → Settings → Advanced → keep the Instagram tab available** (or use
   *Add to Home screen* on the thread). Avoid "Close tabs on exit".

> ⚠️ **Do not lock the phone with Chrome/Firefox in the background expecting live sync.**
> Nothing on Android runs reliably when the screen is off. The mirror updates whenever the
> tab is open and awake, then catches up when you come back. That is the honest limit of a
> phone-only setup — a cheap always-on PC is the only way to get true 24/7.

### Verifying it really syncs (from the phone)

1. Open the thread, **Request desktop site**, wait for the pill to read
   `🔴 Live · N relayed`.
2. **Tap the pill** — the panel must show:
   - `match : YES`
   - `transport : GM_xmlhttpRequest ✓`
   - `last HTTP : 200`
   - `rows found` greater than 0
3. Ask MD.Soad to send a message. Within ~2s `relayed` should increase.
4. Open your Pages URL in another tab → sign in → the message is there.
5. Confirm in the Firebase console: **Realtime Database → Data** shows a `messages` node
   with children.

### If the pill shows an error, the panel tells you exactly what to fix

| Panel says | Fix |
|---|---|
| `last HTTP : 401/403` | rules block reads → set `.read: true` and Publish |
| `last HTTP : 404` | wrong database URL (region!) — copy it from the console header |
| `No connection to Firebase` | tracker blocking, or the `@connect` lines are missing |
| `transport : fetch (GM failed — blocked?)` | Tampermonkey's `GM_xmlhttpRequest` was blocked; re-install the script so `@grant` applies |
| `FIREBASE_DB_URL still has the placeholder` | you have not pasted your real project URL |
| `rows found : 0` | desktop-site mode is off, or the thread has not finished loading — scroll up and down once |

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| Pill says *Set FIREBASE_DB_URL* | you left the placeholder in place |
| Pill says *Firebase unreachable* | wrong region URL, or `.write` is `false` in the rules |
| Viewer says *connection failed* | same — check `databaseURL` in `index.html` and the read rule |
| Photos show as "media unavailable" | the userscript could not fetch the image (expired/blocked). It falls back to the original URL; enable `GM_xmlhttpRequest` for `cdninstagram.com` |
| Reel thumbnails 403 | keep `<meta name="referrer" content="no-referrer">` in `<head>` (already set) |
| Duplicate-looking history | the relay only pushes rows it has not seen; a fresh bootstrap on an empty DB is expected to push everything once |
| Relay stops after switching chats | by design — reopen the target thread and it resumes automatically |
| **New profile photo does not appear** | GitHub Pages cached the old bytes — bump `ICON_VERSION` in `index.html` (see [§4](#profile-pictures)), then hard-refresh with Ctrl/Cmd+Shift+R |
| **Forgot the login** | regenerate with `node tools/make-login.js <user> <pass>` and commit (see [§7](#7-login-gate)) |
| **Gate won't accept the right password** | passwords are case-sensitive and it must be the *digest* you pasted — re-run `node tools/make-login.js` to be sure |

### How catch-up avoids duplicates

The relay keeps a short tail of `{key, sig}` pairs from Firebase, then finds the longest
suffix of that tail that appears **contiguously and in rank order** in the DOM. Everything
after the match is new. If the newest stored message is not on screen at all (virtualised
list, or you scrolled up), it waits rather than guessing — and after a few scans it switches
to sticky signature-based de-dupe so it can never stall forever.

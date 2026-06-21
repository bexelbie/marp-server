# marp-server

A HedgeDoc companion that mirrors notes to [Marp](https://marp.app/) and serves
live, auto-reloading slide previews. Edit a `marp: true` note in HedgeDoc and the
rendered deck updates in your browser within a couple of seconds — no manual
export, no save button.

## How it works

`sync.js` runs a small HTTP server on `PORT` (8080) that does three jobs:

1. **Mirrors notes from HedgeDoc.** For each watched note it opens a Socket.IO
   connection to HedgeDoc and writes the note's markdown to
   `DATA_DIR/{noteId}.md`:
   - On watch it first does an immediate HTTP `GET /{noteId}/download` so the
     file exists right away, independent of the socket handshake.
   - The `doc` event (full content on connect) and `operation` events (one per
     edit) drive subsequent updates. `operation` events are debounced by
     `SETTLE_MS` (default 2s): a re-fetch fires only after typing settles, so
     HedgeDoc isn't hammered on every keystroke.
2. **Runs Marp in server mode** (`marp -s -I /data ...`) on `MARP_PORT` (8081),
   watching `DATA_DIR`. When a mirrored file changes, Marp re-renders it and
   pushes a reload to connected browsers.
3. **Reverse-proxies** browser traffic from 8080 to Marp on 8081, including the
   WebSocket upgrade that carries Marp's live-reload signal (see below).

### The live-reload chain

```
you edit in HedgeDoc
  → Socket.IO `operation` event → sync.js (debounced SETTLE_MS)
  → GET /{noteId}/download → write DATA_DIR/{noteId}.md
  → Marp file watcher re-renders
  → Marp pushes "reload" over its WebSocket
  → (proxied through sync.js) → browser location.reload()
```

If any link breaks, `podman logs marp-server` shows where: `connected`,
`initial sync`, and `synced` (per edit) lines come from sync.js; `... processed.`
lines come from Marp.

### Authentication

HedgeDoc's Socket.IO handshake rejects connections without a valid **signed
session cookie**, even for public notes (origin/CSRF guard — login is *not*
required). On watch, sync.js fetches a session cookie from HedgeDoc over HTTP and
replays it in the socket handshake.

Because HedgeDoc marks that cookie `Secure` when deployed behind HTTPS, it only
issues it when it believes the connection is secure. sync.js therefore sends
`X-Forwarded-Proto: https` on the cookie-fetch and handshake requests (HedgeDoc
runs with `trust proxy` enabled), so the internal plain-HTTP call still gets a
cookie.

### Raw HTML

Marp is run with `--html`, so inline HTML in slides (e.g. `<div style="...">`
column layouts, sized `<img>` tags) renders as authored. Note this allows any
HTML/JS in a watched note to execute in the preview — acceptable here because the
notes are your own, but broader than markdown-only rendering.

### Static assets

Any request whose path maps to a real file under `DATA_DIR` is served directly
with the correct `Content-Type` (with path-traversal protection); `.md` requests
are always rendered by Marp. Put images and other assets in `DATA_DIR/assets/`
(e.g. `marp-data/assets/logo.svg`) and reference them from slides as
`assets/logo.svg`.

### Uploads

HedgeDoc's filesystem uploads are served same-origin from `UPLOADS_DIR` at
`/uploads/<file>` (same traversal protection and MIME handling as static
assets). Mount HedgeDoc's `uploads` directory read-only to `UPLOADS_DIR` so an
image inserted via HedgeDoc (which references `/uploads/<file>`) resolves in the
preview.

## Usage

### Watch a note

```
http://marp-server:8080/watch/{noteId}
```

Starts mirroring and redirects to `/{noteId}.md`, the live Marp preview. The note
must have `marp: true` in its YAML frontmatter. Direct hits to `/{noteId}.md` for
an un-watched note also lazily start a watch (handy after a restart).

### Index page

```
http://marp-server:8080/
```

Lists currently-watched notes with last-hit times and a form to watch a new note.

### Download bundle

```
http://marp-server:8080/{noteId}/bundle.tar.gz
```

Streams a gzipped tar of the deck markdown plus every locally-referenced
`uploads/*` and `assets/*` file and the deck's theme CSS, with entry paths
mirroring the references so that extracting and running `marp {noteId}.md`
locally resolves everything. Remote, `data:`, and backslash references are
skipped. If the deck uses a theme note (see Themes), that note is fetched from
HedgeDoc at bundle time so the archive is self-contained.

### Stop watching a note

```
http://marp-server:8080/unwatch/{noteId}
```

Closes the socket and removes the mirrored file. Notes idle longer than `TTL_MS`
are unwatched automatically.

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `HEDGEDOC_URL` | `http://localhost:3000` | HedgeDoc base URL (internal address) |
| `SETTLE_MS` | `2000` | Debounce delay after edits (ms) |
| `TTL_MS` | `86400000` | Unwatch after this many ms idle (default 24h) |
| `NOTE_ID` | _(none)_ | Optional: pre-warm one note on startup |
| `PORT` | `8080` | Management/proxy port (browser-facing) |
| `MARP_PORT` | `8081` | Internal Marp server port |
| `DATA_DIR` | `/data` | Directory for per-note markdown + assets |
| `UPLOADS_DIR` | `/uploads` | HedgeDoc uploads dir, served at `/uploads/*` (mount read-only) |
| `THEMES_DIR` | `/themes` | Baked theme `.css` files (mount read-only) |
| `THEME_NOTES_DIR` | `/theme-notes` | Ephemeral dir where theme notes are mirrored as `.css`; created writable in the image, no mount needed |

The image seeds `DATA_DIR/placeholder.md` so Marp's server mode starts cleanly on
an otherwise empty directory.

## Themes

Mount a directory of `.css` theme files to `/themes` (read-only). When at least
one `.css` is present, sync.js starts Marp with `--theme-set /themes` and logs
which files it found (and notes when theme-set is disabled). Reference a theme in
frontmatter with `theme: your-theme-name`.

Each custom theme CSS **must** begin with a matching name comment, e.g.:

```css
/* @theme flatcar */
```

If the comment is missing or doesn't match the `theme:` value, Marp silently
falls back to the default theme.

### Themes from a note

Instead of baking a theme into the image, a deck can source its theme from a
separate HedgeDoc note whose entire body is the theme CSS. In the deck
frontmatter declare both keys:

```yaml
theme: my-theme
marpThemeNote: AbCdEf012-_
```

`marpThemeNote` is the **note id** of the CSS note (not an alias). marp-server
watches that note like a deck and mirrors its body to
`THEME_NOTES_DIR/<NAME>.css`, where `<NAME>` comes from the note's
`/* @theme NAME */` comment and must match the deck's `theme:` value. Edits to
the theme note hot-reload the preview. `THEME_NOTES_DIR` is always added to
Marp's `--theme-set` (alongside `/themes` when present), so a CSS file written
at runtime is registered without a restart.

A theme note is kept alive while a referencing deck is active and is stopped
once no deck references it (on theme-note change, deck unwatch, or idle TTL).
The CSS note does **not** need `marp: true`; it is never rendered as slides.

## Deployment (podman quadlet)

See `marp-server.container` in the [vpn-config](https://github.com/bexelbie/vpn-config)
resources. The service starts and stops with HedgeDoc and shares its network so
`HEDGEDOC_URL=http://hedgedoc:3000` resolves. Mount `marp-data` to `/data`, a
themes directory to `/themes` (read-only), and HedgeDoc's `uploads` directory to
`/uploads` (read-only). `/theme-notes` needs no mount — it's created writable in
the image and holds only ephemeral, rebuilt-on-demand theme CSS.

The container is stateless: mirrored `.md` files and theme-note `.css` are rebuilt
on demand, so a hard restart (even SIGKILL) loses nothing. marp-server persists
nothing of its own — only the hand-maintained `marp-data` and `themes` mounts
hold durable content.

## HedgeDoc integration

A "Marp Preview" entry in the HedgeDoc editor's extra menu opens the live preview
directly. It checks for `marp: true` frontmatter and opens
`{marpServerURL}/watch/{noteId}`. A companion "Marp Download" entry opens
`{marpServerURL}/{noteId}/bundle.tar.gz` to download the self-contained deck
bundle. The target URL comes from a
`<meta name="marp-server-url" content="...">` tag (injected via the bind-mounted
`header.ejs`), falling back to `window.marpServerURL` then `http://localhost:8080`.

This requires both the `header.ejs` bind-mount (buttons + meta tag) and the
JavaScript baked into the HedgeDoc image (`ghcr.io/bexelbie/hedgedoc-bex`).


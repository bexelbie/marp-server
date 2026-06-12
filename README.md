# marp-server

A HedgeDoc companion that syncs notes to [Marp](https://marp.app/) and serves live slide previews.

## How it works

- Connects to HedgeDoc via Socket.IO
- On connect, fetches the full note immediately (`doc` event)
- On edits, waits for typing to settle (`SETTLE_MS`, default 2s) then fetches fresh markdown
- Serves all watched notes as Marp presentations via a built-in reverse proxy
- Unwatches notes idle for longer than `TTL_MS` (default 24h)

## Usage

### Watch a note

Navigate to:
```
http://marp-server:8080/watch/{noteId}
```

You'll be redirected to the live Marp preview. The note must have `marp: true` in its YAML frontmatter.

### Index page

```
http://marp-server:8080/
```

Lists all currently-watched notes with last-hit times and a form to start watching a new note.

### Stop watching a note

```
http://marp-server:8080/unwatch/{noteId}
```

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `HEDGEDOC_URL` | `http://localhost:3000` | HedgeDoc base URL |
| `SETTLE_MS` | `2000` | Debounce delay after edits (ms) |
| `TTL_MS` | `86400000` | Unwatch after this many ms idle (default 24h) |
| `NOTE_ID` | _(none)_ | Optional: pre-warm one note on startup |
| `PORT` | `8080` | Management/proxy port |
| `MARP_PORT` | `8081` | Internal Marp server port |
| `DATA_DIR` | `/data` | Directory for per-note markdown files |

## Themes

Mount a directory of `.css` theme files to `/themes` (read-only). Marp will load them via `--theme-set /themes`. Reference them in your frontmatter with `theme: your-theme-name`.

## Deployment (podman quadlet)

See `marp-server.container` in the [vpn-config](https://github.com/bexelbie/vpn-config) resources. The service starts and stops with HedgeDoc.

## HedgeDoc integration

A "Marp Preview" button in the HedgeDoc editor extra menu opens the live preview directly. Requires the `header.ejs` bind-mount and the JS to be present in the HedgeDoc image (shipped in `ghcr.io/bexelbie/hedgedoc-bex`).


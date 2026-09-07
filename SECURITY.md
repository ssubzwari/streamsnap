# Security Policy

## Threat model — read this first

StreamSnap is **single-user and has no authentication, by design.** It is meant to
run on a trusted private network, or behind a reverse proxy / VPN / SSO that does the
authentication for it. This mirrors [MeTube](https://github.com/alexta69/metube)'s model.

Because of that model, the following are **known and expected**, not vulnerabilities:

- Any client that can reach the port has full control of the app (add/cancel downloads,
  change settings, read notification-channel config, back up / restore / wipe the database).
- Endpoints that run a process or touch the host filesystem are intentional:
  the yt-dlp updater (`POST /api/settings/update-ytdlp`), "reveal in file manager"
  (`GET /api/downloads/{id}/open`), and the raw `YoutubeDL` options escape hatch.
- yt-dlp `username` / `password` and all notification-channel credentials are stored in
  the SQLite database in plaintext. **A database backup file is a full credential dump —
  treat it as a secret.**
- `CORS_ORIGINS` defaults to allowing any origin for the WebSocket. Set it to an explicit
  list if the instance is reachable from an untrusted network.

Do **not** expose an unauthenticated StreamSnap instance directly to the internet.

## What *is* a vulnerability

Anything that breaks the model above, for example:

- Reading secrets or reaching the host **from another web origin** (a page the user
  visits making requests to their StreamSnap instance and getting data back)
- Path traversal / arbitrary file read or write beyond the download and backup dirs
- A crafted URL, playlist, or setting that leads to code execution outside the documented
  yt-dlp surface
- Leaking secrets into logs, WebSocket events, or the UI in a way the redaction layer misses

## Reporting

Please report suspected vulnerabilities **privately** via GitHub's
[private vulnerability reporting](https://github.com/ssubzwari/streamsnap/security/advisories/new)
(Security → Report a vulnerability), not as a public issue.

Include a description, affected version / image tag, and a proof of concept if you have one.
There is no bug bounty — this is a hobby project — but fixes and credit are appreciated.

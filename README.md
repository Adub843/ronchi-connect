# Ronchi Connect

Remote support for Ronchi America. A customer opens the app, reads a 9-digit
code to a Ronchi technician and clicks **Allow**. The technician then sees the
customer's screen and can control it, transfer files and chat, while the team
can see who is online, message and call each other, and flag for help.

This is Ronchi's own software: original code, no per-seat subscription.

## What is in this repository

| Folder | What it is | Stack |
| --- | --- | --- |
| `desktop/` | The app customers and technicians install (Windows, macOS, Linux) | Electron, plain JavaScript, WebRTC |
| `server/` | Server the apps connect to: support codes, consent, accounts, team features, audit log. Also serves the website. | Node.js, Express, `ws` |
| `website/` | Public download page | Static HTML/CSS/JS |
| `brand/` | Logo, colours, machine photos, default server address | JSON and images |
| `deploy/` | Docker setup for the server, HTTPS and the relay | Docker Compose, Caddy, coturn |
| `docs/` | How it works, the message protocol, security notes, roadmap | Markdown |

There is no build step and no framework to learn: the code that is in the
folders is the code that runs.

## Try it on one computer

```bash
# 1. Server (also serves the website at http://localhost:8080)
cd server
npm install
ADMIN_PASSWORD="choose-a-long-password" npm start

# 2. Desktop app, in a second terminal
cd desktop
npm install
RONCHI_SERVER_URL=ws://localhost:8080/ws npm start
```

On Windows PowerShell use `$env:ADMIN_PASSWORD="..."; npm start` and
`$env:RONCHI_SERVER_URL="ws://localhost:8080/ws"; npm start`.

The app opens on the customer screen with a support code. Click
**Technician sign-in** and sign in as `admin` to reach the console; add
technicians under **Team**. To try a full session on one machine, start a
second copy with `RONCHI_ALLOW_MULTIPLE=1` and a separate
`RONCHI_USER_DATA=<some folder>`.

## Tests

```bash
cd server && npm test                 # 19 protocol and security tests
cd desktop && npm run test:e2e        # full session with three app copies
```

On a Linux machine without a display, run the second one as
`xvfb-run -a -s "-screen 0 1440x900x24" npm run test:e2e`.

## Going live

1. Put the server on a small Linux machine: [deploy/README.md](deploy/README.md).
2. Set `serverUrl` in [brand/brand.json](brand/brand.json) to `wss://<your domain>/ws`.
3. Build installers: push a tag like `v0.1.0` and GitHub Actions builds the
   Windows, macOS and Linux installers (or run `npm run dist` in `desktop/`
   on each platform).
4. Copy the installers into `deploy/downloads/` on the server. The website
   offers them automatically.

Code signing (so Windows and macOS do not warn customers) is described in
[docs/SECURITY.md](docs/SECURITY.md#code-signing).

## Where to look when changing something

| I want to change… | Look in |
| --- | --- |
| Name, logo, colours, background photos | `brand/` |
| What the customer sees | `desktop/src/renderer/js/customer-view.js` |
| The consent prompt | `askConsent` in `customer-view.js` |
| The technician console | `desktop/src/renderer/js/tech-console.js` |
| The remote view and its toolbar | `desktop/src/renderer/js/remote-session.js` |
| Screen sharing and what the customer side allows | `desktop/src/renderer/js/host-controller.js` |
| Mouse and keyboard injection | `desktop/src/main/input.js` |
| Chat, flags, calls | `team-ui.js`, `calls.js`, and `server/src/team.js` |
| Session rules (codes, consent, audit log) | `server/src/sessions.js` |
| Accounts and passwords | `server/src/auth.js` |
| A new message between app and server | `docs/PROTOCOL.md`, then a handler in `server/src/` |

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

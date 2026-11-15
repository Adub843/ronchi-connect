# How Ronchi Connect works

## The pieces

```
 Customer PC                         Ronchi server                      Technician PC
┌────────────────┐   WebSocket    ┌──────────────────┐   WebSocket   ┌────────────────┐
│ Desktop app    │◄──────────────►│ server (Node.js) │◄─────────────►│ Desktop app    │
│ (customer view)│  small control │ codes, consent,  │ small control │ (console)      │
│                │  messages      │ accounts, team   │ messages      │                │
│                │                └──────────────────┘               │                │
│                │                                                   │                │
│                │◄═════════════ WebRTC, encrypted end to end ══════►│                │
│                │  screen video, mouse/keyboard, files, voice       │                │
└────────────────┘        direct, or through the relay (coturn)      └────────────────┘
```

* The **server** only passes small JSON messages: "this technician wants to
  connect", "the customer said yes", chat text, and the handshake that lets
  the two computers find each other. It never sees screen contents, keystrokes
  or files.
* The **WebRTC connection** carries everything heavy. It is encrypted between
  the two computers (DTLS-SRTP). It goes directly when the networks allow;
  otherwise the same encrypted traffic is passed through the **relay**
  (coturn), which cannot read it. This is the "tunneling" that lets it work
  through firewalls without opening any inbound ports at the customer's plant.

## A session, step by step

1. The customer's app connects to the server and gets a random 9-digit code.
2. The technician types the code. The server checks they are signed in and
   that the code exists (wrong guesses are rate limited).
3. The server tells the customer's app who is asking. The app shows the
   consent prompt. Until **Allow** is clicked nothing else happens.
4. On Allow, the customer's app starts capturing the screen and opens a WebRTC
   connection to the technician. The red banner appears and stays on top.
5. The technician's mouse and keyboard events travel over a WebRTC data
   channel and are replayed on the customer's computer, if control is allowed.
6. Either side ends the session. The server writes an audit record and gives
   the customer's app a new code.

## Desktop app layout

Electron apps have two halves, and the split matters for security:

* **Main process** (`desktop/src/main/`) is the only part that can touch the
  computer: capture the screen, move the mouse, read and write files. It
  enforces the safety rules itself (no capture or input without an approved
  session), so a bug in the window cannot bypass them.
  * `main.js` windows, banner, tray, the list of things the window may ask for
  * `input.js` mouse and keyboard injection (nut.js)
  * `files.js` saving received files, reading files the person picked
  * `settings.js` brand loading, saved server address and sign-in token
  * `preload.js` the small API the window sees as `window.ronchi`
* **Window** (`desktop/src/renderer/`) holds the screens and the WebRTC logic.
  It is plain JavaScript modules loaded straight by the browser engine.
  * `app.js` start-up, chooses which screen to show
  * `connection.js` WebSocket to the server with reconnect
  * `host-controller.js` customer side of a session (no UI)
  * `customer-view.js` customer screen and the consent prompt
  * `tech-client.js` signed-in technician state
  * `tech-console.js` console, history, team admin
  * `remote-session.js` live view, input capture, toolbar, side pane
  * `team-ui.js`, `calls.js` chat, flags, invitations, voice
  * `file-transfer.js` files over a data channel
  * `ui.js`, `brand.js` shared helpers

One installer serves both audiences. It opens on the customer screen;
technicians click **Technician sign-in**. Start with `--technician` to open
the sign-in screen directly (useful for a separate desktop shortcut).

## Server layout

`server/src/`

* `index.js` entry point, `app.js` builds the HTTP server
* `hub.js` WebSocket connections, message routing, sign-in, presence
* `sessions.js` codes, consent, signaling relay, audit log
* `team.js` chat, flags, calls
* `admin.js` account management for administrators
* `auth.js` password hashing, tokens, rate limiting
* `store.js` the only file that reads and writes data files
* `ice.js` STUN/TURN settings handed to the apps
* `cli.js` account management from the command line

Data is stored as JSON files in `DATA_DIR`. That is intentional: a support
team is small, and files are easy to back up and inspect. To move to a
database later, re-implement `store.js`; nothing else touches the disk.

## Adding a feature: the usual path

1. Decide the message(s): name them and add them to `docs/PROTOCOL.md`.
2. Add a handler with `hub.on('my.message', 'tech', handler)` in the matching
   server file, and a test in `server/test/server.test.js`.
3. In the app, send it with `conn.request('my.message', {...})` and listen
   for server events with `conn.on('my.event', ...)`.
4. If it needs the operating system, add one function to `preload.js` and its
   handler in `main.js`.

## Platform notes

* **Windows**: works out of the box. Controlling UAC prompts and the lock
  screen needs a Windows service, which is on the roadmap.
* **macOS**: the first session asks the user to allow Screen Recording and
  Accessibility in System Settings (a macOS rule for all remote tools).
* **Linux**: X11 is supported. Wayland sessions limit capture and input.

# Security

Written for customer IT and plant security teams, and for whoever maintains
this code.

## What protects the customer

| Protection | How it is done | Where in the code |
| --- | --- | --- |
| Explicit consent | Nothing is captured or sent until the person clicks Allow on a prompt naming the technician. The prompt has no default button and times out. | `customer-view.js`, `sessions.js` |
| Each person approved | A second technician needs their own approval from the customer. | `sessions.js` (`joinInvited`) |
| Always-visible indicator | A red always-on-top banner for the whole session. Closing it ends the session. | `main.js` (`showBanner`) |
| Instant stop | End session button, or Ctrl+Alt+Shift+X from anywhere. | `main.js`, `host-controller.js` |
| View-only and pause | The customer can refuse or pause control; input is dropped in two places. | `host-controller.js`, `input.js` |
| No standing access | The app must be open, the code is random, and it is replaced after every session. No unattended access exists in this version. | `hub.js` (`assignHostCode`) |
| Codes are useless to outsiders | Only signed-in technicians can use a code; wrong guesses are rate limited. | `sessions.js` |
| End-to-end encryption | WebRTC (DTLS-SRTP) between the two computers. The server and relay never see screen, input or files. | WebRTC built into Electron |
| Encrypted control channel | The app talks to the server over WSS (TLS). | `deploy/Caddyfile` |
| Outbound only | The customer's computer makes outbound connections only. No inbound firewall ports are opened at the plant. | by design |
| Audit trail | Every approved session is logged: who, when, which computer, permissions, notes, chat. | `store.js` (`sessions.jsonl`) |
| Safe file handling | Received files go to one folder; names are sanitised; file transfer needs the customer's permission. | `files.js` |
| Operating system enforcement | Capture and input are gated in the main process, not just the user interface. | `main.js` |

## What protects technician accounts

* Passwords are hashed with scrypt and a per-user salt; minimum 10 characters.
* Sign-in tokens are random 256-bit values, stored only as hashes on the
  server, and encrypted with the OS keychain on the technician's computer.
* Failed sign-ins are rate limited per address.
* Changing a password signs that user out everywhere. Removing a user
  disconnects them immediately.

## What the relay can and cannot do

The relay (coturn) forwards encrypted packets when a direct path is not
possible. It has no keys and cannot read sessions. It is configured to refuse
relaying into private address ranges, and its credentials are short lived and
derived from a secret that never leaves the server.

## Network requirements at the customer site

Outbound HTTPS (TCP 443) to the Ronchi Connect domain. For the media path,
outbound UDP is best; if only TCP is allowed the relay is used on TCP 3478.

## Known limits of this version

* No multi-factor sign-in for technicians yet (roadmap).
* No unattended access. That is a deliberate choice for now.
* UAC prompts and the Windows lock screen cannot be controlled yet.
* Session records are kept in a file on the server; restrict who can log in
  to that machine and back the folder up.

## Code signing

Unsigned installers make Windows SmartScreen and macOS Gatekeeper warn the
customer. To sign:

* **Windows**: an OV or EV code-signing certificate, or Azure Trusted Signing
  (about $10 a month). Add the certificate to the repository's GitHub secrets
  as `CSC_LINK` (base64 `.pfx`) and `CSC_KEY_PASSWORD`.
* **macOS**: an Apple Developer account ($99 a year). Add `CSC_LINK`,
  `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
  `APPLE_TEAM_ID`.

The build workflow picks these up automatically.

## Reporting a problem

Treat anything that lets a session start without consent, hides the banner,
or lets a non-technician use a code as critical.

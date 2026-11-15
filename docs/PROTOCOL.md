# Message protocol

The desktop app talks to the server over one WebSocket at `/ws`. Every message
is a JSON object with a `type`.

* **Requests** from the app include a `reqId`. The server answers with
  `{ "type": "reply", "reqId": ..., "ok": true, ...result }` or
  `{ "type": "reply", "reqId": ..., "ok": false, "error": { "code", "message" } }`.
* **Events** are pushed by the server and have no `reqId`.

"Who" below is the role the connection must have: **host** is a customer
computer, **tech** is a signed-in technician, **admin** is a technician with
the administrator role, **any** needs no role.

## Requests

### Getting started
| Type | Who | Fields | Result |
| --- | --- | --- | --- |
| `ping` | any | | |
| `host.register` | any | `deviceName`, `os`, `appVersion` | `code`, `iceServers` |
| `host.newCode` | host | | `code`, `iceServers` |
| `auth.login` | any | `username`, `password` | `user`, `token`, `peerId`, `iceServers`, `team` |
| `auth.resume` | any | `token` | same as `auth.login` |
| `auth.logout` | tech | | |
| `account.changePassword` | tech | `current`, `next` | `token` |
| `status.set` | tech | `status`: `available`, `busy` or `away` | |

### Remote sessions
| Type | Who | Fields | Result |
| --- | --- | --- | --- |
| `session.connect` | tech | `code` | `sessionId`, `host` (then wait for `session.started` or `session.denied`) |
| `session.join` | tech | `sessionId` (must have been invited or flagged) | as above |
| `session.cancel` | tech | | |
| `session.consent` | host | `peerId`, `accept`, `permissions: { control, files }` | |
| `session.permissions` | host | `permissions` | `permissions` |
| `session.invite` | tech | `to` (user id) | |
| `session.leave` | tech | | |
| `session.end` | any | | host: ends for everyone. tech: same as leave |
| `session.chat` | any | `text` | |
| `session.notes` | tech | `text` | |
| `signal` | any | host: `to` (peer id), `data`. tech: `data` | |
| `history.list` | tech | | `sessions` |

### Team
| Type | Who | Fields | Result |
| --- | --- | --- | --- |
| `chat.send` | tech | `to`, `text` | `message` |
| `chat.history` | tech | `with` | `messages` |
| `flag.send` | tech | `to` (user id or `"all"`), `message` | `flag`, `delivered` |
| `flag.respond` | tech | `to`, `flagId`, `response`: `coming` or `busy` | |
| `call.invite` | tech | `to` | `callId` |
| `call.answer` | tech | `callId`, `accept` | |
| `call.signal` | tech | `callId`, `data` | |
| `call.end` | tech | `callId` | |

### Administration
| Type | Who | Fields | Result |
| --- | --- | --- | --- |
| `admin.users.list` | admin | | `users` |
| `admin.users.create` | admin | `username`, `name`, `password`, `role` | `user` |
| `admin.users.setPassword` | admin | `id`, `password` | |
| `admin.users.remove` | admin | `id` | |

## Events

| Type | Sent to | Fields | Meaning |
| --- | --- | --- | --- |
| `host.code` | host | `code`, `iceServers` | A new support code (at start and after every session) |
| `presence` | tech | `team` | Team list with `online`, `status`, `inSessionWith` |
| `session.request` | host | `sessionId`, `peer`, `timeoutSeconds` | A technician asks to connect: show the consent prompt |
| `session.requestClosed` | host | `peerId`, `reason` | That request went away (cancelled, timed out) |
| `session.started` | tech | `sessionId`, `host`, `permissions`, `peers`, `notes`, `chat` | The customer allowed it |
| `session.denied` | tech | `reason`: `declined`, `timeout`, `cancelled`, `ended` | |
| `session.techJoined` | host | `peer` | Start the WebRTC offer to this technician |
| `session.techLeft` | host | `peerId`, `name`, `reason` | |
| `session.peerJoined`, `session.peerLeft` | tech | `peer` / `peerId`, `name` | Another technician joined or left |
| `session.permissions` | tech | `permissions` | The customer changed what is allowed |
| `session.chat` | everyone in session | `message` | |
| `session.notes` | other techs in session | `text`, `by` | |
| `session.invited` | tech | `sessionId`, `from`, `host` | A teammate invites you |
| `session.ended` | everyone in session | `reason` | |
| `signal` | host or tech | `from`, `data` | WebRTC handshake relay |
| `chat.message` | both technicians | `message` | |
| `flag.raised` | tech | `flag` | Show the help alert |
| `flag.response` | tech | `from`, `response` | |
| `call.incoming` | tech | `callId`, `from` | Ring |
| `call.accepted` | caller | `callId`, `by` | Start the WebRTC offer |
| `call.signal` | other party | `callId`, `data` | |
| `call.ended` | both | `callId`, `reason` | |

## Inside the WebRTC connection

The customer's app creates the connection with one video track and two data
channels.

**`control` channel** (JSON text)

| From | Message | Meaning |
| --- | --- | --- |
| customer | `{ t: "hello", displays, displayId, inputAvailable, platform }` | Sent when the channel opens |
| customer | `{ t: "display", id }` | The shared monitor changed |
| customer | `{ t: "clipboard", text }` | Answer to a clipboard request |
| technician | `{ t: "input", e }` | One input event (below) |
| technician | `{ t: "display", id }` | Show another monitor |
| technician | `{ t: "quality", level }` | `low`, `balanced` or `high` |
| technician | `{ t: "clipboard", text }` / `{ t: "clipboard-request" }` | Clipboard sync |
| technician | `{ t: "file-request" }` | Ask the customer to pick a file to send |

Input events: `{ k: "move", x, y }` (0 to 1 across the screen),
`{ k: "down" | "up", button }`, `{ k: "wheel", dx, dy }`,
`{ k: "keydown" | "keyup", code }` where `code` is a browser
`KeyboardEvent.code` such as `KeyA`.

**`files` channel**: `{ t: "start", id, name, size }`, then binary chunks,
then `{ t: "end", id }`. See `file-transfer.js`.

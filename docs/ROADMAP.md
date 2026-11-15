# Roadmap

## Done (version 0.1)

* Customer mode: one code, consent prompt, red banner, end session, view-only and pause
* Technician console: connect by code, live view, full mouse and keyboard control
* Multiple monitors, picture quality choice, send-keys menu, clipboard both ways, screenshots, full screen
* File transfer both ways
* Direct connection with automatic relay fallback
* Session chat with the customer, shared technician notes
* Team: presence and status, direct chat, flag for help, voice calls, invite a teammate into a session
* Session history and audit log, team administration
* Download website, Docker deployment, installer builds

## Next

1. **Windows service** so the technician can work through UAC prompts and the
   lock screen, and send Ctrl+Alt+Del.
2. **Automatic updates** (electron-updater) so customers and technicians stay current.
3. **Two-step sign-in** for technicians (authenticator app).
4. **Voice with the customer** inside a session, using the same call code.
5. **Session recording** to video, stored with the audit record, with the
   customer told on the consent prompt.
6. **Pointer and drawing tools** so the technician can point at things in
   view-only sessions.
7. **Machine address book**: named customer sites and lines, with history per machine.
8. **Unattended access** for machines the customer chooses to enrol, with
   per-machine approval and its own audit trail.
9. **Single sign-on** with Microsoft 365.
10. **Mobile viewer** for technicians on a phone or tablet.

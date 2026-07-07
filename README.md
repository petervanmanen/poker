# Ritense Planning Poker

A real-time planning poker webapp. Multiple users log in with a name and a
session name, then estimate together. While cards are face-down they show the
**Ritense logo**; hitting **Reveal** flips them and shows the average,
distribution, and a consensus badge.

## Run

```bash
npm install
npm start
```

Open http://localhost:3000 in several browser tabs (or share your LAN IP with
teammates). Everyone who enters the same **session name** joins the same table.

`npm run dev` runs with auto-reload.

## How it works

- **Backend** — `server.js`: Express serves the frontend, Socket.IO handles the
  real-time room state (in-memory, per session). Votes are never sent to other
  clients until the round is revealed.
- **Frontend** — `public/`: login screen, live table, and the estimation deck
  (`0 1 2 3 5 8 13 21 34 ? ☕`).

## Features

- Multi-user, multi-session real-time sync
- Face-down cards show the Ritense logo (`public/ritense-logo.svg`)
- Reveal / new-round controls available to everyone
- Average, vote distribution, and consensus detection
- Spectator mode (watch without voting)
- Refresh-safe: your name/room are remembered and you auto-rejoin

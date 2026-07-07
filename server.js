import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(join(__dirname, "public")));

// The estimation deck shown to every participant.
const DECK = ["0", "1", "2", "3", "5", "8", "13", "21", "34", "?", "☕"];

/**
 * rooms: Map<roomName, {
 *   revealed: boolean,
 *   members: Map<socketId, { name, vote, spectator }>
 * }>
 */
const rooms = new Map();

function getRoom(name) {
  if (!rooms.has(name)) {
    rooms.set(name, { revealed: false, members: new Map() });
  }
  return rooms.get(name);
}

// Build the state that is safe to broadcast. Votes stay hidden until revealed.
function buildState(roomName) {
  const room = rooms.get(roomName);
  if (!room) return null;

  const participants = [...room.members.entries()].map(([id, m]) => ({
    id,
    name: m.name,
    spectator: m.spectator,
    hasVoted: m.vote !== null,
    vote: room.revealed ? m.vote : null,
  }));

  const votes = [...room.members.values()]
    .filter((m) => !m.spectator && m.vote !== null)
    .map((m) => m.vote);

  return {
    deck: DECK,
    revealed: room.revealed,
    participants,
    stats: room.revealed ? computeStats(votes) : null,
  };
}

// Numeric average + consensus, ignoring non-numeric picks (? and ☕).
function computeStats(votes) {
  const numeric = votes
    .filter((v) => /^\d+$/.test(v))
    .map((v) => Number(v));

  const counts = {};
  for (const v of votes) counts[v] = (counts[v] || 0) + 1;

  const average =
    numeric.length > 0
      ? numeric.reduce((a, b) => a + b, 0) / numeric.length
      : null;

  const consensus = new Set(votes).size === 1 && votes.length > 1;

  return {
    total: votes.length,
    average: average === null ? null : Math.round(average * 10) / 10,
    counts,
    consensus,
  };
}

function broadcast(roomName) {
  const state = buildState(roomName);
  if (state) io.to(roomName).emit("state", state);
}

io.on("connection", (socket) => {
  socket.on("join", ({ name, room }) => {
    name = (name || "").toString().trim().slice(0, 40) || "Anonymous";
    room = (room || "").toString().trim().slice(0, 60) || "default";

    socket.data.room = room;
    socket.join(room);

    const r = getRoom(room);
    r.members.set(socket.id, { name, vote: null, spectator: false });

    socket.emit("joined", { id: socket.id, room });
    broadcast(room);
  });

  socket.on("vote", ({ value }) => {
    const room = socket.data.room;
    const r = rooms.get(room);
    if (!r) return;
    const m = r.members.get(socket.id);
    if (!m || m.spectator) return;
    // Clicking the same card again clears the vote.
    m.vote = m.vote === value ? null : value;
    broadcast(room);
  });

  socket.on("reveal", () => {
    const r = rooms.get(socket.data.room);
    if (!r) return;
    r.revealed = true;
    broadcast(socket.data.room);
  });

  socket.on("reset", () => {
    const r = rooms.get(socket.data.room);
    if (!r) return;
    r.revealed = false;
    for (const m of r.members.values()) m.vote = null;
    broadcast(socket.data.room);
  });

  socket.on("toggleSpectator", () => {
    const r = rooms.get(socket.data.room);
    if (!r) return;
    const m = r.members.get(socket.id);
    if (!m) return;
    m.spectator = !m.spectator;
    if (m.spectator) m.vote = null;
    broadcast(socket.data.room);
  });

  socket.on("disconnect", () => {
    const room = socket.data.room;
    const r = rooms.get(room);
    if (!r) return;
    r.members.delete(socket.id);
    if (r.members.size === 0) {
      rooms.delete(room);
    } else {
      broadcast(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Ritense Planning Poker running at http://localhost:${PORT}`);
});

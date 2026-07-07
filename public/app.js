const socket = io();

// ---- Elements ----
const loginEl = document.getElementById("login");
const sessionEl = document.getElementById("session");
const loginForm = document.getElementById("login-form");
const nameInput = document.getElementById("name-input");
const roomInput = document.getElementById("room-input");

const roomNameEl = document.getElementById("room-name");
const participantsEl = document.getElementById("participants");
const deckEl = document.getElementById("deck");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const revealBtn = document.getElementById("reveal-btn");
const resetBtn = document.getElementById("reset-btn");
const spectatorBtn = document.getElementById("spectator-btn");
const leaveBtn = document.getElementById("leave-btn");

let myId = null;
let myVote = null;
let amSpectator = false;

const LOGO = "ritense-logo.svg";

// ---- Restore from URL / storage so a refresh keeps you in the room ----
function prefill() {
  const params = new URLSearchParams(location.search);
  nameInput.value = localStorage.getItem("pp_name") || "";
  roomInput.value = params.get("room") || localStorage.getItem("pp_room") || "";
}
prefill();

// Auto-rejoin on refresh if we have both values.
if (nameInput.value && roomInput.value) {
  join(nameInput.value, roomInput.value);
}

loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  join(nameInput.value, roomInput.value);
});

function join(name, room) {
  name = name.trim();
  room = room.trim();
  if (!name || !room) return;
  localStorage.setItem("pp_name", name);
  localStorage.setItem("pp_room", room);
  const url = new URL(location);
  url.searchParams.set("room", room);
  history.replaceState({}, "", url);
  socket.emit("join", { name, room });
}

socket.on("joined", ({ id, room }) => {
  myId = id;
  roomNameEl.textContent = room;
  loginEl.classList.add("hidden");
  sessionEl.classList.remove("hidden");
});

socket.on("state", render);

// ---- Actions ----
revealBtn.addEventListener("click", () => socket.emit("reveal"));
resetBtn.addEventListener("click", () => {
  myVote = null;
  socket.emit("reset");
});
spectatorBtn.addEventListener("click", () => socket.emit("toggleSpectator"));
leaveBtn.addEventListener("click", () => {
  localStorage.removeItem("pp_room");
  location.href = location.pathname;
});

// ---- Render ----
function render(state) {
  const me = state.participants.find((p) => p.id === myId);
  amSpectator = me ? me.spectator : false;
  spectatorBtn.classList.toggle("active", amSpectator);
  spectatorBtn.textContent = amSpectator ? "🎴 Join voting" : "👀 Spectate";

  renderParticipants(state);
  renderDeck(state);
  renderControls(state);
}

function renderParticipants(state) {
  participantsEl.innerHTML = "";
  const voters = state.participants.filter((p) => !p.spectator);
  const spectators = state.participants.filter((p) => p.spectator);

  for (const p of voters) participantsEl.appendChild(participantNode(p, state.revealed));

  for (const p of spectators) {
    const el = document.createElement("div");
    el.className = "participant";
    el.innerHTML = `
      <div class="mini-card empty" style="font-size:22px">👀</div>
      <span class="name">${escapeHtml(p.name)}${p.id === myId ? " (you)" : ""}</span>
      <span class="badge">spectating</span>`;
    participantsEl.appendChild(el);
  }
}

function participantNode(p, revealed) {
  const el = document.createElement("div");
  el.className = "participant";

  let cardHtml;
  if (revealed) {
    cardHtml = `<div class="mini-card revealed">${p.vote ? escapeHtml(p.vote) : "–"}</div>`;
  } else if (p.hasVoted) {
    // Face-down card carries the Ritense logo.
    cardHtml = `<div class="mini-card voted"><img class="back-logo" src="${LOGO}" alt="ritense" /></div>`;
  } else {
    cardHtml = `<div class="mini-card empty"></div>`;
  }

  el.innerHTML = `
    ${cardHtml}
    <span class="name">${escapeHtml(p.name)}${p.id === myId ? " (you)" : ""}</span>`;
  return el;
}

function renderDeck(state) {
  deckEl.innerHTML = "";
  deckEl.classList.toggle("hidden", amSpectator);
  if (amSpectator) return;

  for (const value of state.deck) {
    const btn = document.createElement("button");
    btn.className = "card";
    btn.textContent = value;
    if (myVote === value && !state.revealed) btn.classList.add("selected");
    btn.disabled = state.revealed;
    btn.addEventListener("click", () => {
      myVote = myVote === value ? null : value;
      socket.emit("vote", { value });
    });
    deckEl.appendChild(btn);
  }
}

function renderControls(state) {
  const voters = state.participants.filter((p) => !p.spectator);
  const votedCount = voters.filter((p) => p.hasVoted).length;

  if (state.revealed) {
    statusEl.textContent = "Cards revealed";
    revealBtn.classList.add("hidden");
    resetBtn.classList.remove("hidden");
    renderResults(state.stats);
  } else {
    myVote = state.revealed ? myVote : myVote; // keep local pick
    statusEl.textContent = `${votedCount} / ${voters.length} voted`;
    revealBtn.classList.remove("hidden");
    revealBtn.disabled = votedCount === 0;
    resetBtn.classList.add("hidden");
    resultsEl.classList.add("hidden");
  }
}

function renderResults(stats) {
  if (!stats) {
    resultsEl.classList.add("hidden");
    return;
  }
  resultsEl.classList.remove("hidden");
  const distribution = Object.entries(stats.counts)
    .map(([v, c]) => `${escapeHtml(v)}×${c}`)
    .join("  ");

  resultsEl.innerHTML = `
    <div class="result-stat">
      <div class="value">${stats.average === null ? "–" : stats.average}</div>
      <div class="label">Average</div>
    </div>
    <div class="result-stat">
      <div class="value" style="font-size:18px">${distribution || "–"}</div>
      <div class="label">Distribution</div>
    </div>
    ${stats.consensus ? '<div class="consensus-badge">🎉 Consensus!</div>' : ""}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

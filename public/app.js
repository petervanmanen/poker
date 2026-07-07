/*
 * Serverless planning poker over Supabase Realtime.
 *
 * Presence is used ONLY for identity (who is in the room + their name), because
 * presence *joins/leaves* propagate reliably but presence *updates* (re-track)
 * do not. All mutable per-participant state — hasVoted, spectator — travels over
 * Broadcast, which is reliable.
 *
 * Broadcast events:
 *   state         { id, hasVoted, spectator }  a participant's mutable state
 *   reveal                                      flip; each voter then emits value
 *   value         { id, value }                 actual pick, only after reveal
 *   reset                                        clear the round
 *   sync-request  { from }                       newcomer asks peers to announce
 *   sync-state    { revealed }                   peers tell newcomer a round is open
 *
 * Vote values are never sent before reveal, so cards stay genuinely hidden.
 */

const DECK = ["0", "½", "1", "2", "3", "5", "8", "13", "20", "40", "100", "?", "☕"];
const LOGO = "ritense-logo.svg";

// ---- Elements ----
const loginEl = document.getElementById("login");
const sessionEl = document.getElementById("session");
const loginForm = document.getElementById("login-form");
const nameInput = document.getElementById("name-input");
const roomInput = document.getElementById("room-input");
const configWarning = document.getElementById("config-warning");

const roomNameEl = document.getElementById("room-name");
const participantsEl = document.getElementById("participants");
const deckEl = document.getElementById("deck");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const revealBtn = document.getElementById("reveal-btn");
const resetBtn = document.getElementById("reset-btn");
const spectatorBtn = document.getElementById("spectator-btn");
const leaveBtn = document.getElementById("leave-btn");

// ---- Supabase client ----
const configured =
  window.SUPABASE_URL &&
  window.SUPABASE_ANON_KEY &&
  !window.SUPABASE_URL.includes("YOUR_PROJECT") &&
  !window.SUPABASE_ANON_KEY.includes("YOUR_ANON");

const client = configured
  ? supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY)
  : null;

// ---- Local state ----
let channel = null;
let myId = null;
let myName = "";
let myVote = null; // my locally-held card value (never broadcast until reveal)
let revealed = false;
let states = {}; // id -> { hasVoted, spectator }
let revealedVotes = {}; // id -> value, populated only after reveal
let confettiShown = false; // fire the consensus easter egg once per round

function mySpectator() {
  return !!(states[myId] && states[myId].spectator);
}

// ---- Restore name/room and auto-rejoin on refresh ----
function prefill() {
  const params = new URLSearchParams(location.search);
  nameInput.value = localStorage.getItem("pp_name") || "";
  roomInput.value = params.get("room") || localStorage.getItem("pp_room") || "";
}
prefill();

if (!configured) {
  configWarning.classList.remove("hidden");
} else if (nameInput.value && roomInput.value) {
  join(nameInput.value, roomInput.value);
}

loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  join(nameInput.value, roomInput.value);
});

function join(name, room) {
  name = name.trim();
  room = room.trim();
  if (!name || !room || !client) return;

  localStorage.setItem("pp_name", name);
  localStorage.setItem("pp_room", room);
  const url = new URL(location);
  url.searchParams.set("room", room);
  history.replaceState({}, "", url);

  myId = crypto.randomUUID();
  myName = name;
  myVote = null;
  revealed = false;
  confettiShown = false;
  states = { [myId]: { hasVoted: false, spectator: false } };
  revealedVotes = {};

  channel = client.channel(`room:${room}`, {
    config: { broadcast: { self: true }, presence: { key: myId } },
  });

  channel
    .on("presence", { event: "sync" }, render)
    .on("broadcast", { event: "state" }, onState)
    .on("broadcast", { event: "reveal" }, onReveal)
    .on("broadcast", { event: "value" }, onValue)
    .on("broadcast", { event: "reset" }, onReset)
    .on("broadcast", { event: "sync-request" }, onSyncRequest)
    .on("broadcast", { event: "sync-state" }, onSyncState)
    .subscribe(async (status) => {
      if (status !== "SUBSCRIBED") return;
      await channel.track({ id: myId, name: myName }); // identity only
      broadcastMyState();
      send("sync-request", { from: myId });
      roomNameEl.textContent = room;
      loginEl.classList.add("hidden");
      sessionEl.classList.remove("hidden");
      render();
    });
}

function send(event, payload = {}) {
  channel.send({ type: "broadcast", event, payload });
}

function broadcastMyState() {
  send("state", {
    id: myId,
    hasVoted: myVote !== null && !mySpectator(),
    spectator: mySpectator(),
  });
}

// ---- Broadcast handlers ----
function onState({ payload }) {
  if (!payload || !payload.id) return;
  states[payload.id] = { hasVoted: !!payload.hasVoted, spectator: !!payload.spectator };
  render();
}

function onReveal() {
  revealed = true;
  if (!mySpectator() && myVote !== null) {
    revealedVotes[myId] = myVote;
    send("value", { id: myId, value: myVote });
  }
  render();
}

function onValue({ payload }) {
  if (payload && payload.id) {
    revealedVotes[payload.id] = payload.value;
    if (revealed) render();
  }
}

function onReset() {
  revealed = false;
  confettiShown = false;
  myVote = null;
  revealedVotes = {};
  // Clear everyone's voted flag — a reset starts a fresh round for all.
  for (const id of Object.keys(states)) states[id].hasVoted = false;
  render();
}

function onSyncRequest() {
  // Announce my current state so newcomers see who has voted / who is spectating.
  broadcastMyState();
  if (revealed) {
    send("sync-state", { revealed: true });
    if (!mySpectator() && myVote !== null) send("value", { id: myId, value: myVote });
  }
}

function onSyncState({ payload }) {
  if (payload && payload.revealed) {
    revealed = true;
    render();
  }
}

// ---- Actions ----
revealBtn.addEventListener("click", () => send("reveal"));
resetBtn.addEventListener("click", () => send("reset"));
spectatorBtn.addEventListener("click", () => {
  const now = !mySpectator();
  states[myId] = states[myId] || { hasVoted: false, spectator: false };
  states[myId].spectator = now;
  if (now) {
    myVote = null;
    states[myId].hasVoted = false;
  }
  broadcastMyState();
  render();
});
leaveBtn.addEventListener("click", () => {
  localStorage.removeItem("pp_room");
  if (channel) client.removeChannel(channel);
  location.href = location.pathname;
});

function vote(value) {
  if (revealed || mySpectator()) return;
  myVote = myVote === value ? null : value;
  states[myId] = states[myId] || { hasVoted: false, spectator: false };
  states[myId].hasVoted = myVote !== null;
  broadcastMyState();
  render();
}

// ---- Render ----
function participantList() {
  const state = channel ? channel.presenceState() : {};
  // Presence gives identity (id, name); mutable flags come from `states`.
  return Object.values(state)
    .map((metas) => metas[0])
    .filter(Boolean)
    .map((p) => ({
      id: p.id,
      name: p.name,
      hasVoted: !!(states[p.id] && states[p.id].hasVoted),
      spectator: !!(states[p.id] && states[p.id].spectator),
    }));
}

function render() {
  const people = participantList();
  const spec = mySpectator();
  spectatorBtn.classList.toggle("active", spec);
  spectatorBtn.textContent = spec ? "🎴 Join voting" : "👀 Spectate";

  renderParticipants(people);
  renderDeck(spec);
  renderControls(people);
}

function renderParticipants(people) {
  participantsEl.innerHTML = "";
  const voters = people.filter((p) => !p.spectator);
  const spectators = people.filter((p) => p.spectator);

  for (const p of voters) participantsEl.appendChild(participantNode(p));

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

function participantNode(p) {
  const el = document.createElement("div");
  el.className = "participant";

  let cardHtml;
  if (revealed) {
    const v = revealedVotes[p.id];
    cardHtml = `<div class="mini-card revealed">${v != null ? escapeHtml(v) : "–"}</div>`;
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

function renderDeck(spec) {
  deckEl.innerHTML = "";
  deckEl.classList.toggle("hidden", spec);
  if (spec) return;

  for (const value of DECK) {
    const btn = document.createElement("button");
    btn.className = "card";
    btn.textContent = value;
    if (myVote === value && !revealed) btn.classList.add("selected");
    btn.disabled = revealed;
    btn.addEventListener("click", () => vote(value));
    deckEl.appendChild(btn);
  }
}

function renderControls(people) {
  const voters = people.filter((p) => !p.spectator);
  const votedCount = voters.filter((p) => p.hasVoted).length;

  if (revealed) {
    statusEl.textContent = "Cards revealed";
    revealBtn.classList.add("hidden");
    resetBtn.classList.remove("hidden");
    renderResults(people);
  } else {
    statusEl.textContent = `${votedCount} / ${voters.length} voted`;
    revealBtn.classList.remove("hidden");
    revealBtn.disabled = votedCount === 0;
    resetBtn.classList.add("hidden");
    resultsEl.classList.add("hidden");
  }
}

function renderResults(people) {
  const votes = Object.values(revealedVotes);
  if (votes.length === 0) {
    resultsEl.classList.add("hidden");
    return;
  }
  resultsEl.classList.remove("hidden");

  const numeric = votes
    .filter((v) => v === "½" || /^\d+$/.test(v))
    .map((v) => (v === "½" ? 0.5 : Number(v)));
  const average =
    numeric.length > 0
      ? Math.round((numeric.reduce((a, b) => a + b, 0) / numeric.length) * 10) / 10
      : null;

  const counts = {};
  for (const v of votes) counts[v] = (counts[v] || 0) + 1;
  const distribution = Object.entries(counts)
    .map(([v, c]) => `${escapeHtml(v)}×${c}`)
    .join("  ");

  // Strict consensus: at least two voters, EVERY non-spectator has voted, and
  // all their revealed cards are identical (and every value has actually
  // arrived over the wire yet).
  const voters = (people || []).filter((p) => !p.spectator);
  const values = voters.map((p) => revealedVotes[p.id]);
  const allIn = voters.length >= 2 && values.every((v) => v != null);
  const consensus = allIn && new Set(values).size === 1;

  resultsEl.innerHTML = `
    <div class="result-stat">
      <div class="value">${average === null ? "–" : average}</div>
      <div class="label">Average</div>
    </div>
    <div class="result-stat">
      <div class="value" style="font-size:18px">${distribution || "–"}</div>
      <div class="label">Distribution</div>
    </div>
    ${consensus ? '<div class="consensus-badge">🎉 Consensus!</div>' : ""}`;

  // Easter egg: everyone agreed — rain confetti (once per round, on every client).
  if (consensus && !confettiShown) {
    confettiShown = true;
    celebrate();
  }
}

// Ritense-colored confetti burst.
function celebrate() {
  if (typeof confetti !== "function") return;
  const colors = ["#003263", "#ed6d3c", "#0a4d8f", "#ffffff"];
  confetti({ particleCount: 140, spread: 90, startVelocity: 45, origin: { y: 0.6 }, colors });
  const end = Date.now() + 1500;
  (function frame() {
    confetti({ particleCount: 5, angle: 60, spread: 60, origin: { x: 0 }, colors });
    confetti({ particleCount: 5, angle: 120, spread: 60, origin: { x: 1 }, colors });
    if (Date.now() < end) requestAnimationFrame(frame);
  })();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

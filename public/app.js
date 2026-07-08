/*
 * Serverless planning poker over Supabase Realtime — now with facilitated
 * SESSIONS (Option B: no database, peer-held state synced over Realtime).
 *
 * Identity: a per-tab id in sessionStorage. It survives a refresh (so you keep
 * your place / the facilitator role mid-session), but is forgotten when the tab
 * closes — so a user returning after a session has ended is treated as new.
 *
 * Session state (held by the connected clients, synced via broadcast):
 *   session = {
 *     id,             // uuid of this session
 *     facilitatorId,  // stable id of the facilitator (never transfers)
 *     item,           // null | { title, phase: 'voting' | 'revealed' }
 *     history,        // [ { title, result } ] newest first
 *     lastVoteAt,     // ms epoch of the last vote cast (drives the 60-min end)
 *   }
 *
 * Presence carries identity only { id, name }. Per-user mutable flags
 * (hasVoted, spectator) and actual vote values travel over Broadcast — vote
 * values are never sent before reveal.
 */

// Card decks the facilitator can choose between (per session).
const DECKS = {
  fib: ["0", "½", "1", "2", "3", "5", "8", "13", "20", "40", "100", "?", "☕"],
  tshirt: ["XS", "S", "M", "L", "XL", "XXL", "?", "☕"],
};
const DECK_LABELS = { fib: "Fibonacci", tshirt: "T-shirt" };
function currentDeck() {
  return DECKS[(session && session.deck) || "fib"];
}
const LOGO = "ritense-logo.svg";
const SESSION_TIMEOUT_MS = 60 * 60 * 1000; // 60 min without a vote ends the session

// ---- Elements ----
const loginEl = document.getElementById("login");
const sessionEl = document.getElementById("session");
const loginForm = document.getElementById("login-form");
const nameInput = document.getElementById("name-input");
const roomInput = document.getElementById("room-input");
const configWarning = document.getElementById("config-warning");

const roomNameEl = document.getElementById("room-name");
const itemBarEl = document.getElementById("item-bar");
const participantsEl = document.getElementById("participants");
const deckEl = document.getElementById("deck");
const deckAreaEl = deckEl.parentElement;
const statusEl = document.getElementById("status");
const controlsEl = document.getElementById("controls");
const resultsEl = document.getElementById("results");
const historyListEl = document.getElementById("history-list");
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
let myId = null; // stable per-browser id
let myName = "";
let myVote = null; // locally-held card value (never broadcast until reveal)
let session = null; // shared session state (see header)
let states = {}; // id -> { hasVoted, spectator }
let revealedVotes = {}; // id -> value, only after reveal
let confettiShown = false;
let stormShown = false; // lightning easter egg, once per round
let timeoutTimer = null;

function tabClientId() {
  let id = sessionStorage.getItem("pp_client_id");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("pp_client_id", id);
  }
  return id;
}

function isFacilitator() {
  return !!(session && session.facilitatorId === myId);
}
function itemPhase() {
  return session && session.item ? session.item.phase : "noitem";
}
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

  myId = tabClientId();
  myName = name;
  myVote = null;
  session = null;
  states = { [myId]: { hasVoted: false, spectator: false } };
  revealedVotes = {};
  confettiShown = false;
  stormShown = false;

  channel = client.channel(`room:${room}`, {
    config: { broadcast: { self: true }, presence: { key: myId } },
  });

  channel
    .on("presence", { event: "sync" }, render)
    .on("broadcast", { event: "session-state" }, onSessionState)
    .on("broadcast", { event: "state" }, onState)
    .on("broadcast", { event: "deck-set" }, onDeckSet)
    .on("broadcast", { event: "item-start" }, onItemStart)
    .on("broadcast", { event: "reveal" }, onReveal)
    .on("broadcast", { event: "reset" }, onReset)
    .on("broadcast", { event: "item-register" }, onItemRegister)
    .on("broadcast", { event: "value" }, onValue)
    .on("broadcast", { event: "sync-request" }, onSyncRequest)
    .on("broadcast", { event: "celebrate" }, fireCelebration)
    .on("broadcast", { event: "storm" }, fireStorm)
    .on("broadcast", { event: "hearts" }, onHearts)
    .subscribe(async (status) => {
      if (status !== "SUBSCRIBED") return;
      await channel.track({ id: myId, name: myName });
      broadcastMyState();
      send("sync-request", { from: myId });

      // If no existing session announces itself shortly, elect a facilitator
      // and start a fresh session.
      setTimeout(() => {
        if (!session) {
          const fac = electFacilitatorId();
          if (fac === myId) {
            session = newSession(myId);
            broadcastSession();
          }
          render();
        }
      }, 1500);

      roomNameEl.textContent = room;
      loginEl.classList.add("hidden");
      sessionEl.classList.remove("hidden");
      if (timeoutTimer) clearInterval(timeoutTimer);
      timeoutTimer = setInterval(checkTimeout, 20000);
      render();
    });
}

function send(event, payload = {}) {
  if (channel) channel.send({ type: "broadcast", event, payload });
}
function broadcastMyState() {
  send("state", {
    id: myId,
    hasVoted: myVote !== null && !mySpectator(),
    spectator: mySpectator(),
  });
}
function broadcastSession() {
  send("session-state", { session });
}
function newSession(facilitatorId) {
  return {
    id: crypto.randomUUID(),
    facilitatorId,
    deck: "fib",
    item: null,
    history: [],
    lastVoteAt: Date.now(),
  };
}

// Lowest stable id among everyone currently present — deterministic so all
// clients agree on who to elect when there is no session yet.
function electFacilitatorId() {
  const ids = participantList().map((p) => p.id);
  if (!ids.includes(myId)) ids.push(myId);
  ids.sort();
  return ids[0];
}

// Clear the per-round voting state (not the session/history).
function clearRound() {
  myVote = null;
  revealedVotes = {};
  confettiShown = false;
  stormShown = false;
  for (const id of Object.keys(states)) states[id].hasVoted = false;
}

// ---- Session sync ----
function onSyncRequest() {
  if (session) broadcastSession();
  broadcastMyState();
  // Late joiner during a revealed round needs the actual values.
  if (itemPhase() === "revealed" && !mySpectator() && myVote !== null) {
    send("value", { id: myId, value: myVote });
  }
}

function onSessionState({ payload }) {
  const s = payload && payload.session;
  if (!s) return;
  if (!session) {
    session = s;
    render();
    return;
  }
  if (s.id !== session.id) {
    // Two sessions raced — keep the one with the smaller id; help the loser converge.
    if (s.id < session.id) {
      session = s;
      render();
    } else {
      broadcastSession();
    }
  }
  // Same id: ongoing changes arrive via their own events; ignore duplicates.
}

// ---- Deck selection ----
function onDeckSet({ payload }) {
  if (!session || !payload || !DECKS[payload.deck]) return;
  session.deck = payload.deck;
  render();
}

// ---- Item / round events ----
function onItemStart({ payload }) {
  if (!session || !payload) return;
  session.item = { title: payload.title, phase: "voting" };
  clearRound();
  render();
}

function onReveal() {
  if (!session || !session.item) return;
  session.item.phase = "revealed";
  if (!mySpectator() && myVote !== null) {
    revealedVotes[myId] = myVote;
    send("value", { id: myId, value: myVote });
  }
  render();
}

function onReset() {
  if (!session || !session.item) return;
  session.item.phase = "voting";
  clearRound();
  render();
}

function onItemRegister({ payload }) {
  if (!session || !session.item || !payload) return;
  session.history.unshift({ title: session.item.title, result: payload.result });
  session.item = null;
  clearRound();
  render();
}

function onValue({ payload }) {
  if (payload && payload.id) {
    revealedVotes[payload.id] = payload.value;
    if (itemPhase() === "revealed") render();
  }
}

function onState({ payload }) {
  if (!payload || !payload.id) return;
  states[payload.id] = { hasVoted: !!payload.hasVoted, spectator: !!payload.spectator };
  if (payload.hasVoted && session) session.lastVoteAt = Date.now(); // a vote is activity
  render();
}

// ---- Timeout ----
function checkTimeout() {
  if (!session) return;
  if (Date.now() - session.lastVoteAt > SESSION_TIMEOUT_MS) {
    // Only the elected (lowest-id present) client starts the new session, to
    // avoid several clients creating competing ones.
    if (electFacilitatorId() === myId) {
      session = newSession(myId);
      clearRound();
      broadcastSession();
      render();
    }
  }
}

// ---- Facilitator actions ----
function startItem(title) {
  if (!isFacilitator()) return;
  title = cleanText(title);
  if (!title) return;
  send("item-start", { title });
}
function chooseDeck(deck) {
  if (!isFacilitator() || !DECKS[deck]) return;
  if (session && session.deck === deck) return;
  send("deck-set", { deck });
}
function doReveal() {
  if (isFacilitator()) send("reveal");
}
function doRevote() {
  if (isFacilitator()) send("reset");
}
function doRegister(result) {
  if (!isFacilitator()) return;
  result = cleanText(result) || modeOfVotes();
  if (!result) return;
  send("item-register", { result });
}

// ---- Voting ----
function vote(value) {
  if (itemPhase() !== "voting" || mySpectator()) return;
  myVote = myVote === value ? null : value;
  states[myId] = states[myId] || { hasVoted: false, spectator: false };
  states[myId].hasVoted = myVote !== null;
  if (session) session.lastVoteAt = Date.now();
  broadcastMyState();
  render();
}

// ---- Actions (buttons wired once) ----
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
  if (timeoutTimer) clearInterval(timeoutTimer);
  if (channel) client.removeChannel(channel);
  location.href = location.pathname;
});

// Click another participant's card to (privately) shower them with hearts.
participantsEl.addEventListener("click", (e) => {
  const card = e.target.closest(".mini-card[data-id]");
  if (!card || !channel) return;
  const id = card.dataset.id;
  if (!id || id === myId) return;
  send("hearts", { from: myId, to: id });
});

// ---- Render ----
function participantList() {
  const state = channel ? channel.presenceState() : {};
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

  renderItemBar(people);
  renderParticipants(people);
  renderControls(people);
  renderDeck(spec);
  renderHistory();

  // Keep the deck selector's active button in sync (its container isn't
  // rebuilt on a deck change, to preserve the item input being typed).
  const activeDeck = (session && session.deck) || "fib";
  document.querySelectorAll(".deck-select button[data-deck]").forEach((b) => {
    b.classList.toggle("active", b.dataset.deck === activeDeck);
  });
}

function facilitatorName(people) {
  if (!session) return "the facilitator";
  const f = people.find((p) => p.id === session.facilitatorId);
  return f ? f.name : "the facilitator";
}

function renderItemBar(people) {
  const phase = itemPhase();
  const fac = isFacilitator();
  let key;
  if (!session) key = "connecting";
  else if (phase === "noitem") key = "noitem|" + fac + "|" + cleanText(facilitatorName(people));
  else key = "item|" + cleanText(session.item.title);

  if (itemBarEl.dataset.key === key) return; // don't clobber a form being typed in
  itemBarEl.dataset.key = key;
  itemBarEl.innerHTML = "";

  if (!session) {
    itemBarEl.innerHTML = `<span class="waiting">Connecting…</span>`;
    return;
  }
  if (phase === "noitem") {
    if (fac) {
      const wrap = document.createElement("div");
      wrap.className = "facilitator-start";
      const deckSel = document.createElement("div");
      deckSel.className = "deck-select";
      deckSel.innerHTML =
        `<span class="deck-select-label">Cards</span>` +
        Object.keys(DECKS)
          .map((d) => `<button type="button" data-deck="${d}">${DECK_LABELS[d]}</button>`)
          .join("");
      deckSel.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-deck]");
        if (b) chooseDeck(b.dataset.deck);
      });

      const form = document.createElement("form");
      form.className = "item-form";
      form.innerHTML = `
        <input id="item-input" type="text" maxlength="120"
               placeholder="What are we estimating? (e.g. RIT-123 Login page)" />
        <button type="submit" class="primary">Put to vote</button>`;
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        startItem(document.getElementById("item-input").value);
      });

      wrap.appendChild(deckSel);
      wrap.appendChild(form);
      itemBarEl.appendChild(wrap);
    } else {
      itemBarEl.innerHTML = `<span class="waiting">Waiting for <strong>${escapeHtml(
        cleanText(facilitatorName(people))
      )}</strong> to put an item to vote…</span>`;
    }
  } else {
    itemBarEl.innerHTML = `<div class="item-title"><span class="item-label">Estimating</span>${escapeHtml(
      cleanText(session.item.title)
    )}</div>`;
  }
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
      <span class="name">${nameLabel(p)}</span>
      <span class="badge">spectating</span>`;
    tagSendable(el, p.id);
    participantsEl.appendChild(el);
  }
}

function participantNode(p) {
  const el = document.createElement("div");
  el.className = "participant";

  let cardHtml;
  if (itemPhase() === "revealed") {
    const v = revealedVotes[p.id];
    cardHtml = `<div class="mini-card revealed">${v != null ? escapeHtml(v) : "–"}</div>`;
  } else if (p.hasVoted) {
    cardHtml = `<div class="mini-card voted"><img class="back-logo" src="${LOGO}" alt="ritense" /></div>`;
  } else {
    cardHtml = `<div class="mini-card empty"></div>`;
  }

  el.innerHTML = `
    ${cardHtml}
    <span class="name">${nameLabel(p)}</span>`;
  tagSendable(el, p.id);
  return el;
}

// Display name: stripped of any user emoji, then decorated with a crown for the
// facilitator and a dog for Geertje/Anneke.
function nameLabel(p) {
  let out = escapeHtml(cleanText(p.name));
  if (session && session.facilitatorId === p.id) out += " 👑";
  if (/geertje|anneke/i.test(p.name || "")) out += " 🐕";
  if (p.id === myId) out += " (you)";
  return out;
}

function tagSendable(el, id) {
  const card = el.querySelector(".mini-card");
  if (!card) return;
  card.dataset.id = id;
  if (id !== myId) {
    card.classList.add("sendable");
    card.title = "Send hearts ❤️";
  }
}

function renderControls(people) {
  const phase = itemPhase();
  const fac = isFacilitator();
  const voters = people.filter((p) => !p.spectator);
  const votedCount = voters.filter((p) => p.hasVoted).length;

  if (phase === "revealed") statusEl.textContent = "Cards revealed";
  else if (phase === "voting") statusEl.textContent = `${votedCount} / ${voters.length} voted`;
  else statusEl.textContent = "";

  const key = phase + "|" + fac;
  if (controlsEl.dataset.key !== key) {
    controlsEl.dataset.key = key;
    controlsEl.innerHTML = "";

    if (fac && phase === "voting") {
      const b = document.createElement("button");
      b.className = "primary";
      b.id = "reveal-btn";
      b.textContent = "Reveal cards";
      b.addEventListener("click", doReveal);
      controlsEl.appendChild(b);
    } else if (fac && phase === "revealed") {
      const form = document.createElement("form");
      form.className = "register-form";
      form.innerHTML = `
        <input id="result-input" type="text" maxlength="60" placeholder="Final result" />
        <button type="submit" class="primary">Register result</button>
        <button type="button" id="revote-btn" class="secondary">Re-vote</button>`;
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        doRegister(document.getElementById("result-input").value);
      });
      form.querySelector("#revote-btn").addEventListener("click", doRevote);
      form.querySelector("#result-input").addEventListener("input", (e) => {
        e.target.dataset.dirty = "1";
      });
      controlsEl.appendChild(form);
    }
  }

  // Live updates that must not rebuild the (possibly focused) form:
  if (fac && phase === "voting") {
    const rb = document.getElementById("reveal-btn");
    if (rb) rb.disabled = votedCount === 0;
  }
  if (fac && phase === "revealed") {
    const inp = document.getElementById("result-input");
    if (inp && !inp.dataset.dirty) inp.value = modeOfVotes();
  }

  if (phase === "revealed") renderResults(people);
  else resultsEl.classList.add("hidden");
}

// Most-chosen revealed card (mode). Ties resolved by deck order for determinism.
function modeOfVotes() {
  const votes = Object.values(revealedVotes);
  if (!votes.length) return "";
  const counts = {};
  for (const v of votes) counts[v] = (counts[v] || 0) + 1;
  let best = votes[0];
  let bestN = 0;
  for (const v of currentDeck()) {
    if (counts[v] && counts[v] > bestN) {
      best = v;
      bestN = counts[v];
    }
  }
  return best;
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

  const voters = (people || []).filter((p) => !p.spectator);
  const values = voters.map((p) => revealedVotes[p.id]);
  const everyoneVoted = values.length > 0 && values.every((v) => v != null);
  const consensus = everyoneVoted && voters.length >= 2 && new Set(values).size === 1;
  // Total disagreement: every participant voted and all picked a different card.
  const allDifferent =
    everyoneVoted && voters.length >= 2 && new Set(values).size === voters.length;

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

  if (consensus && !confettiShown) {
    fireCelebration();
    send("celebrate");
  }
  if (allDifferent && !stormShown) {
    fireStorm();
    send("storm");
  }
}

function renderDeck(spec) {
  const show = itemPhase() === "voting" && !spec;
  deckAreaEl.classList.toggle("hidden", !show);
  deckEl.innerHTML = "";
  if (!show) return;

  for (const value of currentDeck()) {
    const btn = document.createElement("button");
    btn.className = "card";
    btn.textContent = value;
    if (myVote === value) btn.classList.add("selected");
    btn.addEventListener("click", () => vote(value));
    deckEl.appendChild(btn);
  }
}

function renderHistory() {
  historyListEl.innerHTML = "";
  const hist = session ? session.history : [];
  if (!hist.length) {
    historyListEl.innerHTML = `<p class="history-empty">No items registered yet.</p>`;
    return;
  }
  for (const h of hist) {
    const card = document.createElement("div");
    card.className = "history-card";
    card.innerHTML = `
      <div class="history-title">${escapeHtml(cleanText(h.title))}</div>
      <div class="history-result">${escapeHtml(cleanText(h.result))}</div>`;
    historyListEl.appendChild(card);
  }
}

// ---- Celebration (confetti + tada) ----
function fireCelebration() {
  if (confettiShown) return;
  confettiShown = true;
  burstConfetti();
  playTada();
}
function burstConfetti() {
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

let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}
["click", "keydown", "touchstart"].forEach((ev) =>
  window.addEventListener(ev, ensureAudio, { passive: true })
);
function playTada() {
  const ctx = ensureAudio();
  if (!ctx) return;
  const now = ctx.currentTime;
  const notes = [
    { f: 523.25, t: 0.0, d: 0.14 },
    { f: 523.25, t: 0.16, d: 0.55 },
    { f: 659.25, t: 0.16, d: 0.55 },
    { f: 783.99, t: 0.16, d: 0.55 },
    { f: 1046.5, t: 0.16, d: 0.55 },
  ];
  for (const n of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = n.f;
    const start = now + n.t;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + n.d);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + n.d + 0.05);
  }
}

// ---- Thunderstorm (everyone disagreed) ----
function fireStorm() {
  if (stormShown) return;
  stormShown = true;
  storm();
  playThunder();
}

function storm() {
  const layer = document.createElement("div");
  layer.className = "storm";
  document.body.appendChild(layer);

  const DURATION = 3000;
  const end = Date.now() + DURATION;
  (function strike() {
    if (Date.now() >= end) return;
    // A brief full-screen flash.
    const flash = document.createElement("div");
    flash.className = "storm-flash";
    layer.appendChild(flash);
    flash
      .animate([{ opacity: 0.85 }, { opacity: 0 }], {
        duration: 120 + Math.random() * 180,
        easing: "ease-out",
        fill: "forwards",
      })
      .addEventListener("finish", () => flash.remove());
    // One or two jagged bolts.
    const n = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) {
      const bolt = makeBolt();
      layer.appendChild(bolt);
      bolt
        .animate([{ opacity: 1 }, { opacity: 0.5, offset: 0.4 }, { opacity: 0 }], {
          duration: 220 + Math.random() * 260,
          fill: "forwards",
        })
        .addEventListener("finish", () => bolt.remove());
    }
    setTimeout(strike, 140 + Math.random() * 440);
  })();

  setTimeout(() => {
    layer
      .animate([{ opacity: 1 }, { opacity: 0 }], { duration: 450, fill: "forwards" })
      .addEventListener("finish", () => layer.remove());
  }, DURATION);
}

// A jagged lightning bolt as a full-screen SVG (viewBox is percentage space).
function makeBolt() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "bolt");

  let x = 12 + Math.random() * 76;
  let y = 0;
  const pts = [[x, 0]];
  while (y < 100) {
    y += 8 + Math.random() * 12;
    x += (Math.random() - 0.5) * 18;
    x = Math.max(3, Math.min(97, x));
    pts.push([Math.round(x * 10) / 10, Math.min(100, Math.round(y * 10) / 10)]);
  }
  const poly = document.createElementNS(NS, "polyline");
  poly.setAttribute("points", pts.map((p) => p.join(",")).join(" "));
  poly.setAttribute("fill", "none");
  poly.setAttribute("stroke", "#eaf6ff");
  poly.setAttribute("stroke-width", "3");
  poly.setAttribute("vector-effect", "non-scaling-stroke");
  poly.setAttribute("stroke-linejoin", "round");
  poly.setAttribute("stroke-linecap", "round");
  svg.appendChild(poly);
  return svg;
}

// A rumbling thunder clap: filtered noise burst + low sweep.
function playThunder() {
  const ctx = ensureAudio();
  if (!ctx) return;
  const now = ctx.currentTime;
  const dur = 2.6;

  // Noise buffer for the rumble.
  const frames = Math.floor(ctx.sampleRate * dur);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(500, now);
  lp.frequency.exponentialRampToValueAtTime(90, now + dur);
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.0001, now);
  ng.gain.exponentialRampToValueAtTime(0.6, now + 0.08);
  ng.gain.exponentialRampToValueAtTime(0.25, now + 0.6);
  ng.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  noise.connect(lp);
  lp.connect(ng);
  ng.connect(ctx.destination);
  noise.start(now);
  noise.stop(now + dur);

  // A low sub sweep for the "boom".
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(80, now);
  osc.frequency.exponentialRampToValueAtTime(35, now + 1.2);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.0001, now);
  og.gain.exponentialRampToValueAtTime(0.5, now + 0.06);
  og.gain.exponentialRampToValueAtTime(0.0001, now + 1.4);
  osc.connect(og);
  og.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 1.5);
}

// ---- Hearts (private to the receiver) ----
function onHearts({ payload }) {
  if (!payload || !payload.from) return;
  if (payload.to !== myId) return;
  const card = participantsEl.querySelector(`.mini-card[data-id="${payload.from}"]`);
  if (card) heartsFountain(card);
}
function heartsLayer() {
  let layer = document.getElementById("hearts-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "hearts-layer";
    document.body.appendChild(layer);
  }
  return layer;
}
function heartsFountain(el) {
  const rect = el.getBoundingClientRect();
  const originX = rect.left + rect.width / 2;
  const originY = rect.top + rect.height / 2;
  const layer = heartsLayer();
  const emojis = ["❤️", "💖", "💕", "💗", "🧡"];
  for (let i = 0; i < 16; i++) {
    const heart = document.createElement("div");
    heart.className = "heart";
    heart.textContent = emojis[i % emojis.length];
    heart.style.left = originX + "px";
    heart.style.top = originY + "px";
    heart.style.fontSize = 16 + Math.random() * 18 + "px";
    layer.appendChild(heart);
    const dx = (Math.random() - 0.5) * 170;
    const rise = 170 + Math.random() * 140;
    const anim = heart.animate(
      [
        { transform: "translate(-50%, -50%) scale(0.4)", opacity: 0 },
        {
          transform: `translate(calc(-50% + ${dx * 0.4}px), calc(-50% - ${rise * 0.4}px)) scale(1)`,
          opacity: 1,
          offset: 0.25,
        },
        {
          transform: `translate(calc(-50% + ${dx}px), calc(-50% - ${rise}px)) scale(0.9)`,
          opacity: 0,
        },
      ],
      {
        duration: 1300 + Math.random() * 800,
        delay: Math.random() * 260,
        easing: "cubic-bezier(.2,.6,.3,1)",
        fill: "forwards",
      }
    );
    anim.onfinish = () => heart.remove();
  }
}

// ---- Helpers ----
// Strip any user-entered emoji (names / item / result text are never allowed to
// show emoji), then collapse whitespace.
const EMOJI_RE =
  /(\p{Extended_Pictographic}|\uFE0F|\u200D|[\u{1F1E6}-\u{1F1FF}])/gu;
function cleanText(s) {
  return String(s || "").replace(EMOJI_RE, "").replace(/\s+/g, " ").trim();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

# Sessions — Requirements (for review before build)

Status: **ACCEPTED — building.**

## 0. Decisions (accepted)

- **Architecture: Option B** — no database. An empty room ends the session; the
  next arrival is a new session + facilitator. Peer state over Realtime.
- **FAC-4:** The facilitator stays the facilitator even after leaving; the role
  never transfers. If they return (same browser) they resume. (Identity is a
  stable per-browser id in localStorage.)
- **FAC-3:** Reveal and reset (re-vote) are **facilitator-only**.
- **RES-2:** Final result is **free text, prefilled with the most-chosen card**
  (the mode of the revealed votes); facilitator can edit before registering.
- **ITM-2:** One item at a time.
- **TMO-2:** Activity = **a vote being cast**. If no votes for 60 minutes, the
  session ends. (Starting an item, revealing, hearts, joining do NOT reset it.)
- **HIS-4:** History entries show **title + final result only**, as cards on the
  right.
- **HIS-3 / mobile:** On narrow screens the history panel is **hidden**
  (voting-only view).
- **RES-4:** Registered items **cannot** be edited or deleted.
- **Name display (new):**
  - **NAM-1:** Facilitator shown with a 👑 next to their name.
  - **NAM-2:** Any name containing "geertje" or "anneke" (case-insensitive)
    shows a 🐕 next to their name.
  - **NAM-3:** Emoji entered by users are stripped and never displayed (applies
    to names and item/result text).
- **Interpretations (flagging for confirmation):**
  - On timeout while people are still present: a new session starts immediately
    and the facilitator is re-elected as the lowest-id participant present.
  - Mobile keeps the facilitator controls if that person is the facilitator;
    "voting-only" is interpreted as "no history panel", not "cannot facilitate".

---

_Original draft below (retained for traceability)._
Each requirement has an ID so you can accept/reject/amend them individually.
Items marked **❓** are open questions I need answered. Items marked
**ASSUMPTION** are my best guess unless you say otherwise.

---

## 1. Concepts / vocabulary

- **Room** — the thing you join by name today (e.g. `sprint-42`). Unchanged as the entry point.
- **Session** — a time-bounded lifetime of a room: it begins when the first
  person enters an empty/expired room and ends after 60 minutes of inactivity.
  A room can have many sessions over time (one at a time).
- **Facilitator** — the first participant in a session; has extra controls.
- **Item** — one thing put to a vote (has a text title). A session contains many items.
- **Round** — the voting on a single item: pick cards → reveal → facilitator registers a result.
- **Result** — the final value the facilitator records for an item.

---

## 2. Session lifecycle

- **SES-1** A session starts when a participant enters a room that has no active session.
- **SES-2** Exactly one session is active per room at a time.
- **SES-3** A session ends after **60 minutes with no activity** (see TMO-\* for "activity").
- **SES-4** After a session has ended, the next person to enter the room starts a **new** session (SES-1) and becomes the facilitator (FAC-1).
- **SES-5** ASSUMPTION: If people are already in the room and it hits 60 min of inactivity, the session ends *for everyone currently connected*; the UI returns to the "waiting for facilitator to start an item" state and history from the ended session is cleared from view. ❓ Confirm — alternative: show a "session ended, start a new one?" prompt.
- **SES-6** ❓ If the room empties but someone returns **within** 60 min of the last activity, is it the **same** session (history preserved, same facilitator if it's the same person) or a **new** one? Literal reading of your spec = same session until 60 min elapses. Please confirm.

## 3. Facilitator

- **FAC-1** The first participant in a session is the facilitator.
- **FAC-2** The current facilitator is clearly indicated in the participant list (e.g. a badge).
- **FAC-3** Facilitator-only actions: start an item (ITM-1), and register the result (RES-1). ❓ Should reveal/reset also become facilitator-only? (Today anyone can reveal/reset.)
- **FAC-4** ❓ Handoff: what happens if the facilitator leaves or refreshes mid-session?
  - (a) Role transfers to the longest-present remaining participant, **or**
  - (b) Role is held for them to reclaim on return, **or**
  - (c) Session continues with no facilitator until they return.
  - My recommendation: **(a)** transfer to the next participant.
- **FAC-5** ASSUMPTION: A refresh by any participant keeps them in the same session (they rejoin), consistent with today's auto-rejoin behavior.

## 4. Putting an item to vote

- **ITM-1** The facilitator can start an item by entering a text title and submitting it.
- **ITM-2** ASSUMPTION: Only **one** item is being voted on at a time. A new item can't be started until the current one is registered (RES-1). ❓ Confirm (vs. allowing a backlog/queue).
- **ITM-3** When an item starts, the round resets: all cards cleared, not revealed.
- **ITM-4** All participants (facilitator included) can vote on the active item using the existing card deck (`0 ½ 1 2 3 5 8 13 20 40 100 ? ☕`). Spectators do not vote (existing behavior).
- **ITM-5** Cards stay hidden (showing the Ritense logo) until revealed — existing behavior preserved.
- **ITM-6** The active item's title is shown prominently to everyone during the round.
- **ITM-7** ❓ Item title constraints (max length? required non-empty? can it be edited after starting?). ASSUMPTION: required, ≤120 chars, not editable once started.

## 5. Voting & reveal

- **VOT-1** Reveal shows everyone's cards and the stats (average, distribution, consensus) — existing behavior.
- **VOT-2** Consensus confetti + tada and private hearts continue to work during item rounds — existing behavior preserved.
- **VOT-3** ❓ Can the facilitator re-open / re-vote an item (clear and vote again) before registering a result? ASSUMPTION: yes — facilitator can reset the round any number of times before registering.

## 6. Registering the result

- **RES-1** After voting, the facilitator registers the **final result** for the item, which finalizes it and adds it to the session history (HIS-1).
- **RES-2** ❓ What is the final result value?
  - (a) The facilitator picks a card value from the deck (can differ from the average), **or**
  - (b) Free-form text, **or**
  - (c) Auto = the consensus/average.
  - My recommendation: **(a)** facilitator picks a deck value (defaulting to the rounded average as a suggestion).
- **RES-3** After registering, the round clears and the app returns to the "waiting for next item" state (facilitator can start another item).
- **RES-4** ❓ Can a registered item be edited or deleted afterwards by the facilitator? ASSUMPTION: no (append-only history) for v1.

## 7. Session history (right sidebar)

- **HIS-1** A list of all items registered in the **current session** is visible to everyone.
- **HIS-2** On desktop it appears as a panel on the **right** side of the screen.
- **HIS-3** ❓ Mobile/narrow screens: (a) hidden, (b) collapsible drawer, or (c) shown below the table. ASSUMPTION: hidden on narrow screens with a toggle to open a drawer.
- **HIS-4** ❓ Fields per entry. ASSUMPTION: item title + final result value, newest at top. Optional extras to confirm: vote count, average, time.
- **HIS-5** History reflects only the current session; it is cleared when a new session starts (SES-4).
- **HIS-6** History does **not** need to be persisted. It lives only in the running clients for the duration of the session and may be lost when the session ends or the room empties. (Per your clarification.)

## 8. Inactivity timeout (60 minutes)

- **TMO-1** The session ends after 60 minutes with no activity.
- **TMO-2** ❓ Definition of "activity" — which of these reset the 60-min timer?
  - starting an item, casting/changing a vote, revealing, registering a result — **yes** (ASSUMPTION).
  - a participant joining/leaving — ❓
  - sending hearts — ❓
  - merely being connected but idle — ASSUMPTION **does not** count (matches "no activity", even if people are present).
- **TMO-3** The timeout must hold **even while the room is empty** (nobody connected), so that re-entry after 60 min starts a new session and re-entry before 60 min does not. **This is the driver behind the architecture decision in §10.**

## 9. Compatibility (must keep working)

- **CMP-1** No login — join with a name + room.
- **CMP-2** Face-down cards show the Ritense logo; navy/orange branding.
- **CMP-3** Reveal, stats, consensus confetti + tada, private hearts, spectator mode, ½-card averaging.
- **CMP-4** Hosted on GitHub Pages; realtime via Supabase Realtime.
- **CMP-5** Refresh-safe auto-rejoin.

## 10. Architecture decision (please read — this is the big one)

Today the app is **serverless and ephemeral**: there is no database and no
backend. All state lives in the browsers and is synced via Supabase Realtime
(presence + broadcast). When everyone leaves, all state is gone.

Now that **history need not be persisted (HIS-6)**, the *only* thing that would
require persistent storage is the **60-min timer surviving an empty room** — i.e.
whether re-entry to an empty room within 60 min continues the same session or
starts a new one. Everything else (facilitator, current item, live history) can
stay in the clients and be synced over Realtime while ≥1 person is connected.

So the whole architecture decision collapses to **one question** (SES-6/TMO-3):

> If the room empties and someone returns **before** 60 min have passed, must it
> be the **same** session (same facilitator, timer continues), or is it fine for
> an empty room to simply end the session?

- **Option A — must honor the full 60 min across an empty room.**
  Requires a *tiny* bit of persistence: **one small table** (e.g.
  `room, session_id, facilitator_id, last_activity_at`) in Supabase Postgres +
  RLS. **No history table** — history stays in-memory over Realtime.
  - Cost: introduces a minimal backend (one table + a `supabase db push` deploy
    step). This is the "there IS now something to deploy to Supabase" path.

- **Option B — an empty room ends the session (recommended, no database).**
  Pure ephemeral / peer-held state; the timer runs only while ≥1 person is
  connected. If everyone leaves, the session is over; the next arrival is a new
  session + facilitator.
  - Behaviour vs spec: identical **whenever someone is present**. It differs only
    in the narrow case of "room emptied, then someone returns within 60 min" —
    which Option B treats as a new session instead of resuming the old one.
  - Cost: none. No database, no backend, nothing new to deploy.

**My recommendation is now Option B** — since history is ephemeral anyway,
paying for a database purely to bridge the empty-room gap is likely not worth it.
Pick A only if resuming a briefly-empty room as the same session really matters.

---

## 11. Open questions — re-evaluated after "history need not survive the timeout"

**Merged into the single architecture question (§10):**

- **The empty-room decision (was Q1 + Q8).** Option A (tiny DB, resume same
  session within 60 min) vs Option B (no DB, empty room ends the session).
  This is now the *only* thing gating whether we add a database. My rec: **B**.

**Still fully relevant (unchanged by your correction):**

1. Facilitator handoff on leave/refresh — transfer, reclaim, or none? (FAC-4)
2. Should reveal/reset become facilitator-only? (FAC-3)
3. Final result: facilitator-picked deck value, free text, or auto? (RES-2)
4. One item at a time, or a backlog/queue? (ITM-2)
5. Exact definition of "activity" for the timer. (TMO-2)
6. Behavior if the timeout fires while people are still present. (SES-5)
7. History entry fields for the live list. (HIS-4)
8. Mobile behavior for the history panel. (HIS-3)
9. Can registered items be edited/deleted during the session? (RES-4)

**No longer relevant (resolved by your correction):**

- History durability / surviving refreshes — dropped; history is in-memory only (HIS-6).
- "Does history survive re-entry" — moot; it doesn't need to.

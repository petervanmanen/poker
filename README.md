# Ritense Planning Poker

A **serverless** real-time planning poker webapp built on **Supabase Realtime**.
No login — open the app, enter a display name and a session name, and estimate
together. While cards are face-down they show the **Ritense logo**; hitting
**Reveal** flips them and shows the average, distribution, and a consensus badge.

The whole app is static files (`public/`). There is no backend server — live
sync runs over Supabase Realtime channels, and the app is hosted from a Supabase
Storage bucket.

## 1. Configure Supabase

Copy the template to a local, gitignored config file and fill it in:

```bash
cp public/config.example.js public/config.js
```

In the Supabase dashboard → **Project Settings → API**, grab your **Project URL**
and **anon public** key, then edit `public/config.js`:

```js
window.SUPABASE_URL = "https://YOUR_PROJECT.supabase.co";
window.SUPABASE_ANON_KEY = "YOUR_ANON_PUBLIC_KEY";
```

`public/config.js` is gitignored, so your keys are never committed. Realtime
Broadcast/Presence work out of the box on a new project — no tables or SQL
required.

## 2. Run locally

```bash
npm run dev      # serves ./public and prints the local URL
```

Open it in several tabs, join the same **session name**, and vote.

## 3. Deploy to Supabase (static hosting)

Host the static files in a public Storage bucket:

```bash
cp .env.example .env      # fill in SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
npm install
npm run deploy
```

The script creates a public bucket (default `poker`), uploads `public/`, and
prints the live URL:

```
https://YOUR_PROJECT.supabase.co/storage/v1/object/public/poker/index.html
```

> The **service_role** key is only used by `deploy.mjs` on your machine — it is
> read from `.env` (gitignored) and never shipped to the browser.

## How the live sync works

- **Presence** tracks each participant as `{ name, spectator, hasVoted }` — the
  actual vote value is **never** put on the wire before reveal, so cards stay
  genuinely hidden.
- **Broadcast** events drive the shared round: `reveal` (everyone flips and each
  voter then emits its value), `reset`, and `sync-request`/`sync-state` so a
  late joiner learns a round is already revealed.

## Files

- `public/index.html`, `app.js`, `style.css` — the static app
- `public/config.js` — your Supabase URL + anon key
- `public/ritense-logo.svg` — the logo shown on card backs
- `deploy.mjs` — uploads `public/` to a Supabase Storage bucket

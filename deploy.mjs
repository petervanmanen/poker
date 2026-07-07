// Deploy the static frontend to a public Supabase Storage bucket.
//
//   1. cp .env.example .env  and fill in the values
//   2. npm install
//   3. npm run deploy
//
// Uses the service_role key (server-side only — never ship it to the browser).
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucket = process.env.SUPABASE_BUCKET || "poker";

if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. See .env.example.");
  process.exit(1);
}

const CONTENT_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const supabase = createClient(url, key, { auth: { persistSession: false } });

// Ensure the bucket exists and is public.
const { error: createErr } = await supabase.storage.createBucket(bucket, { public: true });
if (createErr && !/exists/i.test(createErr.message)) {
  console.error("Could not create bucket:", createErr.message);
  process.exit(1);
}
await supabase.storage.updateBucket(bucket, { public: true });

const dir = "public";
for (const name of readdirSync(dir)) {
  const path = join(dir, name);
  if (!statSync(path).isFile()) continue;
  const body = readFileSync(path);
  const contentType = CONTENT_TYPES[extname(name)] || "application/octet-stream";
  const { error } = await supabase.storage
    .from(bucket)
    .upload(name, body, { contentType, upsert: true });
  console.log(error ? `✗ ${name}: ${error.message}` : `✓ ${name}`);
}

console.log(`\nDeployed. Open your app at:\n${url}/storage/v1/object/public/${bucket}/index.html`);

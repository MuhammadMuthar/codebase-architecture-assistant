# Free-tier proxy

This is a small Cloudflare Worker that:
- Holds your real Groq API key server-side (it's never in the extension code).
- Gives every install of the extension a free quota (default 20 questions).
- Enforces that quota itself, so it can't be bypassed by reinstalling the extension or clearing local state.

## One-time setup

1. Install Wrangler (Cloudflare's CLI) if you don't have it:
   ```bash
   npm install -g wrangler
   ```

2. Log in:
   ```bash
   wrangler login
   ```

3. From this `proxy/` folder, create the KV namespace that stores per-user quota counts:
   ```bash
   npx wrangler kv namespace create QUOTA
   ```
   This prints an `id`. Paste it into `wrangler.toml` in place of
   `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

4. Store your real Groq key as a secret (this is never committed to git or shipped anywhere):
   ```bash
   npx wrangler secret put GROQ_API_KEY
   ```
   Paste your key when prompted.

5. Deploy:
   ```bash
   npx wrangler deploy
   ```
   Wrangler will print a URL like `https://codebase-assistant-proxy.<your-subdomain>.workers.dev`.

6. Back in the extension source, open `src/chatViewProvider.ts` and set:
   ```ts
   const PROXY_URL = 'https://codebase-assistant-proxy.<your-subdomain>.workers.dev/chat';
   ```
   (Add `/chat` if you keep the worker's single route as-is, or adjust routing to match.)

## Changing the free quota

Edit `FREE_QUESTION_LIMIT` in `wrangler.toml`, then run `npx wrangler deploy` again.
Quota resets automatically per-install every 30 days (see `QUOTA_RESET_SECONDS` in `worker.js`)
since KV entries are stored with an expiring TTL — change that constant if you want a different reset window, or remove the TTL for a lifetime cap instead.

## Cost awareness

You are billed by Groq for every free-tier question that gets used, across all installs combined.
`FREE_QUESTION_LIMIT` is your main lever for controlling total exposure — with it set to 20,
your worst case is `20 x (number of unique installs)` billed questions. Cloudflare Workers
and KV are free at this kind of traffic volume (well under their free-tier limits for a
side project), so your only real ongoing cost is the Groq usage itself.

## Testing locally

```bash
npx wrangler dev
```
Then in another terminal:
```bash
curl -X POST http://localhost:8787/chat \
  -H 'content-type: application/json' \
  -d '{"machineId":"test-machine","systemPrompt":"You are a test.","question":"Say hi."}'
```

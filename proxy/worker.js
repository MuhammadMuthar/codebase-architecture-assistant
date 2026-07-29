/**
 * Free-tier proxy for Codebase Architecture Assistant.
 *
 * Holds the real Groq API key server-side (never shipped in the extension)
 * and enforces a per-installation free question quota using Workers KV.
 *
 * Deploy with Wrangler (see README.md in this folder for step-by-step setup).
 *
 * Required bindings (set in wrangler.toml / dashboard):
 *   - KV namespace binding: QUOTA
 *   - Secret:               GROQ_API_KEY   (wrangler secret put GROQ_API_KEY)
 *
 * Optional vars:
 *   - FREE_QUESTION_LIMIT   (defaults to 20 below if not set)
 *   - QUOTA_RESET_SECONDS   (defaults to 30 days below if not set)
 */

const DEFAULT_LIMIT = 20;
const DEFAULT_RESET_SECONDS = 60 * 60 * 24 * 30; // 30 days
const MODEL = 'openai/gpt-oss-120b';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const { machineId, systemPrompt, question, messages } = body || {};

    if (!machineId || typeof machineId !== 'string') {
      return json({ error: 'Missing machineId' }, 400);
    }

    // Build a validated conversation array. Prefer the new `messages` shape
    // (full bounded history from the client); fall back to the legacy
    // single-`question` shape so an older/newer client version pairing
    // during a rollout doesn't just hard-fail.
    let conversation;
    if (messages !== undefined) {
      if (!Array.isArray(messages) || messages.length === 0 || messages.length > 40) {
        return json({ error: 'Invalid messages array' }, 400);
      }
      conversation = [];
      let totalChars = 0;
      for (const m of messages) {
        if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
          return json({ error: 'Invalid message entry (expected {role, content})' }, 400);
        }
        if (m.content.length > 4000) {
          return json({ error: 'Request too large' }, 413);
        }
        totalChars += m.content.length;
        conversation.push({ role: m.role, content: m.content });
      }
      if (totalChars > 20000) {
        return json({ error: 'Request too large' }, 413);
      }
    } else if (typeof question === 'string' && question) {
      if (question.length > 4000) {
        return json({ error: 'Request too large' }, 413);
      }
      conversation = [{ role: 'user', content: question }];
    } else {
      return json({ error: 'Missing messages or question' }, 400);
    }

    if (systemPrompt && systemPrompt.length > 20000) {
      return json({ error: 'Request too large' }, 413);
    }

    const limit = Number(env.FREE_QUESTION_LIMIT) || DEFAULT_LIMIT;
    const resetSeconds = Number(env.QUOTA_RESET_SECONDS) || DEFAULT_RESET_SECONDS;

    // Hash the machineId before using it as a KV key, so we're not storing
    // a raw device identifier at rest.
    const quotaKey = 'quota:' + (await sha256(machineId));

    const currentRaw = await env.QUOTA.get(quotaKey);
    const current = currentRaw ? parseInt(currentRaw, 10) : 0;

    if (current >= limit) {
      return json({ error: 'quota_exceeded', limit }, 429);
    }

    // Call Groq with the real key, which only ever lives in this Worker's env.
    let groqRes;
    try {
      groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: systemPrompt || '' },
            ...conversation
          ]
        })
      });
    } catch (err) {
      return json({ error: 'Upstream request failed: ' + String(err) }, 502);
    }

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      return json({ error: 'Groq API error: ' + errText }, 502);
    }

    const data = await groqRes.json();
    const text = data?.choices?.[0]?.message?.content ?? '(no text in response)';

    // Only increment the quota on a successful, billed request.
    await env.QUOTA.put(quotaKey, String(current + 1), { expirationTtl: resetSeconds });

    return json({ text, remaining: Math.max(0, limit - (current + 1)) });
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders() }
  });
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type'
  };
}

async function sha256(input) {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Vercel Serverless Function — proxies requests to the Anthropic API.
// The API key lives ONLY here (server-side), read from the ANTHROPIC_API_KEY
// environment variable. It is never sent to the browser.
//
// Frontend calls:  POST /api/claude  { system, messages, max_tokens }

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

// Allow the synthesis call up to 60s. Vercel's default function timeout is 10s,
// which can cut off a long generation; 60s is the max on the Hobby plan.
export const maxDuration = 60;

export default async function handler(req, res) {
  // Basic CORS (same-origin in production; permissive helps local tools).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed. Use POST.' } });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: 'Server is missing ANTHROPIC_API_KEY. Add it in your Vercel project settings (Settings → Environment Variables).' } });
    return;
  }

  // req.body is already parsed by Vercel when Content-Type is application/json.
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { system, messages, max_tokens } = body || {};

  if (!system || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: { message: 'Request must include "system" and a non-empty "messages" array.' } });
    return;
  }

  try {
    const upstream = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        // Sonnet 4.6 supports up to 64K output; cap at 16K which is plenty here.
        max_tokens: Math.min(Math.max(parseInt(max_tokens, 10) || 4096, 256), 16000),
        system,
        messages,
      }),
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(502).json({ error: { message: 'Upstream request to Anthropic failed: ' + (e && e.message ? e.message : 'unknown error') } });
  }
}

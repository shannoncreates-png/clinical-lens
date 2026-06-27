// Local dev server for ClinicalLens.
//   - Serves the static frontend (index.html, etc.)
//   - Implements POST /api/claude exactly like the Vercel function, using
//     ANTHROPIC_API_KEY from the environment or a local .env file.
//
// Usage:
//   1. Put your key in a .env file:   ANTHROPIC_API_KEY=sk-ant-...
//   2. node server.js
//   3. open http://localhost:3000
//
// On Vercel this file is ignored; api/claude.js is used instead.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

// --- minimal .env loader (no dependency) ---
(() => {
  const envPath = path.join(__dirname, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
  });
}

async function handleClaude(req, res) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Server is missing ANTHROPIC_API_KEY. Add it to a .env file or your environment.' } }));
    return;
  }
  let body;
  try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { body = {}; }
  const { system, messages, max_tokens } = body;
  if (!system || !Array.isArray(messages) || !messages.length) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Request must include "system" and a non-empty "messages" array.' } }));
    return;
  }
  try {
    const upstream = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: Math.min(Math.max(parseInt(max_tokens, 10) || 4096, 256), 8000), system, messages }),
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(text);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Upstream request to Anthropic failed: ' + (e.message || 'unknown') } }));
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/claude') {
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end('Method not allowed'); return; }
    return handleClaude(req, res);
  }

  // static files
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  const filePath = path.join(__dirname, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  } catch (e) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, () => console.log(`ClinicalLens running at http://localhost:${PORT}`));

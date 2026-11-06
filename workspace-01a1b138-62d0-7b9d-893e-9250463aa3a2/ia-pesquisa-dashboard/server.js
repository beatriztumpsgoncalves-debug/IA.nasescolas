const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DATA_FILE = path.join(DATA_DIR, 'responses.json');

const GOOGLE_FORM_ACTION =
  'https://docs.google.com/forms/d/e/1FAIpQLSffhUqSLIE5s7nkVtpKQ35lQ6fmYU2t2ViTKDQkAx0xxNdbAA/formResponse';

const ENTRY_MAP = {
  q1: 'entry.248761432',
  q2: 'entry.1661754754',
  q3: 'entry.834776703',
  q4: 'entry.1627332350',
  q5: 'entry.266826914',
  q6: 'entry.298079685',
  q7: 'entry.2023182118',
  q8: 'entry.926143495',
};

const REQUIRED_QUESTIONS = ['q1', 'q3', 'q5', 'q6', 'q7', 'q8'];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, '[]\n', 'utf8');
}

function readResponses() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('Erro ao ler responses.json:', err.message);
    return [];
  }
}

function writeResponses(list) {
  const tmpFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(list, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpFile, DATA_FILE);
}

// Active SSE clients
const sseClients = new Set();

function broadcastSSE(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(msg);
    } catch (_) {
      sseClients.delete(res);
    }
  }
}

// Keep SSE connections alive through proxies
setInterval(() => {
  for (const res of sseClients) {
    try {
      res.write(': heartbeat\n\n');
    } catch (_) {
      sseClients.delete(res);
    }
  }
}, 20000).unref();

function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function parseBody(req, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Payload excede o limite permitido.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error('JSON inválido no corpo da requisição.'));
      }
    });
    req.on('error', reject);
  });
}

function normalizeAnswers(rawAnswers) {
  const answers = {};
  for (const qKey of Object.keys(ENTRY_MAP)) {
    const val = rawAnswers?.[qKey];
    if (Array.isArray(val)) {
      answers[qKey] = val
        .map((v) => String(v || '').trim())
        .filter(Boolean);
    } else if (typeof val === 'string' && val.trim()) {
      answers[qKey] = [val.trim()];
    } else {
      answers[qKey] = [];
    }
  }
  return answers;
}

async function forwardToGoogleForms(answers) {
  const params = new URLSearchParams();
  for (const [qKey, entryName] of Object.entries(ENTRY_MAP)) {
    const values = answers[qKey] || [];
    for (const v of values) {
      params.append(entryName, v);
    }
  }
  params.append('fvv', '1');
  params.append('pageHistory', '0');

  const response = await fetch(GOOGLE_FORM_ACTION, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (compatible; IAPesquisaDashboard/1.0)',
    },
    body: params.toString(),
    redirect: 'follow',
  });

  return response.status >= 200 && response.status < 400;
}

function extractSheetExportUrl(inputUrl) {
  const str = String(inputUrl || '').trim();
  const match = str.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) {
    // Could also be a published-to-web URL (/spreadsheets/d/e/.../pub?output=csv)
    if (str.includes('docs.google.com/spreadsheets') && str.includes('pub')) {
      const u = new URL(str);
      u.searchParams.set('output', 'csv');
      return u.toString();
    }
    return null;
  }
  const sheetId = match[1];
  const gidMatch = str.match(/[?&#]gid=([0-9]+)/);
  const gid = gidMatch ? gidMatch[1] : '0';
  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // Health endpoint
  if (pathname === '/api/health' && req.method === 'GET') {
    const responses = readResponses();
    sendJSON(res, 200, {
      ok: true,
      count: responses.length,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // SSE live stream
  if (pathname === '/api/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    sseClients.add(res);
    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // GET all responses
  if (pathname === '/api/responses' && req.method === 'GET') {
    const responses = readResponses();
    sendJSON(res, 200, {
      ok: true,
      responses,
      total: responses.length,
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  // POST new single response from integrated form
  if (pathname === '/api/responses' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const answers = normalizeAnswers(body.answers);

      for (const reqKey of REQUIRED_QUESTIONS) {
        if (!answers[reqKey] || answers[reqKey].length === 0) {
          sendJSON(res, 400, {
            ok: false,
            error: `A pergunta obrigatória (${reqKey.toUpperCase()}) precisa de pelo menos uma opção marcada.`,
          });
          return;
        }
      }

      const responses = readResponses();
      const newEntry = {
        id: crypto.randomUUID(),
        seq: responses.length + 1,
        createdAt: new Date().toISOString(),
        source: 'site',
        googleFormsSynced: false,
        answers,
      };

      if (body.syncGoogleForms === true) {
        try {
          newEntry.googleFormsSynced = await forwardToGoogleForms(answers);
        } catch (syncErr) {
          console.warn('Aviso ao sincronizar com Google Forms:', syncErr.message);
          newEntry.googleFormsSynced = false;
        }
      }

      responses.push(newEntry);
      writeResponses(responses);

      broadcastSSE('responses_updated', {
        total: responses.length,
        latest: newEntry,
        responses,
      });

      sendJSON(res, 201, {
        ok: true,
        response: newEntry,
        total: responses.length,
      });
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  // POST bulk import (CSV or Google Sheets parsed entries)
  if (pathname === '/api/import' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const incoming = Array.isArray(body.entries) ? body.entries : [];
      const mode = body.mode === 'replace' ? 'replace' : 'append';

      const current = mode === 'replace' ? [] : readResponses();
      let added = 0;

      for (const item of incoming) {
        const answers = normalizeAnswers(item.answers || item);
        const hasAny = Object.values(answers).some((arr) => arr.length > 0);
        if (!hasAny) continue;

        current.push({
          id: crypto.randomUUID(),
          seq: current.length + 1,
          createdAt: item.createdAt || new Date().toISOString(),
          source: item.source || 'import',
          googleFormsSynced: Boolean(item.googleFormsSynced),
          answers,
        });
        added += 1;
      }

      writeResponses(current);
      broadcastSSE('responses_updated', {
        total: current.length,
        responses: current,
      });

      sendJSON(res, 200, {
        ok: true,
        added,
        total: current.length,
        responses: current,
      });
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  // POST fetch public Google Sheets CSV
  if (pathname === '/api/fetch-sheet' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const exportUrl = extractSheetExportUrl(body.url);
      if (!exportUrl) {
        sendJSON(res, 400, {
          ok: false,
          error:
            'Link inválido. Cole o link de compartilhamento da Planilha Google (docs.google.com/spreadsheets/d/...).',
        });
        return;
      }

      const sheetRes = await fetch(exportUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; IAPesquisaDashboard/1.0)',
        },
        redirect: 'follow',
      });

      if (!sheetRes.ok) {
        sendJSON(res, 400, {
          ok: false,
          error:
            'Não foi possível ler a planilha. Verifique se o compartilhamento está como "Qualquer pessoa com o link pode ler".',
        });
        return;
      }

      const csvText = await sheetRes.text();
      if (csvText.trim().startsWith('<!DOCTYPE html') || csvText.includes('accounts.google.com')) {
        sendJSON(res, 400, {
          ok: false,
          error:
            'A planilha ainda está privada. No Google Sheets, clique em Compartilhar → "Qualquer pessoa com o link" (Leitor).',
        });
        return;
      }

      sendJSON(res, 200, { ok: true, csv: csvText });
    } catch (err) {
      sendJSON(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  // DELETE single response
  if (pathname.startsWith('/api/responses/') && req.method === 'DELETE') {
    const id = decodeURIComponent(pathname.slice('/api/responses/'.length));
    const current = readResponses();
    const filtered = current
      .filter((r) => r.id !== id)
      .map((r, idx) => ({ ...r, seq: idx + 1 }));
    writeResponses(filtered);
    broadcastSSE('responses_updated', {
      total: filtered.length,
      responses: filtered,
    });
    sendJSON(res, 200, { ok: true, total: filtered.length, responses: filtered });
    return;
  }

  // DELETE all responses
  if (pathname === '/api/responses' && req.method === 'DELETE') {
    writeResponses([]);
    broadcastSSE('responses_updated', { total: 0, responses: [] });
    sendJSON(res, 200, { ok: true, total: 0, responses: [] });
    return;
  }

  // Serve static files from /public
  let relPath = pathname === '/' ? '/index.html' : pathname;
  relPath = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
  let filePath = path.join(PUBLIC_DIR, relPath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  try {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Arquivo não encontrado');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Dashboard IA Pesquisa rodando em http://${HOST}:${PORT}`);
});

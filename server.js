const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const HOST = process.env.SERVICEPRO_HOST || '0.0.0.0';
const PORT = Number(process.env.SERVICEPRO_PORT || 4173);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'servicepro.sqlite');
const MAX_BODY_BYTES = 100 * 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });

const database = new DatabaseSync(DB_PATH);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL DEFAULT 0,
    data_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const readState = database.prepare(
  'SELECT revision, data_json, updated_at FROM app_state WHERE id = 1'
);
const createState = database.prepare(
  'INSERT INTO app_state (id, revision, data_json, updated_at) VALUES (1, 1, ?, ?)'
);
const updateState = database.prepare(
  'UPDATE app_state SET revision = revision + 1, data_json = ?, updated_at = ? WHERE id = 1 AND revision = ?'
);

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};
const publicExtensions = new Set(Object.keys(contentTypes));

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

function currentState() {
  const row = readState.get();
  if (!row) return { revision: 0, data: null, updatedAt: null };
  return {
    revision: row.revision,
    data: JSON.parse(row.data_json),
    updatedAt: row.updated_at
  };
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function handleApi(request, response, url) {
  if (url.pathname === '/api/health' && request.method === 'GET') {
    return sendJson(response, 200, { ok: true, database: 'sqlite', time: new Date().toISOString() });
  }

  if (url.pathname === '/api/state' && request.method === 'GET') {
    return sendJson(response, 200, currentState());
  }

  if (url.pathname === '/api/state' && request.method === 'PUT') {
    const body = await readJsonBody(request);
    if (!body.data || typeof body.data !== 'object' || !Number.isInteger(body.baseRevision)) {
      return sendJson(response, 400, { error: 'Invalid state payload' });
    }

    const serialized = JSON.stringify(body.data);
    const timestamp = new Date().toISOString();
    const existing = readState.get();

    if (!existing) {
      if (body.baseRevision !== 0) return sendJson(response, 409, currentState());
      createState.run(serialized, timestamp);
      return sendJson(response, 200, { revision: 1, updatedAt: timestamp });
    }

    const result = updateState.run(serialized, timestamp, body.baseRevision);
    if (result.changes !== 1) return sendJson(response, 409, currentState());
    return sendJson(response, 200, { revision: body.baseRevision + 1, updatedAt: timestamp });
  }

  return sendJson(response, 404, { error: 'API endpoint not found' });
}

function serveStatic(response, url) {
  let relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  relative = relative.replace(/^[/\\]+/, '');
  const filePath = path.resolve(ROOT, relative);
  const extension = path.extname(filePath).toLowerCase();
  const isInsideRoot = filePath.startsWith(`${path.resolve(ROOT)}${path.sep}`);

  if (!isInsideRoot || !publicExtensions.has(extension) || relative.startsWith('data/')) {
    response.writeHead(404).end('Not found');
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500).end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentTypes[extension] || 'application/octet-stream',
      'Content-Length': content.length,
      'Cache-Control': extension === '.html' || extension === '.js' ? 'no-store' : 'public, max-age=300'
    });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
    else if (request.method === 'GET' || request.method === 'HEAD') serveStatic(response, url);
    else response.writeHead(405).end('Method not allowed');
  } catch (error) {
    console.error(error);
    sendJson(response, error.status || 500, { error: error.message || 'Internal server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ServicePro server running at http://${HOST}:${PORT}`);
  console.log(`SQLite database: ${DB_PATH}`);
});

function shutdown() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

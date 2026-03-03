#!/usr/bin/env node
/**
 * http-mock-recorder
 * Record real HTTP traffic. Replay it as mocks. Zero dependencies.
 */

import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import crypto from 'crypto';
import net from 'net';

// ─── ANSI Colors ─────────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
  gray:   '\x1b[90m',
};

const isTTY = process.stdout.isTTY;
const c = (color, str) => isTTY ? `${color}${str}${C.reset}` : str;

// ─── Utilities ────────────────────────────────────────────────────────────────

function generateId() {
  return crypto.randomUUID();
}

function hashUrl(method, url) {
  return crypto.createHash('sha1').update(`${method}:${url}`).digest('hex').slice(0, 10);
}

function readBody(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', chunk => chunks.push(chunk));
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function listFixtures(fixturesDir) {
  if (!fs.existsSync(fixturesDir)) return [];
  return fs.readdirSync(fixturesDir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const raw = fs.readFileSync(path.join(fixturesDir, f), 'utf8');
        return { file: f, data: JSON.parse(raw) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function normalizeUrl(rawUrl, ignoreQuery) {
  try {
    const u = new URL(rawUrl);
    if (ignoreQuery) {
      u.search = '';
    }
    return u.toString();
  } catch {
    return rawUrl;
  }
}

function methodColor(method) {
  const map = {
    GET:    C.green,
    POST:   C.blue,
    PUT:    C.yellow,
    PATCH:  C.yellow,
    DELETE: C.red,
    HEAD:   C.cyan,
  };
  return c(map[method] || C.white, method.padEnd(7));
}

function statusColor(status) {
  if (status >= 500) return c(C.red, String(status));
  if (status >= 400) return c(C.yellow, String(status));
  if (status >= 300) return c(C.cyan, String(status));
  if (status >= 200) return c(C.green, String(status));
  return c(C.gray, String(status));
}

// ─── Sensitive header scrubbing (never log secret values) ────────────────────

const SENSITIVE_HEADERS = ['authorization', 'x-api-key', 'x-auth-token', 'cookie', 'set-cookie'];

function scrubHeaders(headers) {
  const result = {};
  for (const [k, v] of Object.entries(headers || {})) {
    result[k] = SENSITIVE_HEADERS.includes(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return result;
}

// ─── RECORD command ───────────────────────────────────────────────────────────

function startRecorder({ port, output, verbose, format }) {
  ensureDir(output);

  const server = http.createServer(async (req, res) => {
    const rawUrl = req.url;
    const isAbsolute = /^https?:\/\//.test(rawUrl);

    if (!isAbsolute) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('http-mock-recorder: only absolute URLs are supported. Configure your client to use this as a proxy.');
      return;
    }

    let targetUrl;
    try {
      targetUrl = new URL(rawUrl);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid URL');
      return;
    }

    const reqBody = await readBody(req);
    const isHttps = targetUrl.protocol === 'https:';
    const transport = isHttps ? https : http;

    const options = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: req.method,
      headers: { ...req.headers, host: targetUrl.host },
    };

    const proxyReq = transport.request(options, async (proxyRes) => {
      const resBody = await readBody(proxyRes);
      const resHeaders = { ...proxyRes.headers };

      // Save fixture
      const id = generateId();
      const ts = new Date().toISOString();
      const hash = hashUrl(req.method, rawUrl);
      const filename = `${req.method.toLowerCase()}-${hash}-${Date.now()}.json`;

      const fixture = {
        id,
        recorded_at: ts,
        request: {
          method: req.method,
          url: rawUrl,
          headers: scrubHeaders(req.headers),
          body: reqBody.length > 0 ? reqBody.toString('utf8') : null,
        },
        response: {
          status: proxyRes.statusCode,
          headers: resHeaders,
          body: resBody.toString('utf8'),
        },
      };

      fs.writeFileSync(path.join(output, filename), JSON.stringify(fixture, null, 2));

      if (format === 'json') {
        process.stdout.write(JSON.stringify({ event: 'recorded', filename, method: req.method, url: rawUrl, status: proxyRes.statusCode }) + '\n');
      } else {
        console.log(`${c(C.green, '●')} ${methodColor(req.method)} ${statusColor(proxyRes.statusCode)}  ${c(C.dim, rawUrl)}`);
        if (verbose) {
          console.log(`  ${c(C.gray, '→')} saved: ${filename}`);
        }
      }

      // Forward response to original caller
      res.writeHead(proxyRes.statusCode, resHeaders);
      res.end(resBody);
    });

    proxyReq.on('error', (err) => {
      if (format === 'json') {
        process.stdout.write(JSON.stringify({ event: 'error', url: rawUrl, error: err.message }) + '\n');
      } else {
        console.error(`${c(C.red, '✗')} ${req.method} ${rawUrl} — ${err.message}`);
      }
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway: ' + err.message);
    });

    if (reqBody.length > 0) proxyReq.write(reqBody);
    proxyReq.end();
  });

  // HTTPS CONNECT tunneling
  server.on('connect', (req, clientSocket, head) => {
    const [hostname, portStr] = req.url.split(':');
    const targetPort = parseInt(portStr, 10) || 443;

    const serverSocket = net.connect(targetPort, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on('error', (err) => {
      clientSocket.end();
      if (format !== 'json') {
        console.error(`${c(C.yellow, '⚠')} CONNECT tunnel error: ${err.message}`);
      }
    });

    clientSocket.on('error', () => serverSocket.destroy());

    if (format === 'json') {
      process.stdout.write(JSON.stringify({ event: 'tunnel', host: req.url }) + '\n');
    } else if (verbose) {
      console.log(`${c(C.cyan, '⇄')} TUNNEL ${c(C.dim, req.url)}`);
    }
  });

  server.listen(port, () => {
    if (format === 'json') {
      process.stdout.write(JSON.stringify({ event: 'started', mode: 'record', port, output }) + '\n');
    } else {
      console.log(`\n${c(C.bold + C.green, 'http-mock-recorder')} ${c(C.dim, '·')} record mode\n`);
      console.log(`  ${c(C.cyan, 'Proxy:')}    http://localhost:${port}`);
      console.log(`  ${c(C.cyan, 'Fixtures:')} ${output}`);
      console.log(`\n  Configure your HTTP client:\n`);
      console.log(`  ${c(C.gray, 'HTTP_PROXY=http://localhost:' + port + ' your-command')}`);
      console.log(`\n${c(C.dim, '  Ctrl+C to stop\n')}`);
    }
  });

  process.on('SIGINT', () => {
    server.close(() => {
      if (format !== 'json') {
        const fixtures = listFixtures(output);
        console.log(`\n\n${c(C.bold, 'Recording stopped.')} ${fixtures.length} fixture(s) saved to ${c(C.cyan, output)}\n`);
      }
      process.exit(0);
    });
  });
}

// ─── REPLAY command ───────────────────────────────────────────────────────────

function startReplayer({ port, fixtures: fixturesDir, ignoreQuery, verbose, format }) {
  const fixtures = listFixtures(fixturesDir);

  if (fixtures.length === 0) {
    console.error(`${c(C.red, 'Error:')} No fixtures found in ${fixturesDir}`);
    process.exit(1);
  }

  // Build index: normalizedUrl → fixture
  const index = new Map();
  for (const { data } of fixtures) {
    const key = [data.request.method, normalizeUrl(data.request.url, ignoreQuery)].join(':');
    if (!index.has(key)) {
      index.set(key, data);
    }
  }

  const server = http.createServer(async (req, res) => {
    const rawUrl = req.url;
    const normalizedKey = [req.method, normalizeUrl(rawUrl, ignoreQuery)].join(':');

    const match = index.get(normalizedKey);

    if (match) {
      const { status, headers, body } = match.response;
      const safeHeaders = { ...headers };
      // Remove transfer-encoding to avoid chunked issues
      delete safeHeaders['transfer-encoding'];

      res.writeHead(status, safeHeaders);
      res.end(body);

      if (format === 'json') {
        process.stdout.write(JSON.stringify({ event: 'hit', method: req.method, url: rawUrl, status }) + '\n');
      } else {
        console.log(`${c(C.green, '✓')} ${methodColor(req.method)} ${statusColor(status)}  ${c(C.dim, rawUrl)}`);
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No fixture found', method: req.method, url: rawUrl }));

      if (format === 'json') {
        process.stdout.write(JSON.stringify({ event: 'miss', method: req.method, url: rawUrl }) + '\n');
      } else {
        console.log(`${c(C.red, '✗')} ${methodColor(req.method)} ${c(C.red, '404')}  ${c(C.dim, rawUrl)} ${c(C.gray, '(no fixture)')}`);
      }
    }
  });

  server.listen(port, () => {
    if (format === 'json') {
      process.stdout.write(JSON.stringify({ event: 'started', mode: 'replay', port, fixtures: fixturesDir, loaded: fixtures.length }) + '\n');
    } else {
      console.log(`\n${c(C.bold + C.green, 'http-mock-recorder')} ${c(C.dim, '·')} replay mode\n`);
      console.log(`  ${c(C.cyan, 'Server:')}   http://localhost:${port}`);
      console.log(`  ${c(C.cyan, 'Fixtures:')} ${fixturesDir}`);
      console.log(`  ${c(C.cyan, 'Loaded:')}   ${fixtures.length} fixture(s)`);
      if (ignoreQuery) console.log(`  ${c(C.cyan, 'Mode:')}     ignore query params`);
      console.log(`\n${c(C.dim, '  Ctrl+C to stop\n')}`);
    }
  });

  process.on('SIGINT', () => {
    server.close(() => process.exit(0));
  });
}

// ─── LIST command ─────────────────────────────────────────────────────────────

function listCommand({ fixtures: fixturesDir, format }) {
  const fixtures = listFixtures(fixturesDir);

  if (fixtures.length === 0) {
    if (format === 'json') {
      process.stdout.write(JSON.stringify({ fixtures: [] }) + '\n');
    } else {
      console.log(`${c(C.yellow, 'No fixtures found')} in ${fixturesDir}`);
    }
    return;
  }

  if (format === 'json') {
    const out = fixtures
      .filter(({ data }) => data && data.request && data.response)
      .map(({ file, data }) => ({
        file,
        id: data.id,
        recorded_at: data.recorded_at,
        method: data.request.method,
        url: data.request.url,
        status: data.response.status,
        body_size: Buffer.byteLength(data.response.body || '', 'utf8'),
      }));
    process.stdout.write(JSON.stringify({ fixtures: out }, null, 2) + '\n');
    return;
  }

  const col = { method: 8, status: 7, size: 9, date: 22, url: 50 };
  const header = [
    c(C.bold, 'METHOD'.padEnd(col.method)),
    c(C.bold, 'STATUS'.padEnd(col.status)),
    c(C.bold, 'SIZE'.padEnd(col.size)),
    c(C.bold, 'RECORDED AT'.padEnd(col.date)),
    c(C.bold, 'URL'),
  ].join('  ');

  const divider = c(C.gray, '─'.repeat(Math.min(process.stdout.columns || 100, 120)));

  console.log(`\n${c(C.bold + C.green, 'http-mock-recorder')} ${c(C.dim, '·')} ${fixtures.length} fixture(s) in ${c(C.cyan, fixturesDir)}\n`);
  console.log(header);
  console.log(divider);

  for (const { data } of fixtures) {
    const bodySize = Buffer.byteLength(data.response.body || '', 'utf8');
    const sizeStr = bodySize > 1024 ? (bodySize / 1024).toFixed(1) + 'kb' : bodySize + 'b';
    const dateStr = new Date(data.recorded_at).toLocaleString();
    const urlStr = data.request.url.length > 70 ? data.request.url.slice(0, 67) + '...' : data.request.url;

    console.log([
      methodColor(data.request.method).padEnd(col.method + (isTTY ? 10 : 0)),
      statusColor(data.response.status),
      c(C.dim, sizeStr.padEnd(col.size)),
      c(C.gray, dateStr.padEnd(col.date)),
      c(C.dim, urlStr),
    ].join('  '));
  }

  console.log('');
}

// ─── CLEAR command ────────────────────────────────────────────────────────────

function clearCommand({ fixtures: fixturesDir, format }) {
  if (!fs.existsSync(fixturesDir)) {
    if (format === 'json') {
      process.stdout.write(JSON.stringify({ deleted: 0 }) + '\n');
    } else {
      console.log(`${c(C.yellow, 'Nothing to clear')} — ${fixturesDir} does not exist.`);
    }
    return;
  }

  const files = fs.readdirSync(fixturesDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    fs.unlinkSync(path.join(fixturesDir, file));
  }

  if (format === 'json') {
    process.stdout.write(JSON.stringify({ deleted: files.length }) + '\n');
  } else {
    console.log(`${c(C.green, '✓')} Deleted ${files.length} fixture(s) from ${c(C.cyan, fixturesDir)}`);
  }
}

// ─── CLI parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0];
  const flags = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }

  return { command, flags };
}

function printHelp() {
  console.log(`
${c(C.bold + C.green, 'http-mock-recorder')} ${c(C.dim, '— Record real HTTP traffic. Replay it as mocks. Zero dependencies.')}

${c(C.bold, 'USAGE')}
  hmr <command> [options]

${c(C.bold, 'COMMANDS')}
  ${c(C.cyan, 'record')}   Start a proxy that records HTTP traffic to fixture files
  ${c(C.cyan, 'replay')}   Start a mock server that replays recorded fixtures
  ${c(C.cyan, 'list')}     Show all recorded fixtures in a table
  ${c(C.cyan, 'clear')}    Delete all fixture files

${c(C.bold, 'OPTIONS')}
  --port <n>         Port to listen on (default: 8080)
  --output <dir>     Directory to save fixtures (record, default: ./fixtures)
  --fixtures <dir>   Directory to read fixtures from (replay/list/clear, default: ./fixtures)
  --ignore-query     Ignore query parameters when matching URLs (replay)
  --format json      Machine-readable JSON output
  --verbose          Extra log output
  --help             Show this help

${c(C.bold, 'EXAMPLES')}
  ${c(C.gray, '# Record traffic on port 8080')}
  HTTP_PROXY=http://localhost:8080 hmr record --port 8080 --output ./fixtures

  ${c(C.gray, '# Replay recorded fixtures')}
  hmr replay --port 8080 --fixtures ./fixtures

  ${c(C.gray, '# List all recorded fixtures')}
  hmr list --fixtures ./fixtures

  ${c(C.gray, '# Clear all fixtures')}
  hmr clear --fixtures ./fixtures
`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const { command, flags } = parseArgs(process.argv);

  if (!command || command === '--help' || command === '-h' || command === 'help' || flags.help || flags.h) {
    printHelp();
    process.exit(0);
  }

  const port = parseInt(flags.port || '8080', 10);
  const output = path.resolve(flags.output || './fixtures');
  const fixturesDir = path.resolve(flags.fixtures || flags.output || './fixtures');
  const ignoreQuery = Boolean(flags['ignore-query']);
  const verbose = Boolean(flags.verbose);
  const format = flags.format === 'json' ? 'json' : 'text';

  switch (command) {
    case 'record':
      startRecorder({ port, output, verbose, format });
      break;

    case 'replay':
      startReplayer({ port, fixtures: fixturesDir, ignoreQuery, verbose, format });
      break;

    case 'list':
      listCommand({ fixtures: fixturesDir, format });
      break;

    case 'clear':
      clearCommand({ fixtures: fixturesDir, format });
      break;

    default:
      console.error(`${c(C.red, 'Unknown command:')} ${command}`);
      console.error(`Run ${c(C.cyan, 'hmr --help')} for usage.`);
      process.exit(1);
  }
}

main();

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadEndpoints } from './catalog.ts';
import { loadConfig } from './config.ts';
import { createServer } from './server.ts';

const log = (message: string): void => {
  process.stderr.write(`[ghl-mcp] ${message}\n`);
};

const MAX_BODY_BYTES = 1_000_000;

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) reject(new Error('Request body too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : undefined);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const expected = Buffer.from(expectedToken);
  const actual = Buffer.from(provided);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const authToken = process.env.MCP_AUTH_TOKEN?.trim();
if (!authToken) {
  // This process holds a live GHL token; never expose it over HTTP without a gate.
  log('MCP_AUTH_TOKEN is required for the HTTP transport. Generate one with: openssl rand -hex 32');
  process.exit(1);
}

const config = loadConfig();
const port = Number(process.env.PORT ?? 3000);
// listen() without a host binds every interface, which put a full-CRM proxy on the
// LAN while the startup line claimed localhost. Loopback unless asked otherwise.
const host = process.env.MCP_BIND_HOST?.trim() || '127.0.0.1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

// Parsed once: createServer runs per request, and loadEndpoints is a synchronous
// multi-megabyte JSON parse that would block the event loop on every call.
const endpoints = loadEndpoints(config.modules);
const catalog = config.metaTools && config.modules !== 'all' ? loadEndpoints('all') : endpoints;

// DNS rebinding: a hostile page can make a browser resolve its own domain to this
// address, but it cannot forge the Host header. An empty allowedOrigins list is a
// no-op in the SDK, so the Host allowlist is what actually holds.
// Behind a platform proxy the Host header is the public hostname with no port,
// so the loopback entries never match and the deploy 421s on every request.
// Render sets RENDER_EXTERNAL_HOSTNAME; Fly sets FLY_APP_NAME. Picking these up
// automatically is what keeps MCP_ALLOWED_HOSTS from being a required, easily
// forgotten step — it stays available for anything else in front of the server.
const platformHostnames = [
  process.env.RENDER_EXTERNAL_HOSTNAME,
  process.env.FLY_APP_NAME ? `${process.env.FLY_APP_NAME}.fly.dev` : undefined,
  process.env.RAILWAY_PUBLIC_DOMAIN,
].filter((value): value is string => Boolean(value?.trim()));

const allowedHosts = [
  ...new Set([
    `${host}:${port}`,
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    ...platformHostnames.flatMap((hostname) => [hostname, `${hostname}:443`]),
    ...(process.env.MCP_ALLOWED_HOSTS?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? []),
  ]),
];

// The marketplace app redirects here after an agency install. It is outside the
// MCP bearer gate because HighLevel's redirect cannot carry that header, so the
// only thing that makes it safe is that an authorization code is single-use,
// short-lived, and worthless without the client secret this process holds.
const installState = process.env.GHL_INSTALL_STATE?.trim();

async function handleOAuthCallback(url: URL, res: ServerResponse): Promise<void> {
  if (!config.oauth) {
    sendJson(res, 404, { error: 'Agency OAuth is not configured on this server.' });
    return;
  }
  const error = url.searchParams.get('error');
  if (error) {
    log(`Install callback returned an error: ${error}`);
    sendJson(res, 400, { error: `HighLevel reported: ${error}` });
    return;
  }
  // Optional shared nonce. Set GHL_INSTALL_STATE and include it in the redirect
  // URI so a stray GET cannot spend a code you did not initiate.
  if (installState && url.searchParams.get('state') !== installState) {
    sendJson(res, 403, { error: 'state mismatch' });
    return;
  }
  const code = url.searchParams.get('code');
  if (!code) {
    sendJson(res, 400, { error: 'No authorization code in the callback.' });
    return;
  }
  try {
    await config.oauth.agency.exchangeAuthorizationCode(code, config.oauth.redirectUri);
    log(`Agency authorised. Refresh token stored in ${config.oauth.store.describe}.`);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('GoHighLevel agency connected. You can close this tab.\n');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Install callback failed: ${message}`);
    // The code is spent either way, so say plainly that the install must restart.
    sendJson(res, 502, { error: `Token exchange failed: ${message}. Re-run the install from the marketplace app.` });
  }
}

const httpServer = createHttpServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/oauth/callback') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    await handleOAuthCallback(url, res);
    return;
  }
  if (url.pathname !== '/mcp') {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  if (!isAuthorized(req, authToken)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }
  if (req.method !== 'POST') {
    // Stateless mode: no SSE streams to resume, no sessions to close.
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    const body = await readJsonBody(req);
    // A fresh server + transport per request keeps JSON-RPC ids from colliding across clients.
    const server = createServer(config, { endpoints, catalog });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: true,
      allowedHosts,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    log(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
  }
});

httpServer.listen(port, host, () => {
  log(`Streamable HTTP listening on http://${host}:${port}/mcp`);
  if (config.oauth) {
    log(`Agency OAuth mode. Install callback: /oauth/callback. Token store: ${config.oauth.store.describe}.`);
    if (!process.env.GHL_TOKEN_STORE?.trim()) {
      log('WARNING: GHL_TOKEN_STORE is not set. HighLevel rotates the refresh token on every exchange, so this instance will lose the agency connection on restart and need re-authorising. Point it at a persistent disk.');
    }
    if (!config.oauth.appId) {
      log('Note: GHL_APP_ID is not set, so ghl_list_locations cannot enumerate installed sub-accounts. Location ids still work.');
    }
  }
  log(`Accepted Host headers: ${allowedHosts.join(', ')} (add more with MCP_ALLOWED_HOSTS).`);
  if (!LOOPBACK_HOSTS.has(host)) {
    log(`MCP_BIND_HOST=${host} exposes this process beyond the machine. Terminate TLS in front of it: the bearer token and every CRM record cross the wire in cleartext otherwise.`);
  }
});

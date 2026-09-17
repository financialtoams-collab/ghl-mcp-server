import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadEndpoints } from './catalog.ts';
import { loadConfig, type ServerConfig } from './config.ts';
import { createServer } from './server.ts';
import { consentPage, McpOAuthProvider, MCP_SCOPE, OAuthError } from './mcp-oauth.ts';

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

// Booting unconfigured is deliberate, not sloppiness. The install flow is
// circular: the marketplace app's Redirect URL needs this service's hostname,
// and the hostname does not exist until the service deploys. Exiting on missing
// credentials would mean a crash-looping first deploy that never yields a
// hostname to register. So the server starts, answers /health so the platform
// marks the deploy live, and refuses actual tool calls with the reason.
let config: ServerConfig | undefined;
let configError: string | undefined;
try {
  config = loadConfig();
} catch (error) {
  configError = error instanceof Error ? error.message : String(error);
}

const port = Number(process.env.PORT ?? 3000);
// listen() without a host binds every interface, which put a full-CRM proxy on the
// LAN while the startup line claimed localhost. Loopback unless asked otherwise.
const host = process.env.MCP_BIND_HOST?.trim() || '127.0.0.1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

// Parsed once: createServer runs per request, and loadEndpoints is a synchronous
// multi-megabyte JSON parse that would block the event loop on every call.
const endpoints = config ? loadEndpoints(config.modules) : [];
const catalog = config && config.metaTools && config.modules !== 'all' ? loadEndpoints('all') : endpoints;

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

// The issuer has to be the URL a client actually reaches, because it is baked
// into discovery documents and compared by the client (RFC 9207). Render exposes
// its public hostname; MCP_PUBLIC_URL overrides for a custom domain.
const publicBaseUrl = (
  process.env.MCP_PUBLIC_URL?.trim() ||
  (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : '') ||
  `http://${host}:${port}`
).replace(/\/+$/, '');

// Claude's connector UI has no bearer-token field, so OAuth is the only way in
// from there. The static MCP_AUTH_TOKEN still works for curl and the Messages
// API, and doubles as the secret that authorises an OAuth grant.
const oauth = new McpOAuthProvider({ issuer: publicBaseUrl, adminToken: authToken });

function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64_000) reject(new Error('Body too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        // The token endpoint is form-encoded per OAuth, but some clients post JSON.
        resolve(text.trim().startsWith('{')
          ? new URLSearchParams(Object.entries(JSON.parse(text) as Record<string, string>))
          : new URLSearchParams(text));
      } catch {
        resolve(new URLSearchParams(text));
      }
    });
    req.on('error', reject);
  });
}

function sendOAuthError(res: ServerResponse, error: unknown): void {
  if (error instanceof OAuthError) {
    sendJson(res, error.status, { error: error.code, error_description: error.message });
    return;
  }
  sendJson(res, 400, { error: 'invalid_request', error_description: error instanceof Error ? error.message : String(error) });
}

/** GET /authorize — show consent; POST /authorize — verify the secret, issue a code. */
async function handleAuthorize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const params = url.searchParams;
  const client = oauth.clientFor(params.get('client_id') ?? undefined);
  const redirectUri = params.get('redirect_uri') ?? '';
  if (!client) {
    sendJson(res, 400, { error: 'invalid_client', error_description: 'Unknown or malformed client_id. Register first.' });
    return;
  }
  // Never redirect to an unregistered URI: that is how an authorization code is
  // handed to someone else's server.
  if (!client.redirect_uris.includes(redirectUri)) {
    sendJson(res, 400, { error: 'invalid_request', error_description: 'redirect_uri was not registered for this client.' });
    return;
  }
  if (params.get('response_type') !== 'code') {
    sendJson(res, 400, { error: 'unsupported_response_type', error_description: 'Only response_type=code is supported.' });
    return;
  }
  const challenge = params.get('code_challenge');
  if (!challenge || params.get('code_challenge_method') !== 'S256') {
    sendJson(res, 400, { error: 'invalid_request', error_description: 'PKCE with code_challenge_method=S256 is required.' });
    return;
  }

  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(consentPage({ clientName: client.client_name ?? undefined, query: params.toString() }));
    return;
  }

  const form = await readFormBody(req);
  if (!oauth.isAdmin(form.get('secret'))) {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(consentPage({ clientName: client.client_name ?? undefined, query: params.toString(), error: 'That token was not correct.' }));
    return;
  }

  const code = oauth.issueCode({
    clientId: client.client_id,
    redirectUri,
    codeChallenge: challenge,
    scope: params.get('scope') || MCP_SCOPE,
    resource: params.get('resource') ?? undefined,
  });
  const location = new URL(redirectUri);
  location.searchParams.set('code', code);
  const state = params.get('state');
  if (state) location.searchParams.set('state', state);
  // RFC 9207 — lets the client detect an authorization-server mix-up.
  location.searchParams.set('iss', oauth.issuer);
  log('Authorized an MCP connector.');
  res.writeHead(302, { Location: location.toString() });
  res.end();
}

async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readFormBody(req);
  try {
    const grant = form.get('grant_type');
    const tokens = grant === 'refresh_token'
      ? oauth.refresh({
          refreshToken: form.get('refresh_token') ?? '',
          clientId: form.get('client_id') ?? undefined,
          resource: form.get('resource') ?? undefined,
        })
      : grant === 'authorization_code'
        ? oauth.exchangeCode({
            code: form.get('code') ?? '',
            codeVerifier: form.get('code_verifier') ?? undefined,
            redirectUri: form.get('redirect_uri') ?? undefined,
            clientId: form.get('client_id') ?? undefined,
            resource: form.get('resource') ?? undefined,
          })
        : (() => { throw new OAuthError('unsupported_grant_type', `grant_type "${grant}" is not supported.`); })();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(tokens));
  } catch (error) {
    sendOAuthError(res, error);
  }
}

// The marketplace app redirects here after an agency install. It is outside the
// MCP bearer gate because HighLevel's redirect cannot carry that header, so the
// only thing that makes it safe is that an authorization code is single-use,
// short-lived, and worthless without the client secret this process holds.
const installState = process.env.GHL_INSTALL_STATE?.trim();

async function handleOAuthCallback(url: URL, res: ServerResponse): Promise<void> {
  if (!config?.oauth) {
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
    // 200 even when unconfigured, so the platform marks the deploy live and a
    // hostname exists to register — but `configured` says what is actually true.
    sendJson(res, 200, { ok: true, configured: config !== undefined });
    return;
  }
  // --- OAuth discovery and endpoints (unauthenticated by design) -----------
  if (url.pathname === '/.well-known/oauth-protected-resource'
      || url.pathname === '/.well-known/oauth-protected-resource/mcp') {
    sendJson(res, 200, oauth.protectedResourceMetadata());
    return;
  }
  if (url.pathname === '/.well-known/oauth-authorization-server'
      || url.pathname === '/.well-known/openid-configuration') {
    sendJson(res, 200, oauth.authorizationServerMetadata());
    return;
  }
  if (url.pathname === '/register' && req.method === 'POST') {
    try {
      sendJson(res, 201, oauth.register((await readJsonBody(req)) as Record<string, unknown> ?? {}));
    } catch (error) {
      sendOAuthError(res, error);
    }
    return;
  }
  if (url.pathname === '/authorize' && (req.method === 'GET' || req.method === 'POST')) {
    await handleAuthorize(req, res, url);
    return;
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    await handleToken(req, res);
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
  const presented = (req.headers.authorization ?? '').startsWith('Bearer ')
    ? (req.headers.authorization as string).slice('Bearer '.length)
    : '';
  // Either an OAuth access token minted above, or the static MCP_AUTH_TOKEN,
  // which keeps curl and the Messages API's authorization_token working.
  const oauthClaims = oauth.verifyAccessToken(presented);
  if (!oauthClaims && !isAuthorized(req, authToken)) {
    // The challenge is what tells a client where to discover the auth server;
    // without it Claude cannot begin the flow at all.
    res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': oauth.wwwAuthenticate('invalid_token', 'A valid access token is required.') });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  if (!config) {
    sendJson(res, 503, { error: `Server is running but not configured: ${configError}` });
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
  log(`Public URL for connectors: ${publicBaseUrl}/mcp (OAuth discovery at ${publicBaseUrl}/.well-known/oauth-protected-resource)`);
  if (!config) {
    log(`NOT CONFIGURED: ${configError}`);
    log('The server is up and /health answers, so the deploy is live and you have a hostname. Set the credentials, then redeploy.');
  }
  if (config?.oauth) {
    log(`Agency OAuth mode. Install callback: /oauth/callback. Token store: ${config.oauth.store.describe}.`);
    if (!process.env.GHL_TOKEN_STORE?.trim()) {
      log('WARNING: GHL_TOKEN_STORE is not set. HighLevel rotates the refresh token on every exchange, so this instance will lose the agency connection on restart and need re-authorising. Point it at a persistent disk.');
    }
    if (!config.oauth?.appId) {
      log('Note: GHL_APP_ID is not set, so ghl_list_locations cannot enumerate installed sub-accounts. Location ids still work.');
    }
  }
  log(`Accepted Host headers: ${allowedHosts.join(', ')} (add more with MCP_ALLOWED_HOSTS).`);
  if (!LOOPBACK_HOSTS.has(host)) {
    log(`MCP_BIND_HOST=${host} exposes this process beyond the machine. Terminate TLS in front of it: the bearer token and every CRM record cross the wire in cleartext otherwise.`);
  }
});

/**
 * OAuth 2.1 for the MCP endpoint.
 *
 * Claude's custom-connector UI takes a server URL and, optionally, an OAuth
 * client id and secret. It has no field for a static bearer token, so the
 * MCP_AUTH_TOKEN header gate — fine for curl and for the Messages API, which
 * accepts an `authorization_token` — cannot be used from that UI at all. To be
 * reachable as a connector, this server has to be an OAuth 2.1 resource server
 * with an authorization server it can point at, per the MCP authorization spec.
 *
 * Both roles live in this process. The design is deliberately stateless: every
 * artefact the flow issues (client id, authorization code, access token, refresh
 * token) is a value signed with a key derived from MCP_AUTH_TOKEN, so nothing
 * needs the disk, a restart never invalidates a working connector, and the
 * persistent-disk single-instance constraint is not made any tighter than the
 * GoHighLevel refresh token already makes it.
 *
 * The one piece of server-side state is a set of spent authorization codes,
 * which only has to outlive the codes themselves (60 seconds).
 */

import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

export const MCP_SCOPE = 'mcp';
const ACCESS_TOKEN_TTL_S = 3600;
const REFRESH_TOKEN_TTL_S = 60 * 60 * 24 * 30;
const CODE_TTL_S = 60;

type Purpose = 'client' | 'code' | 'access' | 'refresh';

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function fromB64url(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Signs a payload into a self-describing, tamper-evident string.
 * `purpose` is inside the MAC so an access token can never be replayed as a
 * refresh token, or a client id as an authorization code.
 */
export class Signer {
  private readonly key: Buffer;

  constructor(secret: string) {
    // The signing key is derived, not the raw token: if a signed value ever
    // leaked it must not hand back the bearer secret Render generated.
    this.key = createHmac('sha256', 'ghl-mcp-oauth/v1').update(secret).digest();
  }

  sign(purpose: Purpose, payload: Record<string, unknown>): string {
    const body = b64url(JSON.stringify({ ...payload, p: purpose }));
    const mac = b64url(createHmac('sha256', this.key).update(`${purpose}.${body}`).digest());
    return `${body}.${mac}`;
  }

  verify<T = Record<string, unknown>>(purpose: Purpose, value: string | undefined | null): T | undefined {
    if (!value) return undefined;
    const [body, mac] = value.split('.');
    if (!body || !mac) return undefined;
    const expected = b64url(createHmac('sha256', this.key).update(`${purpose}.${body}`).digest());
    if (!constantTimeEqual(mac, expected)) return undefined;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(fromB64url(body).toString('utf8')) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    if (parsed.p !== purpose) return undefined;
    if (typeof parsed.exp === 'number' && parsed.exp * 1000 < Date.now()) return undefined;
    return parsed as T;
  }
}

export interface RegisteredClient {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method: 'none' | 'client_secret_post' | 'client_secret_basic';
}

export interface AccessTokenClaims {
  sub: string;
  aud: string;
  scope: string;
  exp: number;
  client_id: string;
}

export interface OAuthProviderOptions {
  /** Public base URL of this server, e.g. https://x.onrender.com (no trailing slash). */
  issuer: string;
  /** Shared secret proving the person may authorise a connector. */
  adminToken: string;
  now?: () => number;
}

export class McpOAuthProvider {
  private readonly signer: Signer;
  private readonly options: OAuthProviderOptions;
  private readonly now: () => number;
  /** Authorization codes already exchanged. OAuth 2.1 requires single use. */
  private readonly spentCodes = new Map<string, number>();

  constructor(options: OAuthProviderOptions) {
    this.options = options;
    this.signer = new Signer(options.adminToken);
    this.now = options.now ?? Date.now;
  }

  get issuer(): string {
    return this.options.issuer;
  }

  /** The canonical resource identifier clients bind their tokens to (RFC 8707). */
  get resourceUri(): string {
    return `${this.options.issuer}/mcp`;
  }

  /** RFC 9728 — how a client discovers which authorization server guards this resource. */
  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.resourceUri,
      authorization_servers: [this.options.issuer],
      scopes_supported: [MCP_SCOPE],
      bearer_methods_supported: ['header'],
    };
  }

  /** RFC 8414 — what this authorization server supports. */
  authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.options.issuer,
      authorization_endpoint: `${this.options.issuer}/authorize`,
      token_endpoint: `${this.options.issuer}/token`,
      registration_endpoint: `${this.options.issuer}/register`,
      scopes_supported: [MCP_SCOPE],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      // OAuth 2.1 makes PKCE mandatory, and S256 is the only method offered:
      // "plain" exists in the RFC but provides no protection worth the branch.
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      // RFC 9207: advertised because the iss parameter is emitted below, which is
      // what lets a client detect a mix-up between authorization servers.
      authorization_response_iss_parameter_supported: true,
    };
  }

  /**
   * RFC 7591 dynamic client registration. The client id is itself a signed
   * document carrying the redirect URIs, so no registry has to be stored or
   * survive a restart — verifying the id re-establishes what was registered.
   */
  register(request: Record<string, unknown>): RegisteredClient {
    const redirectUris = Array.isArray(request.redirect_uris) ? (request.redirect_uris as unknown[]) : [];
    const uris = redirectUris.filter((uri): uri is string => typeof uri === 'string' && uri.length > 0);
    if (!uris.length) {
      throw new OAuthError('invalid_redirect_uri', 'redirect_uris is required and must contain at least one URI.');
    }
    for (const uri of uris) {
      let parsed: URL;
      try {
        parsed = new URL(uri);
      } catch {
        throw new OAuthError('invalid_redirect_uri', `Not a valid absolute URI: ${uri}`);
      }
      // Loopback is allowed for native clients; everything else must be https,
      // or an authorization code could be redirected over cleartext.
      const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
      if (parsed.protocol !== 'https:' && !loopback) {
        throw new OAuthError('invalid_redirect_uri', `Redirect URIs must use https (or loopback): ${uri}`);
      }
    }
    const name = typeof request.client_name === 'string' ? request.client_name : undefined;
    const client_id = this.signer.sign('client', { u: uris, n: name });
    return {
      client_id,
      redirect_uris: uris,
      ...(name ? { client_name: name } : {}),
      // Public client with PKCE: no secret to leak, and PKCE is what binds the
      // code to the requester anyway.
      token_endpoint_auth_method: 'none',
    };
  }

  clientFor(clientId: string | undefined): RegisteredClient | undefined {
    const payload = this.signer.verify<{ u: string[]; n?: string }>('client', clientId);
    if (!payload || !Array.isArray(payload.u)) return undefined;
    return {
      client_id: clientId as string,
      redirect_uris: payload.u,
      ...(payload.n ? { client_name: payload.n } : {}),
      token_endpoint_auth_method: 'none',
    };
  }

  /** Checks the person is allowed to authorise, using the server's bearer secret. */
  isAdmin(secret: string | undefined | null): boolean {
    return Boolean(secret) && constantTimeEqual(String(secret), this.options.adminToken);
  }

  issueCode(params: { clientId: string; redirectUri: string; codeChallenge: string; scope: string; resource?: string }): string {
    return this.signer.sign('code', {
      c: params.clientId,
      r: params.redirectUri,
      q: params.codeChallenge,
      s: params.scope,
      a: params.resource ?? this.resourceUri,
      exp: Math.floor(this.now() / 1000) + CODE_TTL_S,
      j: randomBytes(8).toString('hex'),
    });
  }

  /**
   * Exchanges a code for tokens. Enforces the three things that make an
   * authorization code safe: single use, PKCE binding, and that the redirect URI
   * matches the one the code was issued for.
   */
  exchangeCode(params: { code: string; codeVerifier?: string; redirectUri?: string; clientId?: string; resource?: string }): TokenResponse {
    const claims = this.signer.verify<{ c: string; r: string; q: string; s: string; a: string; j: string; exp: number }>('code', params.code);
    if (!claims) throw new OAuthError('invalid_grant', 'The authorization code is invalid or has expired.');

    this.sweepSpentCodes();
    if (this.spentCodes.has(claims.j)) {
      // Replay. OAuth 2.1 requires refusal; the honest read is that the code
      // leaked, so nothing is issued.
      throw new OAuthError('invalid_grant', 'This authorization code has already been used.');
    }
    if (params.clientId && params.clientId !== claims.c) {
      throw new OAuthError('invalid_grant', 'The authorization code was issued to a different client.');
    }
    if (params.redirectUri && params.redirectUri !== claims.r) {
      throw new OAuthError('invalid_grant', 'redirect_uri does not match the one used in the authorization request.');
    }
    if (!params.codeVerifier) throw new OAuthError('invalid_request', 'code_verifier is required (PKCE).');
    const computed = b64url(createHash('sha256').update(params.codeVerifier).digest());
    if (!constantTimeEqual(computed, claims.q)) {
      throw new OAuthError('invalid_grant', 'PKCE verification failed.');
    }
    // A mismatched resource would mint a token for an audience the user never
    // approved, which is the whole point of RFC 8707.
    if (params.resource && params.resource !== claims.a) {
      throw new OAuthError('invalid_target', 'resource does not match the authorization request.');
    }

    this.spentCodes.set(claims.j, this.now() + CODE_TTL_S * 1000);
    return this.issueTokens(claims.c, claims.s, claims.a);
  }

  refresh(params: { refreshToken: string; clientId?: string; resource?: string }): TokenResponse {
    const claims = this.signer.verify<{ c: string; s: string; a: string }>('refresh', params.refreshToken);
    if (!claims) throw new OAuthError('invalid_grant', 'The refresh token is invalid or has expired.');
    if (params.clientId && params.clientId !== claims.c) {
      throw new OAuthError('invalid_grant', 'The refresh token was issued to a different client.');
    }
    if (params.resource && params.resource !== claims.a) {
      throw new OAuthError('invalid_target', 'resource does not match the original grant.');
    }
    return this.issueTokens(claims.c, claims.s, claims.a);
  }

  private issueTokens(clientId: string, scope: string, audience: string): TokenResponse {
    const seconds = Math.floor(this.now() / 1000);
    const access_token = this.signer.sign('access', {
      sub: 'connector',
      c: clientId,
      s: scope,
      a: audience,
      exp: seconds + ACCESS_TOKEN_TTL_S,
    });
    const refresh_token = this.signer.sign('refresh', {
      c: clientId,
      s: scope,
      a: audience,
      exp: seconds + REFRESH_TOKEN_TTL_S,
    });
    return { access_token, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_S, refresh_token, scope };
  }

  /**
   * Resource-server side: validate a bearer token presented to /mcp. The
   * audience check is what stops a token minted for some other resource by the
   * same authorization server from being replayed here.
   */
  verifyAccessToken(token: string | undefined): AccessTokenClaims | undefined {
    const claims = this.signer.verify<{ sub: string; c: string; s: string; a: string; exp: number }>('access', token);
    if (!claims) return undefined;
    if (claims.a !== this.resourceUri) return undefined;
    return { sub: claims.sub, aud: claims.a, scope: claims.s, exp: claims.exp, client_id: claims.c };
  }

  /** RFC 6750 challenge pointing the client at discovery. */
  wwwAuthenticate(error?: string, description?: string): string {
    const parts = [
      `Bearer resource_metadata="${this.options.issuer}/.well-known/oauth-protected-resource"`,
      `scope="${MCP_SCOPE}"`,
    ];
    if (error) parts.push(`error="${error}"`);
    if (description) parts.push(`error_description="${description.replace(/"/g, "'")}"`);
    return parts.join(', ');
  }

  private sweepSpentCodes(): void {
    const cutoff = this.now();
    for (const [id, expiry] of this.spentCodes) {
      if (expiry < cutoff) this.spentCodes.delete(id);
    }
  }
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export class OAuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
    this.status = status;
  }
}

/**
 * The consent screen. Deliberately plain HTML and deliberately not a "click to
 * approve" button: approving grants a connector full access to every configured
 * GoHighLevel sub-account, so it asks for the server's own secret as proof that
 * whoever reached this URL is the operator rather than someone who was sent it.
 */
export function consentPage(params: { clientName?: string; query: string; error?: string }): string {
  const name = (params.clientName ?? 'An MCP client').replace(/[<>&]/g, '');
  const error = params.error
    ? `<p class="err">${params.error.replace(/[<>&]/g, '')}</p>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize connector</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 system-ui, -apple-system, sans-serif; max-width: 30rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.2rem; margin-bottom: .25rem; }
  p { color: #555; } @media (prefers-color-scheme: dark) { p { color: #aaa; } body { background: #111; color: #eee; } }
  ul { color: #555; padding-left: 1.1rem; } @media (prefers-color-scheme: dark) { ul { color: #aaa; } }
  input { width: 100%; padding: .6rem; font-size: 1rem; margin: .75rem 0; box-sizing: border-box; }
  button { padding: .6rem 1.1rem; font-size: 1rem; cursor: pointer; }
  .err { color: #b00020; font-weight: 600; } @media (prefers-color-scheme: dark) { .err { color: #ff6b6b; } }
</style></head><body>
<h1>Authorize ${name}</h1>
<p>This will let the connector use every GoHighLevel sub-account this server is configured for, including writes if they are enabled.</p>
${error}
<form method="POST" action="/authorize?${params.query}">
  <label for="secret">Server auth token</label>
  <input id="secret" name="secret" type="password" autocomplete="off" autofocus placeholder="MCP_AUTH_TOKEN">
  <button type="submit">Authorize</button>
</form>
<p style="font-size:.85rem">This is the <code>MCP_AUTH_TOKEN</code> from your hosting dashboard. It is checked here and never stored by the client.</p>
</body></html>`;
}

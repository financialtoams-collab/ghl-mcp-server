import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { McpOAuthProvider, OAuthError, Signer } from '../src/mcp-oauth.ts';

const ISSUER = 'https://ghl.example.com';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function provider(now?: () => number): McpOAuthProvider {
  return new McpOAuthProvider({ issuer: ISSUER, adminToken: 'supersecret', ...(now ? { now } : {}) });
}

function pkce(verifier = 'verifier-verifier-verifier-verifier'): { verifier: string; challenge: string } {
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function authorize(p: McpOAuthProvider, overrides: Partial<{ clientId: string; redirectUri: string; challenge: string }> = {}) {
  const client = p.register({ redirect_uris: [REDIRECT], client_name: 'Claude' });
  const { verifier, challenge } = pkce();
  const code = p.issueCode({
    clientId: overrides.clientId ?? client.client_id,
    redirectUri: overrides.redirectUri ?? REDIRECT,
    codeChallenge: overrides.challenge ?? challenge,
    scope: 'mcp',
  });
  return { client, code, verifier };
}

test('a signed value cannot be replayed for a different purpose', () => {
  const signer = new Signer('secret');
  const token = signer.sign('access', { sub: 'a' });
  assert.ok(signer.verify('access', token), 'verifies for its own purpose');
  // Without purpose in the MAC, an access token would be accepted as a refresh
  // token, which is a privilege escalation from one hour to thirty days.
  assert.equal(signer.verify('refresh', token), undefined);
  assert.equal(signer.verify('code', token), undefined);
});

test('a tampered or foreign-signed value is rejected', () => {
  const signer = new Signer('secret');
  const token = signer.sign('access', { sub: 'a' });
  const [body, mac] = token.split('.');
  assert.equal(signer.verify('access', `${body}x.${mac}`), undefined, 'payload tampering');
  assert.equal(signer.verify('access', `${body}.${mac.slice(0, -1)}A`), undefined, 'signature tampering');
  assert.equal(new Signer('different-secret').verify('access', token), undefined, 'signed by another key');
});

test('expired values stop verifying', () => {
  const signer = new Signer('secret');
  const expired = signer.sign('access', { exp: Math.floor(Date.now() / 1000) - 5 });
  assert.equal(signer.verify('access', expired), undefined);
});

test('registration rejects redirect URIs that are not https or loopback', () => {
  const p = provider();
  assert.throws(() => p.register({ redirect_uris: ['http://evil.example.com/cb'] }), /must use https/);
  assert.throws(() => p.register({ redirect_uris: [] }), /redirect_uris is required/);
  assert.throws(() => p.register({ redirect_uris: ['not a uri'] }), /valid absolute URI/);
  // Native clients legitimately use loopback.
  assert.ok(p.register({ redirect_uris: ['http://127.0.0.1:8080/cb'] }).client_id);
  assert.ok(p.register({ redirect_uris: ['https://claude.ai/cb'] }).client_id);
});

test('the client id carries its own registration, so nothing is stored', () => {
  const p = provider();
  const client = p.register({ redirect_uris: [REDIRECT], client_name: 'Claude' });
  // A different provider instance with the same secret is what a restarted
  // container is: the client must still resolve, or every connector breaks on deploy.
  const afterRestart = provider().clientFor(client.client_id);
  assert.deepEqual(afterRestart?.redirect_uris, [REDIRECT]);
  assert.equal(afterRestart?.client_name, 'Claude');
  assert.equal(provider().clientFor('made-up-id'), undefined);
});

test('a code exchanges once, with the right verifier, and never again', () => {
  const p = provider();
  const { client, code, verifier } = authorize(p);
  const tokens = p.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT, clientId: client.client_id });
  assert.equal(tokens.token_type, 'Bearer');
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.throws(
    () => p.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT, clientId: client.client_id }),
    /already been used/,
  );
});

test('PKCE, redirect URI and client are all enforced at exchange', () => {
  const p = provider();
  const { client, code, verifier } = authorize(p);
  assert.throws(() => p.exchangeCode({ code, codeVerifier: 'wrong', redirectUri: REDIRECT, clientId: client.client_id }), /PKCE/);
  assert.throws(() => p.exchangeCode({ code, codeVerifier: verifier, redirectUri: 'https://elsewhere.test/cb' }), /redirect_uri does not match/);
  assert.throws(() => p.exchangeCode({ code, codeVerifier: verifier, clientId: 'someone-else' }), /different client/);
  assert.throws(() => p.exchangeCode({ code, clientId: client.client_id }), /code_verifier is required/);
});

test('an access token is bound to this resource as its audience', () => {
  const p = provider();
  const { client, code, verifier } = authorize(p);
  const tokens = p.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT, clientId: client.client_id });

  const claims = p.verifyAccessToken(tokens.access_token);
  assert.equal(claims?.aud, `${ISSUER}/mcp`);
  assert.equal(claims?.scope, 'mcp');

  // The same secret guarding a different resource must not accept this token —
  // that audience check is the point of RFC 8707.
  const other = new McpOAuthProvider({ issuer: 'https://other.example.com', adminToken: 'supersecret' });
  assert.equal(other.verifyAccessToken(tokens.access_token), undefined);
});

test('a refresh token is not accepted as an access token', () => {
  const p = provider();
  const { client, code, verifier } = authorize(p);
  const tokens = p.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT, clientId: client.client_id });
  assert.equal(p.verifyAccessToken(tokens.refresh_token), undefined);
});

test('refresh issues a new access token and rejects a wrong client', () => {
  const p = provider();
  const { client, code, verifier } = authorize(p);
  const first = p.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT, clientId: client.client_id });
  const again = p.refresh({ refreshToken: first.refresh_token, clientId: client.client_id });
  assert.ok(p.verifyAccessToken(again.access_token));
  assert.throws(() => p.refresh({ refreshToken: first.refresh_token, clientId: 'other' }), /different client/);
  assert.throws(() => p.refresh({ refreshToken: 'nonsense' }), /invalid or has expired/);
});

test('an expired code cannot be exchanged', () => {
  let now = 1_000_000_000_000;
  const p = provider(() => now);
  const { client, code, verifier } = authorize(p);
  now += 61_000; // codes live 60s
  assert.throws(() => p.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT, clientId: client.client_id }), /invalid or has expired/);
});

test('the admin check is what gates issuing a grant', () => {
  const p = provider();
  assert.equal(p.isAdmin('supersecret'), true);
  assert.equal(p.isAdmin('supersecre'), false);
  assert.equal(p.isAdmin(''), false);
  assert.equal(p.isAdmin(undefined), false);
});

test('discovery documents point at this issuer and demand PKCE', () => {
  const p = provider();
  const prm = p.protectedResourceMetadata();
  assert.equal(prm.resource, `${ISSUER}/mcp`);
  assert.deepEqual(prm.authorization_servers, [ISSUER]);

  const asm = p.authorizationServerMetadata();
  assert.equal(asm.issuer, ISSUER);
  assert.deepEqual(asm.code_challenge_methods_supported, ['S256'], 'plain PKCE must not be offered');
  assert.equal(asm.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(asm.grant_types_supported, ['authorization_code', 'refresh_token']);
});

test('the challenge header tells a client where to discover the auth server', () => {
  const header = provider().wwwAuthenticate('invalid_token', 'nope');
  assert.match(header, /^Bearer resource_metadata="https:\/\/ghl\.example\.com\/\.well-known\/oauth-protected-resource"/);
  assert.match(header, /scope="mcp"/);
  assert.match(header, /error="invalid_token"/);
});

test('OAuthError carries an OAuth error code and status', () => {
  const error = new OAuthError('invalid_grant', 'nope');
  assert.equal(error.code, 'invalid_grant');
  assert.equal(error.status, 400);
});

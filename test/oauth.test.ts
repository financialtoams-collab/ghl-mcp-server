import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AgencyAuth,
  discoverInstalledLocations,
  FileTokenStore,
  LocationDirectory,
  LocationTokenCache,
  MemoryTokenStore,
} from '../src/oauth.ts';

const BASE = 'https://services.leadconnectorhq.com';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Fetch stub that records calls and replies from a queue of handlers. */
function stubFetch(handlers: Array<(req: Recorded) => { status?: number; body: unknown }>): {
  fetchImpl: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const recorded: Recorded = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body ? String(init.body) : undefined,
    };
    calls.push(recorded);
    const handler = handlers[Math.min(index, handlers.length - 1)];
    index += 1;
    const { status = 200, body } = handler(recorded);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms: number) => { current += ms; } };
}

test('agency auth exchanges the refresh token and persists the rotated one', async () => {
  const store = new MemoryTokenStore();
  const { fetchImpl, calls } = stubFetch([
    () => ({ body: { access_token: 'agency-1', refresh_token: 'rotated-1', expires_in: 86400, companyId: 'CO1' } }),
  ]);
  const auth = new AgencyAuth({ clientId: 'cid', clientSecret: 'secret', baseUrl: BASE, store, seedRefreshToken: 'seed', fetchImpl });

  assert.equal(await auth.token(), 'agency-1');
  assert.equal(auth.companyId, 'CO1', 'companyId is learned from the exchange');

  const body = new URLSearchParams(calls[0].body);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'seed');
  assert.equal(body.get('user_type'), 'Company');

  // HighLevel rotates on every exchange; dropping the new one strands the install.
  assert.equal((await store.read())?.refreshToken, 'rotated-1');
});

test('the agency access token is cached until it nears expiry', async () => {
  const time = clock();
  const { fetchImpl, calls } = stubFetch([
    () => ({ body: { access_token: 'agency-1', refresh_token: 'r1', expires_in: 3600 } }),
    () => ({ body: { access_token: 'agency-2', refresh_token: 'r2', expires_in: 3600 } }),
  ]);
  const auth = new AgencyAuth({
    clientId: 'cid', clientSecret: 's', baseUrl: BASE, store: new MemoryTokenStore(),
    seedRefreshToken: 'seed', fetchImpl, now: time.now,
  });

  assert.equal(await auth.token(), 'agency-1');
  assert.equal(await auth.token(), 'agency-1');
  assert.equal(calls.length, 1, 'a cached token must not re-exchange');

  time.advance(3600 * 1000);
  assert.equal(await auth.token(), 'agency-2', 'expired token is refreshed');
  assert.equal(calls.length, 2);
});

test('concurrent callers share one token exchange', async () => {
  const { fetchImpl, calls } = stubFetch([
    () => ({ body: { access_token: 'agency-1', refresh_token: 'r1', expires_in: 3600 } }),
  ]);
  const auth = new AgencyAuth({
    clientId: 'c', clientSecret: 's', baseUrl: BASE, store: new MemoryTokenStore(), seedRefreshToken: 'seed', fetchImpl,
  });

  // Parallel tool calls must not each rotate the refresh token; the losers of
  // that race would be left holding an already-invalidated token.
  const tokens = await Promise.all([auth.token(), auth.token(), auth.token()]);
  assert.deepEqual(tokens, ['agency-1', 'agency-1', 'agency-1']);
  assert.equal(calls.length, 1, 'three callers, one exchange');
});

test('a rejected refresh token explains that it was rotated or lost', async () => {
  const { fetchImpl } = stubFetch([() => ({ status: 400, body: { message: 'invalid_grant' } })]);
  const auth = new AgencyAuth({
    clientId: 'c', clientSecret: 's', baseUrl: BASE, store: new MemoryTokenStore(), seedRefreshToken: 'stale', fetchImpl,
  });
  await assert.rejects(auth.token(), /rotated by another running instance or lost from the token store/);
});

test('missing refresh token names the store instead of failing opaquely', async () => {
  const auth = new AgencyAuth({ clientId: 'c', clientSecret: 's', baseUrl: BASE, store: new MemoryTokenStore() });
  await assert.rejects(auth.token(), /No agency refresh token available/);
});

test('the file token store survives a restart and writes tightly scoped', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ghl-store-'));
  const file = path.join(dir, 'nested', 'tokens.json');
  const store = new FileTokenStore(file);
  const { fetchImpl } = stubFetch([
    () => ({ body: { access_token: 'a', refresh_token: 'persisted', expires_in: 60, companyId: 'CO9' } }),
  ]);
  const auth = new AgencyAuth({ clientId: 'c', clientSecret: 's', baseUrl: BASE, store, seedRefreshToken: 'seed', fetchImpl });
  await auth.token();

  // A fresh store over the same path is what a restarted container sees.
  const reopened = await new FileTokenStore(file).read();
  assert.equal(reopened?.refreshToken, 'persisted');
  assert.equal(reopened?.companyId, 'CO9');
  assert.match(await readFile(file, 'utf8'), /persisted/);
});

test('location tokens are minted per sub-account and cached until expiry', async () => {
  const time = clock();
  const { fetchImpl, calls } = stubFetch([
    () => ({ body: { access_token: 'agency-1', refresh_token: 'r', expires_in: 86400, companyId: 'CO1' } }),
    () => ({ body: { access_token: 'loc-A-1', expires_in: 3600 } }),
    () => ({ body: { access_token: 'loc-B-1', expires_in: 3600 } }),
    () => ({ body: { access_token: 'loc-A-2', expires_in: 3600 } }),
  ]);
  const auth = new AgencyAuth({
    clientId: 'c', clientSecret: 's', baseUrl: BASE, store: new MemoryTokenStore(),
    seedRefreshToken: 'seed', fetchImpl, now: time.now,
  });
  const cache = new LocationTokenCache(auth, { baseUrl: BASE, fetchImpl, now: time.now });

  assert.equal(await cache.tokenFor('LOC_A'), 'loc-A-1');
  assert.equal(await cache.tokenFor('LOC_B'), 'loc-B-1', 'each sub-account gets its own token');
  assert.equal(await cache.tokenFor('LOC_A'), 'loc-A-1', 'cached, not re-minted');
  assert.equal(cache.size, 2);

  const mintCall = calls[1];
  assert.match(mintCall.url, /\/oauth\/locationToken$/);
  assert.equal(mintCall.headers.Version, '2021-07-28', 'the Version header is required by the spec');
  assert.equal(mintCall.headers.Authorization, 'Bearer agency-1', 'minting uses the agency token');
  const body = new URLSearchParams(mintCall.body);
  assert.equal(body.get('companyId'), 'CO1');
  assert.equal(body.get('locationId'), 'LOC_A');

  time.advance(3600 * 1000);
  assert.equal(await cache.tokenFor('LOC_A'), 'loc-A-2', 'expired location token is re-minted');
});

test('a location token refusal points at the app not being installed there', async () => {
  const { fetchImpl } = stubFetch([
    () => ({ body: { access_token: 'agency-1', refresh_token: 'r', expires_in: 86400, companyId: 'CO1' } }),
    () => ({ status: 401, body: { message: 'Unauthorized' } }),
  ]);
  const auth = new AgencyAuth({
    clientId: 'c', clientSecret: 's', baseUrl: BASE, store: new MemoryTokenStore(), seedRefreshToken: 'seed', fetchImpl,
  });
  const cache = new LocationTokenCache(auth, { baseUrl: BASE, fetchImpl });
  await assert.rejects(cache.tokenFor('LOC_X'), /not installed on sub-account LOC_X/);
});

test('discovery walks every page of installed sub-accounts', async () => {
  const page = (n: number, count: number) =>
    ({ body: { locations: Array.from({ length: count }, (_, i) => ({ _id: `L${n * 100 + i}`, name: `Client ${n * 100 + i}` })) } });
  let call = 0;
  const { fetchImpl, calls } = stubFetch([
    () => ({ body: { access_token: 'agency-1', refresh_token: 'r', expires_in: 86400, companyId: 'CO1' } }),
    () => { call += 1; return call === 1 ? page(0, 100) : page(1, 7); },
  ]);
  const auth = new AgencyAuth({
    clientId: 'c', clientSecret: 's', baseUrl: BASE, store: new MemoryTokenStore(), seedRefreshToken: 'seed', fetchImpl,
  });

  // An agency with 50+ sub-accounts is the whole reason this mode exists, so a
  // first-page-only implementation would silently hide most of them.
  const found = await discoverInstalledLocations(auth, { baseUrl: BASE, appId: 'APP1', fetchImpl });
  assert.equal(found.length, 107);
  assert.equal(found[0].name, 'Client 0');
  const listUrls = calls.filter((c) => c.url.includes('installedLocations')).map((c) => new URL(c.url));
  assert.equal(listUrls[0].searchParams.get('skip'), '0');
  assert.equal(listUrls[1].searchParams.get('skip'), '100');
  assert.equal(listUrls[0].searchParams.get('appId'), 'APP1');
});

test('discovery stops rather than looping when the cursor does not advance', async () => {
  const same = { body: { locations: Array.from({ length: 100 }, () => ({ _id: 'SAME', name: 'Stuck' })) } };
  const { fetchImpl } = stubFetch([
    () => ({ body: { access_token: 'a', refresh_token: 'r', expires_in: 86400, companyId: 'CO1' } }),
    () => same,
  ]);
  const auth = new AgencyAuth({
    clientId: 'c', clientSecret: 's', baseUrl: BASE, store: new MemoryTokenStore(), seedRefreshToken: 'seed', fetchImpl,
  });
  const found = await discoverInstalledLocations(auth, { baseUrl: BASE, appId: 'A', fetchImpl, maxPages: 3 });
  assert.equal(found.length, 1, 'duplicates across pages are collapsed, not accumulated');
});

test('the directory resolves a sub-account by name, case and punctuation aside', async () => {
  const time = clock();
  const { fetchImpl, calls } = stubFetch([
    () => ({ body: { access_token: 'a', refresh_token: 'r', expires_in: 86400, companyId: 'CO1' } }),
    () => ({ body: { locations: [
      { _id: 'LOC_TOAMS', name: 'Toams Financial' },
      { _id: 'LOC_SOLACE', name: 'Solace Care Advocates' },
    ] } }),
  ]);
  const auth = new AgencyAuth({
    clientId: 'c', clientSecret: 's', baseUrl: BASE, store: new MemoryTokenStore(), seedRefreshToken: 'seed', fetchImpl, now: time.now,
  });
  const directory = new LocationDirectory(auth, { baseUrl: BASE, appId: 'APP1', fetchImpl, now: time.now });

  assert.equal((await directory.resolve('Toams Financial'))?.locationId, 'LOC_TOAMS');
  assert.equal((await directory.resolve('toams'))?.locationId, 'LOC_TOAMS', 'partial match when unambiguous');
  assert.equal((await directory.resolve('LOC_SOLACE'))?.locationId, 'LOC_SOLACE', 'a raw id still works');
  assert.equal(await directory.resolve('nope'), undefined);

  const before = calls.length;
  await directory.resolve('toams');
  assert.equal(calls.length, before, 'the list is cached, not refetched per lookup');

  const listed = await directory.describe();
  assert.equal(JSON.stringify(listed).includes('access_token'), false, 'no credential may reach a tool result');
});

test('an ambiguous name resolves to nothing rather than the wrong CRM', async () => {
  const { fetchImpl } = stubFetch([
    () => ({ body: { access_token: 'a', refresh_token: 'r', expires_in: 86400, companyId: 'CO1' } }),
    () => ({ body: { locations: [
      { _id: 'L1', name: 'Relax Estate' },
      { _id: 'L2', name: 'Relax Investor' },
    ] } }),
  ]);
  const auth = new AgencyAuth({
    clientId: 'c', clientSecret: 's', baseUrl: BASE, store: new MemoryTokenStore(), seedRefreshToken: 'seed', fetchImpl,
  });
  const directory = new LocationDirectory(auth, { baseUrl: BASE, appId: 'A', fetchImpl });
  // "relax" matches both. Picking one would send a write to a coin flip.
  assert.equal(await directory.resolve('relax'), undefined);
  assert.equal((await directory.resolve('Relax Estate'))?.locationId, 'L1', 'the exact name still resolves');
});

test('the token exchange falls back to JSON when form encoding is refused', async () => {
  // HighLevel's spec says form-urlencoded; their docs show JSON. This runs once,
  // during an install, so a wrong guess would strand the whole setup.
  const seen: string[] = [];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const contentType = (init?.headers as Record<string, string>)['Content-Type'];
    seen.push(contentType);
    if (contentType === 'application/x-www-form-urlencoded') {
      return new Response(JSON.stringify({ message: 'Unsupported Media Type' }), { status: 415 });
    }
    return new Response(JSON.stringify({ access_token: 'via-json', refresh_token: 'r', expires_in: 3600, companyId: 'CO1' }));
  }) as unknown as typeof fetch;

  const auth = new AgencyAuth({
    clientId: 'c', clientSecret: 's', baseUrl: BASE, store: new MemoryTokenStore(), seedRefreshToken: 'seed', fetchImpl,
  });
  assert.equal(await auth.token(), 'via-json');
  assert.deepEqual(seen, ['application/x-www-form-urlencoded', 'application/json'], 'spec encoding first, docs encoding second');
});

test('the location token mint falls back to JSON too', async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const contentType = (init?.headers as Record<string, string>)['Content-Type'];
    if (String(url).endsWith('/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'agency', refresh_token: 'r', expires_in: 3600, companyId: 'CO1' }));
    }
    seen.push(contentType);
    if (contentType === 'application/x-www-form-urlencoded') {
      return new Response(JSON.stringify({ message: 'Bad Request' }), { status: 400 });
    }
    return new Response(JSON.stringify({ access_token: 'loc-via-json', expires_in: 3600 }));
  }) as unknown as typeof fetch;

  const auth = new AgencyAuth({
    clientId: 'c', clientSecret: 's', baseUrl: BASE, store: new MemoryTokenStore(), seedRefreshToken: 'seed', fetchImpl,
  });
  const cache = new LocationTokenCache(auth, { baseUrl: BASE, fetchImpl });
  assert.equal(await cache.tokenFor('LOC1'), 'loc-via-json');
  assert.deepEqual(seen, ['application/x-www-form-urlencoded', 'application/json']);
});

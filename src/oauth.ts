/**
 * Agency OAuth mode.
 *
 * The PIT registry in locations.ts needs one token per sub-account, created by
 * hand. That stops scaling somewhere around a dozen. This module is the other
 * way in: one marketplace app installed on the agency mints a location token for
 * any sub-account on demand, so new sub-accounts work with no config change.
 *
 * Why it has to be OAuth and not an agency Private Integration Token: in
 * HighLevel's own specs, POST /oauth/locationToken is one of three
 * `Agency-Access-Only` endpoints, described as "Access Token generated with user
 * type as Agency" — pointedly without the "(OR) Private Integration Token of
 * Agency" clause that `Agency-Access` endpoints carry. An agency PIT cannot mint
 * location tokens, and cannot call sub-account endpoints either.
 */

import { GhlApiError } from './client.ts';
import { normalizeAlias } from './locations.ts';

const OAUTH_VERSION = '2021-07-28';
/** Refresh this long before expiry so an in-flight request never races the clock. */
const EXPIRY_MARGIN_MS = 60_000;

export interface StoredTokens {
  refreshToken: string;
  updatedAt: string;
  companyId?: string;
}

/** Somewhere a rotated refresh token survives a restart. */
export interface TokenStore {
  read(): Promise<StoredTokens | undefined>;
  write(tokens: StoredTokens): Promise<void>;
  /** Human-readable location, for startup diagnostics. */
  readonly describe: string;
}

export class MemoryTokenStore implements TokenStore {
  readonly describe = 'memory (not durable — a restart loses the agency connection)';
  private tokens?: StoredTokens;
  async read(): Promise<StoredTokens | undefined> {
    return this.tokens;
  }
  async write(tokens: StoredTokens): Promise<void> {
    this.tokens = tokens;
  }
}

export class FileTokenStore implements TokenStore {
  readonly describe: string;
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
    this.describe = path;
  }
  async read(): Promise<StoredTokens | undefined> {
    const { readFile } = await import('node:fs/promises');
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as StoredTokens;
    } catch {
      return undefined;
    }
  }
  async write(tokens: StoredTokens): Promise<void> {
    const { mkdir, writeFile, rename } = await import('node:fs/promises');
    const path = await import('node:path');
    await mkdir(path.dirname(this.path), { recursive: true });
    // Write-then-rename: a crash mid-write must not leave a truncated token file,
    // which would be indistinguishable from "never authorised" on next boot.
    const temp = `${this.path}.tmp`;
    await writeFile(temp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    await rename(temp, this.path);
  }
}

export interface AgencyAuthOptions {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  store: TokenStore;
  /** Seed used on first boot, before the store holds anything. */
  seedRefreshToken?: string;
  companyId?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  companyId?: string;
  locationId?: string;
  userType?: string;
  [key: string]: unknown;
}

function formBody(fields: Record<string, string | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== '') params.set(key, value);
  }
  return params;
}

/**
 * Holds the agency access token and keeps it fresh. HighLevel rotates the
 * refresh token on every exchange, so each response's new refresh token is
 * persisted before the access token is handed out — losing that rotation means
 * the next restart cannot authenticate at all.
 */
export class AgencyAuth {
  private readonly options: AgencyAuthOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private accessToken?: string;
  private expiresAt = 0;
  private cachedCompanyId?: string;
  /** One in-flight refresh shared by all callers, so a burst of tool calls
   *  does not fire N concurrent exchanges and rotate the token out from under
   *  each other. */
  private inFlight?: Promise<string>;

  constructor(options: AgencyAuthOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.cachedCompanyId = options.companyId;
  }

  get companyId(): string | undefined {
    return this.cachedCompanyId;
  }

  async token(): Promise<string> {
    if (this.accessToken && this.now() < this.expiresAt - EXPIRY_MARGIN_MS) return this.accessToken;
    if (!this.inFlight) {
      this.inFlight = this.refresh().finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  private async currentRefreshToken(): Promise<string> {
    const stored = await this.options.store.read();
    const refreshToken = stored?.refreshToken || this.options.seedRefreshToken;
    if (!refreshToken) {
      throw new GhlApiError(
        401,
        `No agency refresh token available (store: ${this.options.store.describe}). Complete the marketplace app install to authorise the agency, or set GHL_REFRESH_TOKEN to seed it.`,
      );
    }
    if (stored?.companyId && !this.cachedCompanyId) this.cachedCompanyId = stored.companyId;
    return refreshToken;
  }

  private async refresh(): Promise<string> {
    const refreshToken = await this.currentRefreshToken();
    const data = await this.exchange({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      user_type: 'Company',
    });
    return this.absorb(data);
  }

  /** Completes the install redirect: authorization_code -> first refresh token. */
  async exchangeAuthorizationCode(code: string, redirectUri?: string): Promise<string> {
    const data = await this.exchange({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      grant_type: 'authorization_code',
      code,
      user_type: 'Company',
      redirect_uri: redirectUri,
    });
    return this.absorb(data);
  }

  private async absorb(data: TokenResponse): Promise<string> {
    if (!data.access_token) {
      throw new GhlApiError(502, 'HighLevel returned no access_token for the agency token exchange.');
    }
    if (data.companyId) this.cachedCompanyId = data.companyId;
    if (data.refresh_token) {
      // Persisted before the token is used: a crash after using it but before
      // saving would strand the install.
      await this.options.store.write({
        refreshToken: data.refresh_token,
        updatedAt: new Date(this.now()).toISOString(),
        ...(this.cachedCompanyId ? { companyId: this.cachedCompanyId } : {}),
      });
    }
    this.accessToken = data.access_token;
    this.expiresAt = this.now() + (data.expires_in ?? 86_400) * 1000;
    return data.access_token;
  }

  private async exchange(fields: Record<string, string | undefined>): Promise<TokenResponse> {
    const response = await this.fetchImpl(`${this.options.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: formBody(fields),
    });
    const text = await response.text();
    let data: TokenResponse;
    try {
      data = JSON.parse(text) as TokenResponse;
    } catch {
      throw new GhlApiError(response.status, `Agency token exchange returned non-JSON: ${text.slice(0, 200)}`);
    }
    if (!response.ok) {
      const message = typeof data.message === 'string' ? data.message : `${response.status} ${response.statusText}`;
      throw new GhlApiError(
        response.status,
        // 400 here almost always means the refresh token was already rotated by
        // another instance, or the store was wiped. Say so, since "invalid_grant"
        // alone sends people hunting for the wrong problem.
        response.status === 400
          ? `${message}. The agency refresh token was rejected — it has most likely been rotated by another running instance or lost from the token store (${this.options.store.describe}). Re-authorise the marketplace app.`
          : message,
      );
    }
    return data;
  }
}

interface CachedLocationToken {
  token: string;
  expiresAt: number;
}

/**
 * Mints and caches per-sub-account tokens. One agency credential in, a token for
 * any installed location out, refreshed on expiry.
 */
export class LocationTokenCache {
  private readonly agency: AgencyAuth;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, CachedLocationToken>();
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(agency: AgencyAuth, options: { baseUrl: string; fetchImpl?: typeof fetch; now?: () => number }) {
    this.agency = agency;
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async tokenFor(locationId: string): Promise<string> {
    const hit = this.cache.get(locationId);
    if (hit && this.now() < hit.expiresAt - EXPIRY_MARGIN_MS) return hit.token;
    const pending = this.inFlight.get(locationId);
    if (pending) return pending;
    const promise = this.mint(locationId).finally(() => this.inFlight.delete(locationId));
    this.inFlight.set(locationId, promise);
    return promise;
  }

  private async mint(locationId: string): Promise<string> {
    // The token exchange is what reports companyId, so it has to happen first.
    // Reading companyId before this is why a cold start used to fail outright.
    const agencyToken = await this.agency.token();
    const companyId = this.agency.companyId;
    if (!companyId) {
      throw new GhlApiError(400, 'No companyId known for the agency. Set GHL_COMPANY_ID, or re-authorise so the token exchange reports it.');
    }
    const response = await this.fetchImpl(`${this.baseUrl}/oauth/locationToken`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${agencyToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Version: OAUTH_VERSION,
        Accept: 'application/json',
      },
      body: formBody({ companyId, locationId }),
    });
    const text = await response.text();
    let data: TokenResponse;
    try {
      data = JSON.parse(text) as TokenResponse;
    } catch {
      throw new GhlApiError(response.status, `Location token exchange returned non-JSON: ${text.slice(0, 200)}`);
    }
    if (!response.ok || !data.access_token) {
      const message = typeof data.message === 'string' ? data.message : `${response.status} ${response.statusText}`;
      throw new GhlApiError(
        response.status,
        response.status === 401 || response.status === 403
          ? `${message}. The app is most likely not installed on sub-account ${locationId}, or the agency token lacks oauth.write.`
          : message,
      );
    }
    this.cache.set(locationId, {
      token: data.access_token,
      expiresAt: this.now() + (data.expires_in ?? 86_400) * 1000,
    });
    return data.access_token;
  }

  /** Test/diagnostic helper: how many sub-account tokens are currently held. */
  get size(): number {
    return this.cache.size;
  }
}

export interface DiscoveredLocation {
  locationId: string;
  name?: string;
}

/**
 * Lists the sub-accounts the app is installed on. Paginated: HighLevel caps the
 * page size, and an agency with hundreds of sub-accounts is exactly the case
 * this mode exists for, so every page is walked rather than just the first.
 */
export async function discoverInstalledLocations(
  agency: AgencyAuth,
  options: { baseUrl: string; appId: string; fetchImpl?: typeof fetch; pageSize?: number; maxPages?: number },
): Promise<DiscoveredLocation[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  // Same ordering rule as minting: authenticate first, then read companyId.
  const agencyToken = await agency.token();
  const companyId = agency.companyId;
  if (!companyId) throw new GhlApiError(400, 'No companyId known for the agency; set GHL_COMPANY_ID.');
  const limit = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 50;
  const found: DiscoveredLocation[] = [];
  const seen = new Set<string>();

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(`${options.baseUrl}/oauth/installedLocations`);
    url.searchParams.set('companyId', companyId);
    url.searchParams.set('appId', options.appId);
    url.searchParams.set('isInstalled', 'true');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('skip', String(page * limit));
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${agencyToken}`, Version: OAUTH_VERSION, Accept: 'application/json' },
    });
    const text = await response.text();
    let data: { locations?: Array<{ _id?: string; id?: string; name?: string }> };
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      throw new GhlApiError(response.status, `installedLocations returned non-JSON: ${text.slice(0, 200)}`);
    }
    if (!response.ok) {
      throw new GhlApiError(response.status, `Could not list installed sub-accounts: ${text.slice(0, 200)}`);
    }
    const batch = data.locations ?? [];
    for (const entry of batch) {
      const id = entry._id ?? entry.id;
      // A duplicate id across pages means the cursor is not advancing; stopping
      // beats looping until maxPages on a live agency account.
      if (!id || seen.has(id)) continue;
      seen.add(id);
      found.push({ locationId: id, ...(entry.name ? { name: entry.name } : {}) });
    }
    if (batch.length < limit) break;
  }
  return found;
}

/**
 * The live list of sub-accounts the app is installed on, cached briefly.
 *
 * This is what replaces the hand-written alias map once an agency has more
 * sub-accounts than anyone wants to paste into an env var. Names come from
 * HighLevel, so a model can say "toams" and reach the right CRM without the
 * location id ever being written down here.
 */
export class LocationDirectory {
  private readonly agency: AgencyAuth;
  private readonly options: { baseUrl: string; appId?: string; ttlMs?: number; fetchImpl?: typeof fetch; now?: () => number };
  private readonly now: () => number;
  private cached?: DiscoveredLocation[];
  private cachedAt = 0;
  private inFlight?: Promise<DiscoveredLocation[]>;

  constructor(agency: AgencyAuth, options: LocationDirectory['options']) {
    this.agency = agency;
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  private get ttl(): number {
    return this.options.ttlMs ?? 300_000;
  }

  async list(): Promise<DiscoveredLocation[]> {
    if (this.cached && this.now() - this.cachedAt < this.ttl) return this.cached;
    if (!this.inFlight) {
      this.inFlight = this.load().finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  private async load(): Promise<DiscoveredLocation[]> {
    if (!this.options.appId) {
      throw new GhlApiError(400, 'Set GHL_APP_ID to list installed sub-accounts (it is required by /oauth/installedLocations).');
    }
    const found = await discoverInstalledLocations(this.agency, {
      baseUrl: this.options.baseUrl,
      appId: this.options.appId,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });
    this.cached = found;
    this.cachedAt = this.now();
    return found;
  }

  /**
   * Accepts a location id or a sub-account name. Matching is tolerant — case and
   * punctuation differ between how a person says a name and how it is stored —
   * but never ambiguous: two equally good name matches resolve to neither.
   */
  async resolve(idOrName: string): Promise<DiscoveredLocation | undefined> {
    const raw = idOrName.trim();
    if (!raw) return undefined;
    let entries: DiscoveredLocation[];
    try {
      entries = await this.list();
    } catch {
      // Discovery is a convenience; a raw id must still work when it fails.
      return undefined;
    }
    const byId = entries.find((entry) => entry.locationId === raw);
    if (byId) return byId;
    const key = normalizeAlias(raw);
    const byName = entries.filter((entry) => entry.name && normalizeAlias(entry.name) === key);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) return undefined;
    const partial = entries.filter((entry) => entry.name && normalizeAlias(entry.name).includes(key));
    return partial.length === 1 ? partial[0] : undefined;
  }

  /** Token-free listing for ghl_list_locations. */
  async describe(): Promise<Array<{ locationId: string; name?: string }>> {
    return (await this.list()).map((entry) => ({ locationId: entry.locationId, ...(entry.name ? { name: entry.name } : {}) }));
  }
}

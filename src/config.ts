import { buildRegistry, LocationRegistry } from './locations.ts';
import { AgencyAuth, FileTokenStore, LocationDirectory, LocationTokenCache, MemoryTokenStore, type TokenStore } from './oauth.ts';

export interface OAuthContext {
  agency: AgencyAuth;
  locations: LocationTokenCache;
  directory: LocationDirectory;
  appId?: string;
  store: TokenStore;
  redirectUri?: string;
}

export interface ServerConfig {
  apiKey: string;
  locationId?: string;
  baseUrl: string;
  modules: string[] | 'all';
  allowWrites: boolean;
  allowDeletes: boolean;
  metaTools: boolean;
  includeDeprecated: boolean;
  /** Alias -> location -> token map. Absent means single-location mode via locationId. */
  locations?: LocationRegistry;
  /** Agency OAuth mode. When set, per-sub-account tokens are minted on demand
   *  instead of read from the registry, and new sub-accounts need no config. */
  oauth?: OAuthContext;
}

export const DEFAULT_BASE_URL = 'https://services.leadconnectorhq.com';
export const DEFAULT_MODULES = ['contacts', 'conversations', 'opportunities', 'calendars', 'locations'];
// Every request carries the Private Integration Token, so the base URL is a
// credential destination, not a preference. Only HighLevel's own hosts qualify.
export const ALLOWED_BASE_DOMAIN = 'leadconnectorhq.com';

type Env = Record<string, string | undefined>;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function normalizeModuleName(name: string): string {
  return name.trim().toLowerCase().replace(/_/g, '-');
}

export function parseModules(value: string | undefined): string[] | 'all' {
  if (value === undefined || value.trim() === '') return DEFAULT_MODULES;
  if (value.trim().toLowerCase() === 'all') return 'all';
  return [...new Set(value.split(',').map(normalizeModuleName).filter(Boolean))];
}

export function parseBaseUrl(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw) return DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`GHL_BASE_URL is not a valid URL: ${raw}`);
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') {
    throw new Error(`GHL_BASE_URL must use https; got ${url.protocol}//${host}. The API token travels on every request.`);
  }
  if (host !== ALLOWED_BASE_DOMAIN && !host.endsWith(`.${ALLOWED_BASE_DOMAIN}`)) {
    throw new Error(
      `GHL_BASE_URL must stay on ${ALLOWED_BASE_DOMAIN}; got ${host}. Pointing it elsewhere hands your Private Integration Token to that host.`,
    );
  }
  return raw.replace(/\/+$/, '');
}

/**
 * Builds agency OAuth context when a marketplace app is configured. This is the
 * mode for an agency with many (or growing) sub-accounts: one app install mints
 * a token for any sub-account on demand.
 */
export function buildOAuth(env: Env, baseUrl: string): OAuthContext | undefined {
  const clientId = env.GHL_CLIENT_ID?.trim();
  const clientSecret = env.GHL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    if (clientId || clientSecret) {
      throw new Error('Agency OAuth needs both GHL_CLIENT_ID and GHL_CLIENT_SECRET; only one is set.');
    }
    return undefined;
  }
  const storePath = env.GHL_TOKEN_STORE?.trim();
  // HighLevel rotates the refresh token on every exchange, so an in-memory store
  // loses the agency connection on restart. A path is strongly preferred; memory
  // is allowed so a local run or a test does not need a writable disk.
  const store: TokenStore = storePath ? new FileTokenStore(storePath) : new MemoryTokenStore();
  const agency = new AgencyAuth({
    clientId,
    clientSecret,
    baseUrl,
    store,
    seedRefreshToken: env.GHL_REFRESH_TOKEN?.trim(),
    companyId: env.GHL_COMPANY_ID?.trim(),
  });
  return {
    agency,
    locations: new LocationTokenCache(agency, { baseUrl }),
    directory: new LocationDirectory(agency, { baseUrl, appId: env.GHL_APP_ID?.trim() }),
    appId: env.GHL_APP_ID?.trim(),
    store,
    redirectUri: env.GHL_REDIRECT_URI?.trim(),
  };
}

export function loadConfig(env: Env = process.env): ServerConfig {
  const apiKey = env.GHL_API_KEY?.trim();
  const locationsJson = env.GHL_LOCATIONS?.trim();
  const baseUrlEarly = parseBaseUrl(env.GHL_BASE_URL);
  const oauth = buildOAuth(env, baseUrlEarly);
  // With GHL_LOCATIONS every entry can carry its own token, so GHL_API_KEY becomes
  // optional there — it stays as the shared fallback and the agency-level token.
  if (!apiKey && !locationsJson && !oauth) {
    throw new Error(
      'No credentials configured. Either set GHL_API_KEY (a sub-account Private Integration Token), GHL_LOCATIONS (several sub-accounts), or GHL_CLIENT_ID + GHL_CLIENT_SECRET for agency OAuth. Copy .env.example to .env to start.',
    );
  }
  const locations = buildRegistry(locationsJson, env.GHL_LOCATION_ID?.trim(), apiKey, env.GHL_DEFAULT_LOCATION?.trim());
  return {
    apiKey: apiKey ?? '',
    locationId: locations.defaultEntry?.locationId ?? (env.GHL_LOCATION_ID?.trim() || undefined),
    locations,
    ...(oauth ? { oauth } : {}),
    baseUrl: baseUrlEarly,
    modules: parseModules(env.GHL_MODULES),
    allowWrites: parseBoolean(env.GHL_ALLOW_WRITES, false),
    allowDeletes: parseBoolean(env.GHL_ALLOW_DELETES, false),
    metaTools: parseBoolean(env.GHL_META_TOOLS, true),
    includeDeprecated: parseBoolean(env.GHL_INCLUDE_DEPRECATED, false),
  };
}

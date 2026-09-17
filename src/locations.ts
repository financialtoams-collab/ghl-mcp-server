/**
 * Multi-sub-account support.
 *
 * A Private Integration Token is minted inside one GHL sub-account and is only
 * valid there, so serving several sub-accounts means holding several tokens and
 * picking the right one per call. This module owns that mapping: alias -> location
 * id -> token. Tokens live here and nowhere else that can reach a tool result.
 */

export interface LocationEntry {
  /** Short human name the model may pass instead of the raw id, e.g. "solace". */
  alias: string;
  locationId: string;
  /** Private Integration Token scoped to this sub-account. Never serialized. */
  token: string;
  /** Optional display name for ghl_list_locations. */
  label?: string;
}

/** The token-free view. Everything that can reach a tool result uses this shape. */
export interface PublicLocation {
  alias: string;
  locationId: string;
  label?: string;
  isDefault: boolean;
}

export function normalizeAlias(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

export class LocationRegistry {
  readonly entries: readonly LocationEntry[];
  private readonly byAlias: Map<string, LocationEntry>;
  private readonly byId: Map<string, LocationEntry>;
  private readonly fallbackToken?: string;
  readonly defaultEntry?: LocationEntry;

  constructor(entries: LocationEntry[], defaultAlias?: string, fallbackToken?: string) {
    this.entries = entries;
    this.fallbackToken = fallbackToken;
    this.byAlias = new Map(entries.map((entry) => [entry.alias, entry]));
    this.byId = new Map(entries.map((entry) => [entry.locationId.toLowerCase(), entry]));
    if (defaultAlias) {
      const wanted = normalizeAlias(defaultAlias);
      const found = this.byAlias.get(wanted) ?? this.byId.get(wanted);
      if (!found) {
        throw new Error(
          `GHL_DEFAULT_LOCATION="${defaultAlias}" matches no configured location. Known aliases: ${this.aliases().join(', ') || '(none)'}.`,
        );
      }
      this.defaultEntry = found;
    } else {
      this.defaultEntry = entries[0];
    }
  }

  aliases(): string[] {
    return this.entries.map((entry) => entry.alias);
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * Accepts an alias or a raw location id. Returns undefined for an unknown value
   * rather than falling back to the default: silently retargeting a write at the
   * wrong sub-account is worse than an error the model can read and correct.
   */
  resolve(idOrAlias?: string | null): LocationEntry | undefined {
    if (idOrAlias === undefined || idOrAlias === null || idOrAlias === '') return this.defaultEntry;
    const key = String(idOrAlias).trim();
    return this.byId.get(key.toLowerCase()) ?? this.byAlias.get(normalizeAlias(key));
  }

  /** True when the value names something we know; used to tell "unknown" from "raw id we pass through". */
  knows(idOrAlias?: string | null): boolean {
    return this.resolve(idOrAlias) !== undefined;
  }

  /**
   * The token to send for a call already resolved to this location. Falls back to
   * the single GHL_API_KEY when a registry entry omits its own token, which is what
   * makes agency-level endpoints work alongside per-location tokens.
   */
  tokenFor(entry?: LocationEntry): string | undefined {
    return entry?.token || this.fallbackToken;
  }

  /** Token-free listing for ghl_list_locations. */
  describe(): PublicLocation[] {
    return this.entries.map((entry) => ({
      alias: entry.alias,
      locationId: entry.locationId,
      ...(entry.label ? { label: entry.label } : {}),
      isDefault: entry.locationId === this.defaultEntry?.locationId,
    }));
  }
}

interface RawEntry {
  alias?: string;
  locationId?: string;
  location_id?: string;
  id?: string;
  token?: string;
  apiKey?: string;
  label?: string;
  name?: string;
}

function coerceEntry(alias: string, raw: RawEntry | string, index: number): LocationEntry {
  // A bare string value is the location id, with the token inherited from GHL_API_KEY.
  const record: RawEntry = typeof raw === 'string' ? { locationId: raw } : raw;
  const locationId = (record.locationId ?? record.location_id ?? record.id ?? '').trim();
  const resolvedAlias = normalizeAlias(record.alias ?? alias ?? `location-${index + 1}`);
  if (!locationId) {
    throw new Error(`GHL_LOCATIONS entry "${resolvedAlias}" has no locationId.`);
  }
  if (!resolvedAlias) {
    throw new Error(`GHL_LOCATIONS entry for location ${locationId} has an empty alias.`);
  }
  const token = (record.token ?? record.apiKey ?? '').trim();
  const label = (record.label ?? record.name)?.trim();
  return { alias: resolvedAlias, locationId, token, ...(label ? { label } : {}) };
}

/**
 * Parses GHL_LOCATIONS. Two shapes are accepted because both are natural to write
 * in a hosting dashboard's single-line env field:
 *   {"solace":{"locationId":"abc","token":"pit-..."}, "toams":{...}}
 *   [{"alias":"solace","locationId":"abc","token":"pit-..."}, ...]
 */
export function parseLocations(value: string | undefined, fallbackToken?: string): LocationEntry[] {
  const raw = value?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`GHL_LOCATIONS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  let entries: LocationEntry[];
  if (Array.isArray(parsed)) {
    entries = parsed.map((item, index) => coerceEntry('', item as RawEntry, index));
  } else if (typeof parsed === 'object' && parsed !== null) {
    entries = Object.entries(parsed as Record<string, RawEntry | string>).map(([alias, item], index) =>
      coerceEntry(alias, item, index),
    );
  } else {
    throw new Error('GHL_LOCATIONS must be a JSON object or array of locations.');
  }

  if (!entries.length) throw new Error('GHL_LOCATIONS is set but contains no locations.');

  const missingToken = entries.filter((entry) => !entry.token && !fallbackToken);
  if (missingToken.length) {
    throw new Error(
      `No token for location(s): ${missingToken.map((entry) => entry.alias).join(', ')}. Give each entry a "token", or set GHL_API_KEY as the shared fallback.`,
    );
  }

  const seenAlias = new Set<string>();
  const seenId = new Set<string>();
  for (const entry of entries) {
    if (seenAlias.has(entry.alias)) throw new Error(`Duplicate location alias "${entry.alias}" in GHL_LOCATIONS.`);
    // A raw id used as someone else's alias would make resolve() ambiguous.
    if (seenId.has(entry.locationId.toLowerCase())) {
      throw new Error(`Duplicate locationId "${entry.locationId}" in GHL_LOCATIONS.`);
    }
    seenAlias.add(entry.alias);
    seenId.add(entry.locationId.toLowerCase());
  }
  for (const entry of entries) {
    if (seenId.has(entry.alias.toLowerCase()) && entry.alias.toLowerCase() !== entry.locationId.toLowerCase()) {
      throw new Error(`Alias "${entry.alias}" collides with another entry's locationId; pick a different alias.`);
    }
  }

  return entries;
}

export function buildRegistry(
  locationsJson: string | undefined,
  singleLocationId: string | undefined,
  fallbackToken: string | undefined,
  defaultAlias: string | undefined,
): LocationRegistry {
  const parsed = parseLocations(locationsJson, fallbackToken);
  if (parsed.length) return new LocationRegistry(parsed, defaultAlias, fallbackToken);
  // Single-location mode: GHL_LOCATION_ID + GHL_API_KEY, exactly as before.
  const entries: LocationEntry[] = singleLocationId
    ? [{ alias: 'default', locationId: singleLocationId, token: fallbackToken ?? '' }]
    : [];
  return new LocationRegistry(entries, undefined, fallbackToken);
}

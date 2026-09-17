import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { GhlApiError, type GhlClient } from './client.ts';
import type { ServerConfig } from './config.ts';
import type { EndpointDef, OperationClass } from './generator/openapi.ts';
import { buildRegistry, type LocationEntry, LocationRegistry } from './locations.ts';

// Keeps a single tool response from flooding the model's context window.
export const CHARACTER_LIMIT = 50_000;

type ToolArgs = Record<string, unknown>;

const schemaCache = new Map<string, z.ZodType>();

/**
 * HighLevel spells "which sub-account" three ways. `locationId` covers 340
 * endpoints; invoices, payments, store and products use `altId` paired with
 * `altType`, which is 99 more; one endpoint uses snake_case. Injecting a default
 * into only the first spelling is why those modules used to demand the id on
 * every call even with a default location configured.
 */
export const LOCATION_ID_FIELDS = ['locationId', 'location_id', 'altId'] as const;
export const ALT_TYPE_FIELD = 'altType';
const LOCATION_ALT_TYPE = 'location';

function endpointFields(endpoint: EndpointDef): Set<string> {
  return new Set([...endpoint.pathFields, ...endpoint.queryFields, ...endpoint.bodyFields]);
}

/** Which location-bearing fields this endpoint actually declares. */
export function locationFieldsOf(endpoint: EndpointDef): { idFields: string[]; hasAltType: boolean } {
  const fields = endpointFields(endpoint);
  return {
    idFields: LOCATION_ID_FIELDS.filter((field) => fields.has(field)),
    hasAltType: fields.has(ALT_TYPE_FIELD),
  };
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** Lazily derived single-location registry for configs that predate GHL_LOCATIONS. */
const fallbackRegistries = new WeakMap<ServerConfig, LocationRegistry>();

export function registryOf(config: ServerConfig): LocationRegistry {
  if (config.locations) return config.locations;
  let registry = fallbackRegistries.get(config);
  if (!registry) {
    registry = buildRegistry(undefined, config.locationId, config.apiKey, undefined);
    fallbackRegistries.set(config, registry);
  }
  return registry;
}

/**
 * Builds the Zod schema the SDK validates against. The SDK rejects calls before
 * the handler runs, so a required locationId must be relaxed here (not in the
 * handler) whenever a default location will be injected.
 */
export function inputSchemaFor(endpoint: EndpointDef, defaultLocationId?: string, aliasHint?: string): z.ZodType {
  const declared = endpoint.inputSchema.properties as Record<string, Record<string, unknown>> | undefined;
  const { idFields, hasAltType } = locationFieldsOf(endpoint);
  // Only relax fields the schema actually declares; altType is relaxed alongside an
  // altId we are going to fill, never on its own.
  const relaxable = defaultLocationId
    ? [...idFields.filter((field) => declared?.[field]), ...(hasAltType && idFields.includes('altId') && declared?.[ALT_TYPE_FIELD] ? [ALT_TYPE_FIELD] : [])]
    : [];
  const cacheKey = `${endpoint.name}${relaxable.length ? `:default-location:${relaxable.join(',')}${aliasHint ? `:${aliasHint}` : ''}` : ''}`;
  let schema = schemaCache.get(cacheKey);
  if (!schema) {
    let jsonSchema = endpoint.inputSchema;
    if (relaxable.length) {
      const properties = { ...(declared as Record<string, Record<string, unknown>>) };
      for (const field of relaxable) {
        const fieldSchema = properties[field] ?? {};
        const note = field === ALT_TYPE_FIELD
          ? `(defaults to "${LOCATION_ALT_TYPE}" when omitted)`
          : `(defaults to ${defaultLocationId} when omitted${aliasHint ? `; ${aliasHint}` : ''})`;
        properties[field] = {
          ...fieldSchema,
          // An explicit null is how a model says "I don't have one". Accepting it here is
          // what lets splitArguments fall back to the default instead of failing or, as
          // before, dropping the field and calling the API with no location at all.
          ...(typeof fieldSchema.type === 'string' ? { type: [fieldSchema.type, 'null'] } : {}),
          // altType carries enum:["location"]. Widening only `type` would still reject
          // null, because the enum is the narrower constraint of the two.
          ...(Array.isArray(fieldSchema.enum) ? { enum: [...fieldSchema.enum, null] } : {}),
          description: `${fieldSchema.description ? `${fieldSchema.description} ` : ''}${note}`,
        };
      }
      const required = ((jsonSchema.required as string[] | undefined) ?? []).filter((field) => !relaxable.includes(field));
      jsonSchema = { ...jsonSchema, properties, ...(required.length ? { required } : {}) };
      if (!required.length) delete jsonSchema.required;
    }
    schema = z.fromJSONSchema(jsonSchema as Parameters<typeof z.fromJSONSchema>[0]);
    schemaCache.set(cacheKey, schema);
  }
  return schema;
}

export function blockedReason(operationClass: OperationClass, config: ServerConfig): string | undefined {
  if (operationClass === 'write' && !config.allowWrites) {
    return 'Write operations are disabled. Set GHL_ALLOW_WRITES=true to enable POST/PUT/PATCH tools.';
  }
  if (operationClass === 'delete' && !config.allowDeletes) {
    return 'Delete operations are disabled. Set GHL_ALLOW_DELETES=true to enable them.';
  }
  return undefined;
}

export function isEndpointAllowed(endpoint: EndpointDef, config: ServerConfig): boolean {
  return blockedReason(endpoint.operationClass, config) === undefined;
}

export interface SplitArguments {
  pathParams: Record<string, unknown>;
  query: Record<string, unknown>;
  body?: unknown;
}

/**
 * Routes flat tool arguments back to their wire location. A field the spec lists
 * in more than one place (typically locationId) is sent to each of them.
 */
export function splitArguments(endpoint: EndpointDef, args: ToolArgs, defaultLocationId?: string): SplitArguments {
  const values: ToolArgs = { ...args };
  const { idFields, hasAltType } = locationFieldsOf(endpoint);

  if (defaultLocationId) {
    for (const field of idFields) {
      // altId is only a location id when altType says so. If the caller explicitly
      // asked for a company-scoped call, filling in a location id would silently
      // retarget the request at the wrong thing.
      if (field === 'altId' && hasAltType && !isBlank(values[ALT_TYPE_FIELD]) && values[ALT_TYPE_FIELD] !== LOCATION_ALT_TYPE) {
        continue;
      }
      // An explicit null is "no value", not a value: without this it silently beat the
      // configured default and the request left with no location at all.
      if (isBlank(values[field])) values[field] = defaultLocationId;
    }
    // Pairing altType with the altId we just filled; the spec's enum is ["location"].
    if (idFields.includes('altId') && hasAltType && isBlank(values[ALT_TYPE_FIELD])) {
      values[ALT_TYPE_FIELD] = LOCATION_ALT_TYPE;
    }
  }

  const pathParams: Record<string, unknown> = {};
  const query: Record<string, unknown> = {};
  const bodyFields: Record<string, unknown> = {};
  let body: unknown;
  const hasBody = endpoint.bodyWrapped || endpoint.bodyFields.length > 0;

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    let routed = false;
    if (endpoint.pathFields.includes(key)) {
      pathParams[key] = value;
      routed = true;
    }
    if (endpoint.queryFields.includes(key)) {
      query[key] = value;
      routed = true;
    }
    if (endpoint.bodyWrapped && key === 'body') {
      body = value;
      routed = true;
    } else if (endpoint.bodyFields.includes(key)) {
      bodyFields[key] = value;
      routed = true;
    }
    if (!routed) {
      // Unknown keys most likely belong to a newer body shape than the spec describes.
      if (hasBody && !endpoint.bodyWrapped) bodyFields[key] = value;
      else query[key] = value;
    }
  }

  if (!endpoint.bodyWrapped && hasBody) body = bodyFields;
  return { pathParams, query, body };
}

function truncate(text: string, note: string): { text: string; truncated: boolean } {
  if (text.length <= CHARACTER_LIMIT) return { text, truncated: false };
  return { text: `${text.slice(0, CHARACTER_LIMIT)}\n\n[Truncated at ${CHARACTER_LIMIT} characters. ${note}]`, truncated: true };
}

export function formatResult(data: unknown): CallToolResult {
  const raw = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const { text, truncated } = truncate(raw, 'Narrow the request with filters, a smaller limit, or pagination.');
  // structuredContent used to carry the untruncated payload alongside the trimmed
  // text, so both reached the model and the cap capped nothing. A truncated result
  // has no faithful structured form, so it ships as text only.
  const structuredContent = !truncated && typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : undefined;
  return { content: [{ type: 'text', text }], structuredContent };
}

export function formatError(error: unknown, endpoint?: EndpointDef): CallToolResult {
  let text: string;
  if (error instanceof GhlApiError) {
    const hints: Record<number, string> = {
      401: 'The token is invalid or expired. Check GHL_API_KEY.',
      403: `The token lacks a required scope${endpoint?.scopes.length ? ` (${endpoint.scopes.join(', ')})` : ''}. Enable it on the Private Integration and retry.`,
      404: 'Resource not found. Verify the ID and that it belongs to this location.',
      422: 'The API rejected the payload. Check required fields and value formats in the error details.',
      429: 'Rate limited by GHL. Wait a moment and retry.',
    };
    const hint = hints[error.status] ?? '';
    const details = error.details && typeof error.details === 'object' ? `\nDetails: ${JSON.stringify(error.details)}` : '';
    text = `GHL API error ${error.status}: ${error.message}. ${hint}${details}`.trim();
  } else {
    text = `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
  // A bulk validation error or an HTML proxy page can dwarf a successful response;
  // the same cap has to apply here or the error path becomes the way to flood context.
  return { content: [{ type: 'text', text: truncate(text, 'Error body cut short.').text }], isError: true };
}

export interface ResolvedTarget {
  entry?: LocationEntry;
  locationId?: string;
  token?: string;
  args: ToolArgs;
}

/**
 * Works out which sub-account this call is for, swaps any friendly alias for the
 * real id, and picks that sub-account's token. Throws rather than guessing when an
 * unrecognised name is given and more than one sub-account is configured: sending a
 * write to the wrong CRM is not a recoverable mistake.
 */
export function resolveTarget(endpoint: EndpointDef, args: ToolArgs, config: ServerConfig): ResolvedTarget {
  const registry = registryOf(config);
  const { idFields } = locationFieldsOf(endpoint);
  const requestedField = idFields.find((field) => !isBlank(args[field]));
  const requested = requestedField ? String(args[requestedField]) : undefined;

  const entry = registry.resolve(requested);
  // In OAuth mode any sub-account the app is installed on is valid, including
  // ones discovered after boot, so an unrecognised value is passed through and
  // the token mint reports it precisely if the app is not installed there.
  if (requested !== undefined && !entry && registry.size > 1 && !config.oauth) {
    throw new Error(
      `Unknown location "${requested}". Configured sub-accounts: ${registry.aliases().join(', ')}. Use ghl_list_locations to see aliases and ids.`,
    );
  }

  // An unrecognised id with 0-1 configured locations is passed through untouched:
  // that is the single-token setup, where any id the token can see is legitimate.
  const locationId = entry?.locationId ?? requested ?? registry.defaultEntry?.locationId ?? config.locationId;
  const next: ToolArgs = { ...args };
  if (entry && requestedField && String(args[requestedField]) !== entry.locationId) {
    // The model passed an alias; every field that names this location gets the real id.
    for (const field of idFields) {
      if (!isBlank(next[field])) next[field] = entry.locationId;
    }
  }
  return { entry, locationId, token: registry.tokenFor(entry) ?? config.apiKey, args: next };
}

/**
 * The token this call travels with. In OAuth mode it is minted (and cached) for
 * the target sub-account; otherwise it is the registry's stored PIT. An agency
 * endpoint — one with no location field — uses the agency token directly, since
 * a location token would be refused there.
 */
/**
 * OAuth mode only: swap a sub-account name for its id using live discovery.
 * The static registry cannot help here — at this scale the sub-accounts are not
 * in any env var, they are whatever the agency has today.
 */
export async function resolveDynamicLocation(
  endpoint: EndpointDef,
  args: ToolArgs,
  config: ServerConfig,
): Promise<ToolArgs> {
  if (!config.oauth) return args;
  const { idFields } = locationFieldsOf(endpoint);
  const field = idFields.find((name) => !isBlank(args[name]));
  if (!field) return args;
  const requested = String(args[field]);
  // Already a location id we know, or resolvable from the static registry: leave it.
  if (registryOf(config).resolve(requested)) return args;
  const found = await config.oauth.directory.resolve(requested);
  if (!found || found.locationId === requested) return args;
  const next: ToolArgs = { ...args };
  for (const name of idFields) {
    if (!isBlank(next[name])) next[name] = found.locationId;
  }
  return next;
}

export async function tokenForTarget(config: ServerConfig, target: ResolvedTarget): Promise<string | undefined> {
  if (!config.oauth) return target.token;
  if (!target.locationId) return config.oauth.agency.token();
  return config.oauth.locations.tokenFor(target.locationId);
}

export async function executeEndpoint(
  endpoint: EndpointDef,
  args: ToolArgs,
  client: GhlClient,
  config: ServerConfig,
): Promise<CallToolResult> {
  const blocked = blockedReason(endpoint.operationClass, config);
  if (blocked) return formatError(new Error(blocked));
  try {
    // Dedicated tools are validated by the SDK before their handler runs, but
    // ghl_call_endpoint arrives here with whatever the model invented. Validating in
    // this one place covers both routes, so no endpoint is reachable unvalidated.
    const parsed = inputSchemaFor(endpoint, config.locationId).safeParse(args);
    if (!parsed.success) {
      return formatError(new Error(`Invalid arguments for ${endpoint.name}: ${z.prettifyError(parsed.error)}`), endpoint);
    }
    // A name like "toams" is resolved against the live installed-sub-account
    // list before routing, so the model never has to carry location ids around.
    const located = await resolveDynamicLocation(endpoint, parsed.data as ToolArgs, config);
    // Alias -> real id -> that sub-account's token, before anything is routed.
    const target = resolveTarget(endpoint, located, config);
    const token = await tokenForTarget(config, target);
    const { pathParams, query, body } = splitArguments(endpoint, target.args, target.locationId);
    const data = await client.request({
      method: endpoint.method,
      path: endpoint.path,
      version: endpoint.version,
      pathParams,
      query,
      body,
      contentType: endpoint.contentType,
      token,
    });
    return formatResult(data);
  } catch (error) {
    return formatError(error, endpoint);
  }
}

export function registerEndpointTools(
  server: McpServer,
  endpoints: EndpointDef[],
  client: GhlClient,
  config: ServerConfig,
): number {
  const registry = registryOf(config);
  // With one sub-account there is nothing to choose, so the hint stays out of the
  // tool list; with several it is worth the tokens on every location-bearing tool.
  const aliasHint = registry.size > 1 ? `or pass one of: ${registry.aliases().join(', ')}` : undefined;
  let registered = 0;
  for (const endpoint of endpoints) {
    // Hidden rather than merely blocked, so disabled classes cost no context at all.
    if (!isEndpointAllowed(endpoint, config)) continue;
    // Deprecated endpoints are not offered as a normal choice. They stay reachable
    // through ghl_call_endpoint, or set GHL_INCLUDE_DEPRECATED=true to list them again.
    if (endpoint.deprecated && !config.includeDeprecated) continue;
    server.registerTool(
      endpoint.name,
      {
        title: endpoint.summary,
        description: endpoint.description,
        inputSchema: inputSchemaFor(endpoint, config.locationId, aliasHint),
        annotations: {
          readOnlyHint: endpoint.operationClass === 'read',
          // Per the MCP spec destructiveHint:false promises additive updates only, so a
          // PUT/PATCH that overwrites an existing record has to be flagged alongside DELETE.
          // A client on auto-approve reads this before it decides whether to ask.
          destructiveHint: endpoint.operationClass === 'delete' || ['PUT', 'PATCH'].includes(endpoint.method),
          idempotentHint: ['GET', 'PUT', 'DELETE'].includes(endpoint.method),
          openWorldHint: true,
        },
      },
      async (args: unknown) => executeEndpoint(endpoint, (args ?? {}) as ToolArgs, client, config),
    );
    registered += 1;
  }
  return registered;
}

# ghl-mcp-server

A GoHighLevel MCP server with **every endpoint in HighLevel's public OpenAPI specs** —
576 as of the committed catalog — generated straight from those specs. The official
HighLevel MCP exposes ~36 tools; this one covers the whole public surface and stays
current with one command. `npm run generate` prints the live total.

- **Generated, not hand-written.** `npm run generate` turns `specs/*.json` into tool
  definitions. When HighLevel updates their docs, re-fetch and regenerate.
- **Context-friendly.** Load only the modules you need (`GHL_MODULES`), and use three
  meta-tools (`ghl_search_endpoints`, `ghl_describe_endpoint`, `ghl_call_endpoint`) to
  reach everything else on demand. The default set is 54 tools, about 11k tokens of
  tool list; `GHL_MODULES=all` with writes and deletes on is ~213k tokens and will not
  fit in any model's context on its own. See [Sizing the tool list](#sizing-the-tool-list).
- **Multi-sub-account.** A Private Integration Token only works inside the sub-account
  that minted it, so `GHL_LOCATIONS` maps a short alias to each one's id and token. Pass
  the alias on any tool; the call uses that sub-account's token and cannot cross over.
- **Safe by default.** Writes and deletes are off until you enable them. Disabled tools
  are hidden from the client entirely, not just blocked. Note what this does *not* mean:
  read tools in the default set can export every contact, conversation body, and call
  transcription in the sub-account. "Safe" here means no mutation, not small blast radius.
- **Public API only.** Private Integration Token auth, no undocumented endpoints, no
  browser-session tokens.

## Setup

```bash
npm install           # also builds, via the prepare script
cp .env.example .env  # then fill in GHL_API_KEY and GHL_LOCATION_ID
npm test              # optional: 42 tests, no credentials needed
```

`specs/` and `generated/` are committed, so a fresh clone is ready to run. `npm run
specs:fetch` and `npm run generate` are for refreshing against HighLevel's docs — see
[Updating](#updating-when-highlevel-changes-the-api). Running them on a fresh clone
replaces the specs you just checked out with whatever is on HighLevel's `main` today.

Get a **Private Integration Token** in GHL: sub-account → Settings → Private Integrations →
Create. Enable the scopes for the endpoints you plan to use (e.g. `contacts.readonly`,
`contacts.write`). Every tool description lists the scopes it needs.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `GHL_API_KEY` | required\* | Private Integration Token. \*Optional when every `GHL_LOCATIONS` entry carries its own; it then serves as the shared fallback and the agency-level token |
| `GHL_LOCATION_ID` | — | Default sub-account; injected into any endpoint that names a location when the caller omits it — `locationId`, `altId` (+`altType`), or `location_id` |
| `GHL_LOCATIONS` | — | JSON map of alias → `{locationId, token, label?}` for serving several sub-accounts. Replaces `GHL_LOCATION_ID`. See [Several sub-accounts](#several-sub-accounts) |
| `GHL_DEFAULT_LOCATION` | first entry | Which `GHL_LOCATIONS` alias applies when a call names no location |
| `GHL_MODULES` | `contacts,conversations,opportunities,calendars,locations` | Comma-separated modules to expose as dedicated tools, or `all`. Controls context size, **not** capability — see below |
| `GHL_ALLOW_WRITES` | `false` | Expose POST/PUT/PATCH tools |
| `GHL_ALLOW_DELETES` | `false` | Expose DELETE tools |
| `GHL_META_TOOLS` | `true` | Expose the three discovery/call meta-tools covering all endpoints |
| `GHL_INCLUDE_DEPRECATED` | `false` | List the 19 endpoints HighLevel marks deprecated as dedicated tools |
| `GHL_BASE_URL` | `https://services.leadconnectorhq.com` | API host override. Rejected unless it is https and stays on `leadconnectorhq.com`, because every request carries your token |
| `MCP_AUTH_TOKEN` | required for HTTP | Bearer token clients must send to the HTTP transport |
| `PORT` | `3000` | HTTP transport port |
| `MCP_BIND_HOST` | `127.0.0.1` | HTTP bind address. Anything but loopback exposes the server to the network |
| `MCP_ALLOWED_HOSTS` | — | Extra `Host` headers to accept, comma-separated. Needed behind a reverse proxy |
| `GITHUB_TOKEN` | — | Lifts GitHub's rate limit for `npm run specs:fetch` |

`GHL_MODULES` is not a security boundary. With `GHL_META_TOOLS=true` (the default),
`ghl_call_endpoint` can run any of the 576 endpoints in every module regardless of what
is loaded. Only `GHL_ALLOW_WRITES` and `GHL_ALLOW_DELETES` constrain what can be done.
Set `GHL_META_TOOLS=false` if you want module selection to be the limit.

Module names match the spec files: `ad-manager`, `affiliate-manager`, `agent-studio`,
`associations`, `blogs`, `brand-boards`, `businesses`, `calendars`, `campaigns`,
`companies`, `contacts`, `conversation-ai`, `conversations`, `courses`, `custom-fields`,
`custom-menus`, `email-isv`, `emails`, `forms`, `funnels`, `invoices`, `knowledge-base`,
`links`, `locations`, `marketplace`, `medias`, `oauth`, `objects`, `opportunities`,
`payments`, `phone-system`, `products`, `proposals`, `saas-api`, `snapshots`,
`social-media-posting`, `store`, `surveys`, `users`, `voice-ai`, `workflows`.

A few modules (`companies`, `saas-api`, `snapshots`, parts of `locations` and `users`)
are agency-level and need an agency token; tool descriptions say `Token: agency`.

## Several sub-accounts

A Private Integration Token is minted inside one sub-account and is valid only there.
Serving several therefore means holding several tokens and choosing per call:

```bash
GHL_LOCATIONS='{
  "solace": {"locationId":"abc123","token":"pit-...","label":"Solace Care Advocates"},
  "toams":  {"locationId":"def456","token":"pit-..."},
  "relax":  {"locationId":"ghi789","token":"pit-..."}
}'
GHL_DEFAULT_LOCATION=solace
```

An array of `{alias, locationId, token}` objects works too, and an entry may omit
`token` to inherit `GHL_API_KEY`.

The alias is what a model passes as `locationId` (or `altId`) on any tool — "list the
open opportunities in toams" rather than an id nobody remembers. What that buys:

- **Aliases resolve before the request is built**, so the real id reaches the API.
- **Each call carries only that sub-account's token.** Nothing is shared across them,
  so a mistake in one cannot read or write another.
- **An unrecognised location is an error, not a guess.** With more than one sub-account
  configured, an unknown name fails with the list of valid aliases instead of silently
  falling back to the default — sending a write to the wrong CRM is not recoverable.
- **`ghl_list_locations`** appears as a fourth meta-tool and returns aliases, ids, and
  labels. It is built from a token-free view of the registry, so no credential can
  reach a tool result through it.

`GHL_LOCATION_ID` with a single `GHL_API_KEY` still works unchanged.

### How a location reaches the API

HighLevel spells "which sub-account" three ways, and the default fills all of them:

| Spelling | Endpoints | Modules |
| --- | --- | --- |
| `locationId` | 340 | contacts, conversations, calendars, opportunities, … |
| `altId` + `altType: "location"` | 99 | invoices, payments, store, products |
| `location_id` | 1 | — |

`altId` means "location id **or** company id, depending on `altType`". When a call sets
`altType` to anything other than `location`, the default is not injected: filling a
location id into a company-scoped request would silently retarget it.

## Sizing the tool list

Every dedicated tool costs context on every request, whether or not it is used. The
meta-tools reach all 576 endpoints at a flat ~900 tokens, so loading a module as
dedicated tools is only worth it for the handful you touch constantly.

Measured from the committed catalog (non-deprecated, deletes off):

| `GHL_MODULES` | Writes | Tools | ~Tokens |
| --- | --- | --- | --- |
| defaults | off | 51 | 7k |
| `contacts,conversations,opportunities` | on | 59 | 14k |
| defaults | on | 115 | 31k |
| defaults + invoices, payments, store, products, workflows | on | 212 | 83k |
| `all` | on | 477 | 159k |

Invoices alone is 26k tokens as dedicated tools. Reaching it through
`ghl_search_endpoints` → `ghl_call_endpoint` costs nothing until it is used, which is
why the recommended hosted configuration keeps `GHL_MODULES` small and leaves the
meta-tools on.

Those figures count dedicated tools only. The list a client actually receives also
carries the meta-tools and, with several sub-accounts configured, an alias hint on every
location-bearing schema. Measured end to end, the recommended hosted configuration
(`contacts,conversations,opportunities`, writes on, three sub-accounts) is **63 tools,
~20k tokens**.

## Use with Claude Code (stdio)

Add to `.mcp.json` in your project (or `~/.claude.json` for global):

```json
{
  "mcpServers": {
    "ghl": {
      "command": "node",
      "args": ["--env-file=/absolute/path/to/GHL-MCP/.env", "/absolute/path/to/GHL-MCP/dist/src/stdio.js"]
    }
  }
}
```

`--env-file` is built into Node, so no dotenv dependency. You can also put the variables
in the `"env"` block of the config instead.

## Use as a remote connector (Streamable HTTP)

```bash
MCP_AUTH_TOKEN=$(openssl rand -hex 32) npm run start:http
# -> http://127.0.0.1:3000/mcp  (clients send: Authorization: Bearer <MCP_AUTH_TOKEN>)
```

The HTTP transport is stateless, refuses to start without `MCP_AUTH_TOKEN`, and binds
loopback only. It serves `POST /mcp` (authenticated) and an unauthenticated `GET /health`
that returns `{"ok":true}`.

To reach it from elsewhere, terminate TLS in front of it and set `MCP_BIND_HOST` plus
`MCP_ALLOWED_HOSTS=your.host:443`. Without TLS the bearer token and every CRM record
cross the wire in cleartext, and that token fronts a full-access Private Integration
Token. `Host` headers outside the allowlist are rejected, which is what stops a hostile
page from rebinding its own domain to your loopback address.

On Render, Fly, and Railway the public hostname is picked up automatically from the
platform's own environment variable, so `MCP_ALLOWED_HOSTS` is only needed for a custom
domain in front.

## Deploy to Render and connect it to Claude

`Dockerfile` and `render.yaml` are in the repo, so this is a blueprint deploy.

1. **Render → New → Blueprint**, point it at this repo. It reads `render.yaml`.
2. Fill the values marked `sync: false` in the dashboard: `GHL_LOCATIONS`,
   `GHL_DEFAULT_LOCATION`, and optionally `GHL_API_KEY`. Adjust `GHL_MODULES` if the
   default (`contacts,conversations,opportunities`) is not the right core set.
3. Copy the generated `MCP_AUTH_TOKEN` from the dashboard — it is the bearer token the
   client must send, and Render generates it so it never lives in the repo.
4. Wait for the deploy, then confirm `https://<service>.onrender.com/health` returns
   `{"ok":true}`.
5. In Claude, add a **Custom Connector** pointing at `https://<service>.onrender.com/mcp`
   with header `Authorization: Bearer <MCP_AUTH_TOKEN>`.

`render.yaml` ships with `GHL_ALLOW_WRITES=true` and `GHL_ALLOW_DELETES=false`. Turn
deletes on only deliberately, and never alongside a client set to auto-approve tool
calls: 80 delete endpoints against a live CRM is not a mistake you can undo from here.

Two things worth being clear-eyed about before this is reachable from the internet:

- The bearer token fronts every Private Integration Token in `GHL_LOCATIONS`. Anyone
  holding it can read every contact, conversation body, and call transcription in every
  configured sub-account, and with writes on, change them. Rotate it by changing the
  Render env var, which redeploys.
- Render's free instances sleep when idle, which surfaces as a slow first tool call
  while the container wakes. `render.yaml` uses `starter` for that reason.

## How the tools look

Each endpoint becomes `{module}_{operationId}`, for example `contacts_upsert_contact`,
`invoices_send_invoice`, `calendars_get_free_slots`. Arguments are **flat**: path params,
query params, and body fields all sit at the top level, and the server routes them to the
right place. If a body isn't an object (e.g. an array), it's passed as a single `body` arg.

A field the spec marks as binary (file uploads) takes `{ "base64": "...", "filename":
"rows.csv", "contentType": "text/csv" }` and is sent as a real multipart file part.

Meta-tools:

- `ghl_search_endpoints({ query, module?, method?, limit? })` — keyword search over all 576
- `ghl_describe_endpoint({ name })` — full input schema, scopes, HTTP method/path
- `ghl_call_endpoint({ name, arguments })` — run any endpoint. Same write/delete gates,
  and arguments are validated against that endpoint's schema before anything is sent
- `ghl_list_locations()` — configured sub-accounts, their aliases and ids. Only
  registered when `GHL_LOCATIONS` holds more than one, and never returns a token

## Development

```bash
npm run dev          # run the stdio server from source (Node type-stripping)
npm run typecheck
npm test             # unit tests + in-memory end-to-end MCP tests
```

`npm run dev` runs the sources through Node's strip-only type stripping, which cannot
erase enums, namespaces, or constructor parameter properties. `erasableSyntaxOnly` in
`tsconfig.json` makes `tsc` reject that syntax, so the build fails instead of `dev`.

Layout:

```
scripts/fetch-specs.ts   download specs from GoHighLevel/highlevel-api-docs
src/generator/           OpenAPI -> endpoint definitions (pure, unit-tested)
generated/               committed catalog, one JSON per module
src/client.ts            fetch wrapper: auth, Version header, errors, 429 retry
src/locations.ts         alias -> location -> token registry; tokens live only here
src/tools.ts             tool registration, arg routing, gating, result formatting
src/meta-tools.ts        search / describe / call / list-locations
src/server.ts            McpServer factory
src/stdio.ts, src/http.ts  transports
Dockerfile, render.yaml  container build and Render blueprint
.github/workflows/       CI, plus a weekly spec-drift PR
```

CI runs typecheck, build, tests, and a Docker build on every push, and fails if
`generated/` no longer matches what the generator produces from the committed specs.
A separate weekly job re-fetches HighLevel's specs and opens a PR when the API surface
has moved, so the catalog is refreshed on purpose rather than when someone remembers.

## Updating when HighLevel changes the API

```bash
npm run specs:fetch && npm run generate && npm test
```

The generator refuses to write anything and exits non-zero if a spec produces a schema
Zod can't express, a tool name collides or exceeds 64 characters, or a `{placeholder}` in
a URL has no argument to fill it. `generated/` is left untouched on failure, so a bad
upstream change can neither ship silently nor half-replace the committed catalog.

That last check is not hypothetical: HighLevel's specs declare a path parameter on one
method of a path and omit it on the others (`GET /users/{userId}` declares `userId`,
`PUT` and `DELETE` do not). The generator reads placeholders from the URL template rather
than trusting the parameter list, and the guard is there so a future gap fails the build.

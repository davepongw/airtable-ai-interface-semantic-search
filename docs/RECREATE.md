# Recreate this: build your own Claude semantic search for Airtable

This is a self-contained guide for a team that wants to stand up their own copy of this
tool, on their own infrastructure, holding their own credentials. It covers two things:

1. **How it was originally built** — an Airtable interface extension plus a Cloudflare
   Worker that holds the API keys.
2. **How to set it up on your own server** — swap the Cloudflare Worker for a service you
   host yourself (e.g. an approved internal GenAI platform account), so your credentials
   never leave your infrastructure.

There is a copy-paste **recreation prompt** at the bottom you can hand to an AI coding
agent (Claude Code, etc.) to rebuild the whole thing from this spec.

---

## The one rule

**API keys stay server-side. The browser never sees them.**

The Airtable interface extension runs in each user's browser. A browser cannot safely hold
an Anthropic key or an Airtable token. So there is always a small server in the middle: the
extension calls *your* server, and *your* server calls Claude and Airtable. That server is
the only thing that ever holds a secret.

The original build uses a Cloudflare Worker for that server. Nothing about the extension is
tied to Cloudflare — it just needs an HTTPS URL that honors the contract below. That is what
makes "bring your own server" a drop-in swap.

---

## Architecture

```
┌──────────────────────────────────────┐        ┌──────────────────────────────┐
│  Airtable Interface Extension        │        │  Your proxy server           │
│  (@airtable/blocks, React)           │ HTTPS  │  holds, server-side only:    │
│                                      │ ─────► │   • ANTHROPIC_API_KEY        │
│  • chat-style search + refine        │  POST  │   • AIRTABLE_PAT / svc cred  │
│  • locked scope + per-user filters   │ /search│   • PROXY_SECRET (optional)  │
│  • grid / card results, sort/filter  │ ◄───── │                              │
│  • live token counter                │  page  │  1. clarify ambiguous intent │
└──────────────────────────────────────┘        │  2. fetch one page (Airtable)│
       thin: no secrets, pages the API           │  3. Claude re-ranks the page │
                                                 └──────────────────────────────┘
```

The extension is deliberately thin. It sends the prompt + config, then pages through the
records, appending results as they come back. The server does all the work that needs a
secret: it fetches each page from the Airtable REST API, sends it to Claude with structured
outputs, and gets back a relevance score + a one-line reason per record.

---

## The proxy contract (the important part)

Any server works as long as it honors this. This is what lets you replace the Cloudflare
Worker with your own host without touching the extension.

### `GET /health`
Returns liveness so you can confirm which build is deployed.
```json
{ "ok": true, "version": "v1.0.0", "model": "claude-haiku-4-5" }
```

### `POST /search`
Optional header `x-proxy-secret` — if the server has a `PROXY_SECRET` configured, it must
match or the server returns `401`.

**Request body** (all optional unless noted):

| field           | type                              | meaning |
|-----------------|-----------------------------------|---------|
| `baseId`        | string (**required**)             | Airtable base id |
| `tableId`       | string (**required**)             | Airtable table id |
| `tableName`     | string                            | for Claude's context |
| `prompt`        | string                            | the natural-language query |
| `conversation`  | `[{role, content}]`               | chat history for refine/clarify |
| `fields`        | `string[]`                        | field names to return + rank on |
| `schema`        | `[{name, type, options?}]`        | field metadata for filter generation |
| `pageSize`      | number (default 50, clamped 1–100)| records per page |
| `offset`        | string \| null                    | Airtable pagination token |
| `rerank`        | boolean (default true)            | run the Claude ranking step |
| `skill`         | string                            | base-specific instructions for Claude |
| `userFilter`    | string                            | per-user Airtable formula |
| `baseFilter`    | string                            | builder's locked-scope Airtable formula |
| `records`       | `[{id, fields}]`                  | **refine mode**: re-rank these, skip Airtable fetch |

**Response body:**
```json
{
  "records": [{ "id": "rec…", "fields": {…}, "_score": 87, "_reason": "strong match on genre" }],
  "offset": "itr…|null",
  "done": true,
  "usage": { "input_tokens": 1234, "output_tokens": 567 }
}
```
Plus these situational fields:
- Ambiguous intent → `{ "needsClarification": true, "clarificationQuestion": "…", "fieldsToSearch": [...] }`
- Refine mode → `{ "refined": true }`

**Server behavior, in order:**
1. If `PROXY_SECRET` is set, require the `x-proxy-secret` header to match.
2. **Refine mode:** if `records` + `prompt` are present, re-rank those records in chunks of
   100 with Claude and return them. No Airtable call. Cheap; used for follow-up prompts.
3. **Clarify gate:** if there's no `userFilter`, there is a `prompt`, and no `offset` (first
   page), ask Claude to turn the prompt into an Airtable `filterByFormula` and pick which
   fields to search. If it's genuinely ambiguous which field is meant, return
   `needsClarification`.
4. Combine filters: Airtable scope = `AND(baseFilter, userFilter)` (whichever are present).
5. Fetch **one** page from the Airtable REST API with the PAT/service credential.
6. Re-rank that page with Claude and return it with the next `offset`.
7. The extension calls repeatedly, appending pages, until `offset` is null or it hits the
   user's record limit.

### How the server calls Claude
`POST https://api.anthropic.com/v1/messages` with headers `x-api-key`,
`anthropic-version: 2023-06-01`, `content-type: application/json`. Body uses
`output_config: { format: { type: "json_schema", schema } }` so the JSON is always valid,
model `claude-haiku-4-5`, `max_tokens: 8192` for the ranking call. Read
`usage.input_tokens` / `usage.output_tokens` and pass them back so the UI can show cost.

### How the server calls Airtable
`GET https://api.airtable.com/v0/{baseId}/{tableId}` with
`Authorization: Bearer <PAT>` and query params `pageSize`, `offset`, `filterByFormula`,
and repeated `fields[]`. Returns `{ records: [...], offset }`.

The full reference implementation is [`worker/src/index.js`](../worker/src/index.js) — ~360
lines, plain `fetch`, zero dependencies. Read it top to bottom; it is the spec.

---

## Track A — how it was originally built (Cloudflare Worker)

**Prereqs:** Node 20+, an Anthropic API key, an Airtable personal access token (scopes:
`data.records:read`, `schema.bases:read`), and the Airtable Blocks CLI (`npm i -g @airtable/blocks-cli`).

### 1. The proxy (Cloudflare Worker)
```bash
cd worker
npm i -g wrangler            # if you don't have it
wrangler login
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put AIRTABLE_PAT
wrangler secret put PROXY_SECRET     # any random string; the extension sends it back
wrangler deploy
```
`wrangler deploy` prints your Worker URL, e.g. `https://claude-search-proxy.<you>.workers.dev`.
Confirm it: `curl https://…workers.dev/health` should return `{ "ok": true, … }`.

Non-secret config (the model) lives in [`worker/wrangler.toml`](../worker/wrangler.toml).

### 2. The extension
```bash
cd semantic_search_interface
npm install
cp frontend/config.example.js frontend/config.js
# paste your PROXY_SECRET into frontend/config.js (it's gitignored)
block run        # local dev against an interface page
block release    # host it on Airtable
```

### 3. Wire it up in Airtable
Create the custom interface extension in the **builder hub** (it must be an *interface*
extension, not a base extension), add it to an interface page, then set the properties
panel (see "Configure it" below), with **Worker URL** = your `workers.dev` URL.

---

## Track B — set it up on your own server (bring your own credentials)

Same extension, same contract. You are only replacing *where the proxy runs and where the
secrets live*. Do this when a personal Cloudflare Worker with a personal PAT isn't
acceptable — e.g. you need the keys inside your own managed infrastructure.

### What the server needs to be
This is a **stateless HTTPS microservice**. No database, no persistent storage, no queue.

| requirement      | value |
|------------------|-------|
| runtime          | plain JS on `fetch`; runs on Node 20+ or any JS FaaS/container |
| memory           | ~512 MB is plenty (holds one page + one Claude response) |
| CPU              | <0.5 vCPU; it's I/O-bound, waiting on Claude and Airtable |
| request timeout  | 30–60s (Claude latency headroom) |
| scaling          | horizontal, stateless; 1–3 small instances covers a team |
| storage / DB     | none |
| egress           | HTTPS/443 to `api.anthropic.com` and `api.airtable.com` |
| ingress          | HTTPS from end-user **browsers**; needs CORS + reachability (public or VPN) |
| secrets          | secret manager for the Anthropic key, the Airtable credential, and the proxy secret |

### Steps
1. **Provision the host.** For Netflix specifically: request an isolated GenAI Platform
   account via `go/cis-intake`, flagged as a *Claude-powered Airtable semantic-search
   integration*. That's the paved path for an agentic workload making authenticated API
   calls — you get provisioned, stateless compute plus proper identity/token management
   instead of standing up your own box.
2. **Port the proxy.** [`worker/src/index.js`](../worker/src/index.js) is a Cloudflare
   module worker (`export default { async fetch(request, env) {…} }`). It uses only the
   standard `fetch` API and reads secrets from `env`. To run it elsewhere, wrap the same
   `fetch(request, env)` logic in your platform's HTTP handler and read secrets from your
   platform's environment/secret store. There are **no dependencies to install** — the
   logic is a near-verbatim copy.
3. **Hold the credentials your way:**
   - **Anthropic key** — put `ANTHROPIC_API_KEY` in your secret manager. *If your platform
     provides a managed Claude gateway,* point `ANTHROPIC_URL` at that internal endpoint and
     change the auth header to whatever it expects (instead of `x-api-key`). This is the
     preferred setup — you never hold the raw Anthropic key.
   - **Airtable** — replace the personal PAT with a **service-account / non-human identity**
     credential (for Netflix, an `svc.netflix.net` account). It still goes in
     `Authorization: Bearer …`; it's just not a person's token anymore.
   - **Proxy secret** — keep `PROXY_SECRET` as a shared-secret gate, **or** drop it and let
     your platform's own identity/auth (mTLS, gateway auth) protect the endpoint. If you drop
     it, you can also drop the `x-proxy-secret` bits from the extension's `config.js`.
4. **Handle inbound from browsers.** The callers are end-user browsers, so the endpoint must
   be reachable from wherever your interface users are, over TLS, with CORS allowing the
   Airtable interface origin. If it's internal-only, all users must be on the VPN/corp
   network. Decide this at intake.
5. **Deploy and verify.** Hit `GET /health` and confirm `{ "ok": true }`. Then set the
   extension's **Worker URL** property to your new endpoint. Nothing else in the extension
   changes.

### Two questions to settle with your platform team at intake
- **Is there a managed Claude endpoint** you should route through instead of holding the
  Anthropic key yourself? (Changes `ANTHROPIC_URL` + the auth header only.)
- **How should inbound reachability work**, given the callers are browsers? (Public HTTPS vs
  VPN-only.)

---

## Configure it (properties panel — same for both tracks)

- **Search table** — any table in the base.
- **Worker URL** — your deployed proxy endpoint (Cloudflare in Track A, your host in Track B).
- **Search skill** — free-text instructions that teach Claude about your records and what
  "relevant" means for your domain.
- **Locked scope filter** — an Airtable formula that scopes what everyone can search. Match
  it to the interface page's **Source** filter so click-to-open a record works (a custom
  element can only expand records its page Source loaded).
- **Promo image field** — the field to render as an image on cards.

Display columns, sorting, and per-user filters are controlled from the extension's own
toolbar.

---

## Copy-paste recreation prompt (hand this to an AI coding agent)

> Build a Claude-powered semantic search tool for Airtable, in two parts.
>
> **Part 1 — an Airtable interface extension** (`@airtable/blocks@interface-alpha`, React 19,
> Tailwind; scaffold with the Blocks CLI `block init` interface-extension template). It runs
> on an Airtable interface page. It must: let a builder pick a search table, a Worker URL, a
> free-text "skill", a locked-scope Airtable formula, and an image field via the custom
> properties panel; give users a chat-style search box with refine (follow-up prompts re-rank
> the current results) and "new search" (fresh scan); page through the whole table 100 records
> at a time by calling the proxy repeatedly and appending results; show results as a sortable,
> filterable grid or as image cards; show a live token counter and a version stamp; and open a
> clicked result in the interface's Record Detail layout. Import ONLY from
> `@airtable/blocks/interface/ui` and `@airtable/blocks/interface/models`. Never put an API key
> in the browser — read only a shared proxy secret from a gitignored config file.
>
> **Part 2 — a stateless HTTPS proxy** that holds the secrets. It exposes `GET /health` and
> `POST /search`. On `/search` it: optionally checks an `x-proxy-secret` header; supports a
> "refine" mode that re-ranks a supplied record set with no Airtable fetch; on the first page
> of a fresh query, asks Claude to turn the prompt into an Airtable `filterByFormula` and pick
> which fields to search, returning a clarification question if it's ambiguous which field is
> meant; combines a builder `baseFilter` and a user `userFilter` as `AND(...)`; fetches ONE
> page from the Airtable REST API with a server-side token; re-ranks that page with Claude
> (model `claude-haiku-4-5`, Anthropic Messages API, `anthropic-version: 2023-06-01`, structured
> outputs via `output_config.format = {type:"json_schema", schema}`, `max_tokens: 8192`) into
> `{id, relevant, score 0-100, reason ≤8 words}`; and returns the page with the next Airtable
> `offset` and Claude token `usage`. Plain `fetch`, no dependencies. Keep `ANTHROPIC_API_KEY`
> and the Airtable credential server-side only.
>
> Deploy the proxy first (Cloudflare Worker via `wrangler`, OR our own hosted stateless service
> if we're holding credentials internally — in that case store the Anthropic key and an Airtable
> **service-account** credential in our secret manager, and if we have a managed Claude gateway,
> route through it instead of holding the raw Anthropic key). Then point the extension's Worker
> URL property at the deployed endpoint. Walk me through each step one at a time and confirm
> before moving on.

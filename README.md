# Airtable AI Interface: Claude Semantic Search

Airtable's built-in search matches text. It doesn't understand what you mean. Ask it for "family films that would be a good fit for a trampoline park" and it shrugs.

This is a custom Airtable **interface extension** that fixes that. You type a question in plain language, Claude reads the actual records, ranks them by relevance with a score and a one-line reason, and you get a sortable, filterable table back. It scans the whole table (1,015 movie records in the demo base), 100 results per page, and it never puts an API key in the browser.

## How it works

Two pieces, one rule: **the keys stay server-side.**

```
┌─────────────────────────────────────┐        ┌──────────────────────────────┐
│  Airtable Interface Extension        │        │  Cloudflare Worker (proxy)   │
│  (@airtable/blocks, React)           │ HTTPS  │  secrets, server-side only:  │
│                                      │ ─────► │   • ANTHROPIC_API_KEY        │
│  • Chat-style search + re-prompt     │  POST  │   • AIRTABLE_PAT             │
│  • Record filters (narrow the scan)  │ /search│                              │
│  • Results grid: sort/filter/columns │ ◄───── │  1. clarify ambiguous intent │
│  • Live token counter                │  page  │  2. fetch a page (Airtable)  │
└─────────────────────────────────────┘        │  3. Claude re-ranks the page │
                                                └──────────────────────────────┘
```

The extension is thin on purpose. It sends your prompt and config, then loops one page at a time until the whole scope is scanned, appending results as they come back. The Worker holds both secrets and does the thinking: it optionally asks a clarifying question when your query is ambiguous about which fields you mean, pulls each page from the Airtable REST API, and has Claude score every record in that page for relevance.

Why route through a Worker at all, even for one base? Two reasons. The Anthropic key and the Airtable PAT never touch the browser. And you get real offset pagination, so the search returns one page per request instead of dumping the whole table into memory.

## The three folders

- **`worker/`** — the Cloudflare Worker. Holds `ANTHROPIC_API_KEY`, `AIRTABLE_PAT`, and a `PROXY_SECRET`. Two endpoints: `/health` and `/search`. Uses Claude Haiku 4.5 with structured outputs so the filter and the ranking come back as guaranteed-valid JSON.
- **`semantic_search_interface/`** — the Airtable interface extension (`@airtable/blocks@interface-alpha`, React 19, Tailwind). Config lives in the interface's properties panel: search table, Worker URL, a **Search skill** (free-text instructions that teach Claude about this base and how to spot good movie integration opportunities), and a **Base filter** (a config-layer Airtable formula that scopes what any user can search). The Worker's proxy secret goes in a gitignored `frontend/config.js` (copied from `config.example.js`) so it's never in the repo or the properties panel. In use: chat search with **follow-up refine** (a follow-up prompt re-ranks the current results in context, cheap; **New search** starts a fresh scan), a native-style **Filter** to narrow what's scanned, sortable/filterable columns, a **grid ↔ card layout toggle** (cards render a configurable **Promo image field** prominently), a live token counter, and click-a-row to open the record's detail page.
- **`seed/`** — a one-shot script that fills the demo base with 1,000 movie titles plus linked employees and integration opportunities. Reads the PAT from an environment variable, never from a file.

## Setup

**1. Deploy the Worker.** From `worker/`:

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put AIRTABLE_PAT      # scopes: data.records:read, schema.bases:read
wrangler secret put PROXY_SECRET      # any random string; the extension sends it back
wrangler deploy
```

**2. (Optional) Seed a demo base.** From `seed/`:

```bash
AIRTABLE_PAT=pat_xxx node seed.mjs    # PAT also needs data.records:write
```

**3. Build the extension.** From `semantic_search_interface/`:

```bash
npm install
cp frontend/config.example.js frontend/config.js   # then paste your Worker PROXY_SECRET into it
block run        # local dev, or:
block release    # host it on Airtable
```

Add it to an interface page, then set the **Worker URL** (and optionally the **Search skill** and **Promo image field**) in the properties panel.

## Notes

- **Nothing secret is in this repo.** The Anthropic key and PAT live in the Worker (via `wrangler secret`); the Worker's proxy secret lives in the gitignored `frontend/config.js`. The base ID here is an anonymized demo base.
- **Full scan has a cost.** With no record filters, a search ranks every row, which is roughly one Claude call per 100 records. The token counter in the header makes that visible. Set a Record filter (say `Genre is Family`) to shrink the scan and the bill.
- **Two filter layers.** The **Base filter** (config) scopes what everyone can search and should match the interface page's **Source** filter, so the element loads exactly what Claude searches. The **Record filters** (front-end) narrow further, per user, AND-ed on top. Because the front-end layer only narrows, every result stays inside the loaded set — which is what lets a click open the interface's Record Detail layout (Airtable custom elements can only expand records loaded via the page's Source).
- **Search vs. display.** The Record filters narrow *what gets searched* (before fetch). The results box filters *what's shown* (after fetch). Both are there on purpose.
- **Refining is cheap.** A follow-up prompt re-ranks only the current result set, with no re-scan, so iterating costs a fraction of the first search. New search resets the context.

Built as a demo of what an AI-native Airtable interface can do. Fork it, point it at your own base, and go.

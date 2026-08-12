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
- **`semantic_search_interface/`** — the Airtable interface extension (`@airtable/blocks@interface-alpha`, React 19, Tailwind). Config lives in the interface's properties panel (search table, Worker URL, proxy secret).
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
block run        # local dev, or:
block release    # host it on Airtable
```

Add it to an interface page, then set **Worker URL** and **Proxy secret** in the properties panel.

## Notes

- **Nothing secret is in this repo.** The Anthropic key, the PAT, and the proxy secret live in the Worker (via `wrangler secret`) or in your shell environment. The base ID here is an anonymized demo base.
- **Full scan has a cost.** With no record filters, a search ranks every row, which is roughly one Claude call per 100 records. The token counter in the header makes that visible. Set a Record filter (say `Genre is Family`) to shrink the scan and the bill.
- **Search modes.** Record filters narrow *what gets searched* (before fetch). The results box filters *what's shown* (after fetch). Both are there on purpose.

Built as a demo of what an AI-native Airtable interface can do. Fork it, point it at your own base, and go.

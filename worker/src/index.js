// Claude <-> Airtable search proxy — Cloudflare Worker
//
// Holds ANTHROPIC_API_KEY + AIRTABLE_PAT server-side. The Airtable extension
// only ever talks to this Worker; it never sees either secret.
//
// Endpoints:
//   GET  /health  -> liveness + which model is configured
//   POST /search  -> hybrid search over ONE page of records:
//                    1. (first page only) Claude turns the prompt into an
//                       Airtable filterByFormula
//                    2. Fetch ONE page from the Airtable REST API (PAT)
//                    3. Claude re-ranks that page by relevance to the prompt
//                    Returns the page + the next offset token. The extension
//                    calls repeatedly, appending pages until it hits the
//                    user's record limit or offset is null.

const WORKER_VERSION = "v1.0.0"; // bump on every deploy so /health confirms what's live
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const AIRTABLE_API = "https://api.airtable.com/v0";
const MAX_FIELD_CHARS = 600; // truncate each field value before sending to Claude

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return cors(json({ ok: true, version: WORKER_VERSION, model: env.CLAUDE_MODEL || "claude-haiku-4-5" }));
    }

    if (request.method === "POST" && url.pathname === "/search") {
      // Optional shared-secret gate
      if (env.PROXY_SECRET && request.headers.get("x-proxy-secret") !== env.PROXY_SECRET) {
        return cors(json({ error: "unauthorized" }, 401));
      }
      try {
        return cors(await handleSearch(request, env));
      } catch (err) {
        return cors(json({ error: String(err && err.message ? err.message : err) }, 500));
      }
    }

    return cors(json({ error: "not found" }, 404));
  },
};

async function handleSearch(request, env) {
  const body = await request.json();
  const {
    baseId,
    tableId,
    tableName = "",
    prompt = "",
    conversation = [], // [{ role: "user"|"assistant", content: "..." }]
    fields = [], // field names to return
    schema = [], // [{ name, type, options? }] for filter generation
    limit = 100,
    pageSize = 50,
    offset = null,
    rerank = true,
  } = body || {};

  if (!baseId || !tableId) return json({ error: "baseId and tableId are required" }, 400);

  const model = env.CLAUDE_MODEL || "claude-haiku-4-5";
  const clampedPageSize = Math.max(1, Math.min(100, Number(pageSize) || 50));

  let usageIn = 0;
  let usageOut = 0;

  const skill = typeof body.skill === "string" ? body.skill.trim() : "";

  // Refine mode: re-rank an EXISTING result set against a new prompt with no
  // Airtable fetch. Holds the same records in context; far cheaper than a scan.
  const refineRecords = Array.isArray(body.records) ? body.records : null;
  if (refineRecords && prompt) {
    const out = [];
    for (let i = 0; i < refineRecords.length; i += 100) {
      const chunk = refineRecords.slice(i, i + 100).map((r) => ({ id: r.id, fields: r.fields || {} }));
      const ranked = await rankPage({ env, model, prompt, conversation, records: chunk, fields, skill });
      usageIn += ranked.usage.input_tokens;
      usageOut += ranked.usage.output_tokens;
      const byId = new Map(ranked.results.map((x) => [x.id, x]));
      for (const r of chunk) {
        const v = byId.get(r.id);
        if (v && v.relevant === false) continue;
        out.push({ id: r.id, fields: r.fields, _score: v ? v.score : null, _reason: v ? v.reason : "" });
      }
    }
    out.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
    return json({
      records: out,
      refined: true,
      rawCount: refineRecords.length,
      offset: null,
      done: true,
      usage: { input_tokens: usageIn, output_tokens: usageOut },
    });
  }

  // The record scope is controlled by the USER's structured filter (or nothing
  // = a full scan of every record). We do NOT auto-narrow. Claude is used only
  // to clarify ambiguous intent (when no user filter is set) and to re-rank.
  const userFilter =
    typeof body.userFilter === "string" && body.userFilter.trim() ? body.userFilter.trim() : "";
  // Config-layer scope filter (set by the builder; should match the interface
  // page's Source filter so the element loads exactly what Claude can search).
  const baseFilter =
    typeof body.baseFilter === "string" && body.baseFilter.trim() ? body.baseFilter.trim() : "";
  let fieldsToSearch = Array.isArray(body.fieldsToSearch) ? body.fieldsToSearch : null;

  if (!userFilter && prompt && !offset) {
    const gen = await generateFilter({ env, model, prompt, conversation, schema, tableName, skill });
    usageIn += gen.usage.input_tokens;
    usageOut += gen.usage.output_tokens;
    if (gen.needsClarification) {
      return json({
        needsClarification: true,
        clarificationQuestion: gen.clarificationQuestion || "Which field(s) should I search?",
        fieldsToSearch: gen.fieldsToSearch || [],
        records: [],
        offset: null,
        done: true,
        usage: { input_tokens: usageIn, output_tokens: usageOut },
      });
    }
    fieldsToSearch = gen.fieldsToSearch || [];
  }

  // Airtable scope = the config base filter AND the user's front-end filter.
  const filterParts = [baseFilter, userFilter].filter(Boolean);
  const filterFormula =
    filterParts.length === 0 ? "" : filterParts.length === 1 ? filterParts[0] : `AND(${filterParts.join(", ")})`;

  // 2. Fetch ONE page from Airtable (scope = base filter ∩ user filter, or everything).
  const page = await fetchPage({ env, baseId, tableId, fields, pageSize: clampedPageSize, offset, filterFormula });
  if (page.error && page.status === 422 && (userFilter || baseFilter)) {
    return json({ error: "A filter is invalid for Airtable: " + page.message }, 400);
  }
  if (page.error) return json({ error: page.message, airtableStatus: page.status }, 502);

  // 3. Re-rank this page by relevance to the prompt.
  let records = page.records.map((r) => ({ id: r.id, fields: r.fields, _score: null, _reason: "" }));
  if (rerank && prompt && records.length) {
    const ranked = await rankPage({ env, model, prompt, conversation, records, fields, skill });
    usageIn += ranked.usage.input_tokens;
    usageOut += ranked.usage.output_tokens;
    const byId = new Map(ranked.results.map((x) => [x.id, x]));
    records = records
      .map((r) => {
        const v = byId.get(r.id);
        return v ? { ...r, _score: v.score, _reason: v.reason, _relevant: v.relevant } : { ...r, _relevant: true };
      })
      .filter((r) => r._relevant !== false)
      .sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
  }

  return json({
    records,
    filterActive: !!userFilter,
    fieldsToSearch,
    rawCount: page.records.length,
    offset: page.offset || null,
    done: !page.offset,
    usage: { input_tokens: usageIn, output_tokens: usageOut },
  });
}

// ---- Airtable ---------------------------------------------------------------

async function fetchPage({ env, baseId, tableId, fields, pageSize, offset, filterFormula }) {
  const qs = new URLSearchParams();
  qs.set("pageSize", String(pageSize));
  if (offset) qs.set("offset", offset);
  if (filterFormula) qs.set("filterByFormula", filterFormula);
  for (const f of fields) qs.append("fields[]", f);

  const res = await fetch(`${AIRTABLE_API}/${baseId}/${tableId}?${qs.toString()}`, {
    headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` },
  });

  if (!res.ok) {
    let message = `Airtable ${res.status}`;
    try {
      const e = await res.json();
      if (e && e.error) message = typeof e.error === "string" ? e.error : e.error.message || message;
    } catch (_) {}
    return { error: true, status: res.status, message };
  }
  const data = await res.json();
  return { records: data.records || [], offset: data.offset || null };
}

// ---- Claude -----------------------------------------------------------------

async function callClaude({ env, model, system, userText, schema, maxTokens }) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      output_config: { format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Anthropic ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("Anthropic returned no text block");
  if (data.stop_reason === "max_tokens") {
    throw new Error("Claude response was truncated at max_tokens. Lower the page size and retry.");
  }
  const u = data.usage || {};
  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    throw new Error("Could not parse Claude JSON output (possibly truncated). Lower the page size and retry.");
  }
  return {
    result: parsed,
    usage: { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0 },
  };
}

function transcript(conversation, prompt) {
  const lines = (conversation || []).map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`);
  lines.push(`User (current request): ${prompt}`);
  return lines.join("\n");
}

async function generateFilter({ env, model, prompt, conversation, schema, tableName, skill }) {
  const fieldLines = (schema || [])
    .map((f) => `- {${f.name}} (${f.type})${f.options ? ` choices: ${f.options.join(", ")}` : ""}`)
    .join("\n");

  const systemLines = [
    "You translate a natural-language search request into an Airtable filterByFormula string, and decide which fields to search.",
    "Rules:",
    "- Wrap every field name in curly braces, e.g. {Genre}.",
    "- Only reference fields from the provided list. Never invent field names.",
    "- Use valid Airtable formula syntax: AND(), OR(), NOT(), FIND(), LOWER(), IF(), comparisons.",
    "- For fuzzy text matching use FIND(LOWER('term'), LOWER({Field})) > 0.",
    "- Prefer a BROAD filter that keeps anything possibly relevant; a later semantic step narrows it.",
    "- If the request is subjective/semantic and cannot be expressed as a formula, return an EMPTY string for filterByFormula and let the semantic step handle it.",
    "- Always set fieldsToSearch to the field name(s) you are basing the search on.",
    "Ambiguity:",
    "- If it is genuinely unclear WHICH field(s) the user means (the query term could reasonably target several different fields), set needsClarification=true, put a short question naming the candidate fields in clarificationQuestion, list those fields in fieldsToSearch, and leave filterByFormula empty.",
    "- If the fields are clear from the query or the conversation, set needsClarification=false and proceed. Do NOT ask when the intent is obvious. Once the user has answered a clarification earlier in the conversation, proceed (needsClarification=false).",
  ];
  if (skill) systemLines.push("", "Base-specific guidance (use this to interpret intent):", skill);
  const system = systemLines.join("\n");

  const userText = [
    `Table: ${tableName}`,
    "Fields:",
    fieldLines || "(none provided)",
    "",
    "Conversation so far:",
    transcript(conversation, prompt),
    "",
    "Decide needsClarification. If clear, produce filterByFormula (or empty string), fieldsToSearch, and a one-line explanation.",
  ].join("\n");

  const schemaOut = {
    type: "object",
    properties: {
      needsClarification: { type: "boolean" },
      clarificationQuestion: { type: "string" },
      fieldsToSearch: { type: "array", items: { type: "string" } },
      filterByFormula: { type: "string" },
      explanation: { type: "string" },
    },
    required: ["needsClarification", "clarificationQuestion", "fieldsToSearch", "filterByFormula", "explanation"],
    additionalProperties: false,
  };

  const { result, usage } = await callClaude({ env, model, system, userText, schema: schemaOut, maxTokens: 1024 });
  return { ...result, usage };
}

async function rankPage({ env, model, prompt, conversation, records, fields, skill }) {
  const compact = records.map((r) => {
    const out = { id: r.id };
    for (const f of fields) {
      let v = r.fields[f];
      if (v == null) continue;
      if (typeof v === "object") v = JSON.stringify(v);
      v = String(v);
      out[f] = v.length > MAX_FIELD_CHARS ? v.slice(0, MAX_FIELD_CHARS) + "…" : v;
    }
    return out;
  });

  const systemLines = [
    "You rank Airtable records by how well they match a user's search request.",
    "For EACH record return: id, relevant (boolean), score (0-100 integer), and a short reason (AT MOST 8 words).",
    "Use the FULL 0-100 range and differentiate scores: 80-100 strong match, 40-70 partial, below 40 weak. Do NOT give everything the same score.",
    "Mark relevant=false for records that clearly do not match. Be inclusive when unsure.",
    "Return one result object per input record, preserving the ids exactly.",
  ];
  if (skill) systemLines.push("", "Base-specific guidance (follow this when scoring):", skill);
  const system = systemLines.join("\n");

  const userText = [
    "Conversation so far:",
    transcript(conversation, prompt),
    "",
    "Records (JSON):",
    JSON.stringify(compact),
  ].join("\n");

  const schemaOut = {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            relevant: { type: "boolean" },
            score: { type: "integer" },
            reason: { type: "string" },
          },
          required: ["id", "relevant", "score", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["results"],
    additionalProperties: false,
  };

  const { result, usage } = await callClaude({ env, model, system, userText, schema: schemaOut, maxTokens: 8192 });
  return { results: result.results || [], usage };
}

// ---- helpers ----------------------------------------------------------------

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function cors(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "content-type, x-proxy-secret");
  h.set("Access-Control-Max-Age", "86400");
  return new Response(res.body, { status: res.status, headers: h });
}

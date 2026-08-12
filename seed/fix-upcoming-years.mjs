// Cleanup: any movie with Production Status "Announced" or "In Production"
// should be slated to release in an upcoming year (2026, 2027, or 2028).
//
// Usage:
//   AIRTABLE_PAT=pat_xxx node fix-upcoming-years.mjs
//
// The PAT needs data.records:read + data.records:write and access to the base.
// Nothing is written to disk — the PAT is read from the environment only.

const PAT = process.env.AIRTABLE_PAT;
if (!PAT) {
  console.error("Set AIRTABLE_PAT first: AIRTABLE_PAT=pat_xxx node fix-upcoming-years.mjs");
  process.exit(1);
}

const BASE_ID = process.env.BASE_ID || "app4XyteOsYiLOAsc";
const TABLE_ID = process.env.TABLE_ID || "tblkdQW07gtGW4UK5";
const STATUS_FIELD = "Production Status";
const YEAR_FIELD = "Release Year";
const UPCOMING = [2026, 2027, 2028];

const API = "https://api.airtable.com/v0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function airtable(method, path, body) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${PAT}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
  throw new Error(`${method} ${path} -> rate limited after retries`);
}

// 1. Collect all Announced / In Production records (paginated).
const filter = `OR({${STATUS_FIELD}}='Announced',{${STATUS_FIELD}}='In Production')`;
const targets = [];
let offset = null;
do {
  const qs = new URLSearchParams();
  qs.set("filterByFormula", filter);
  qs.set("pageSize", "100");
  qs.append("fields[]", STATUS_FIELD);
  qs.append("fields[]", YEAR_FIELD);
  if (offset) qs.set("offset", offset);
  const data = await airtable("GET", `/${BASE_ID}/${TABLE_ID}?${qs.toString()}`);
  targets.push(...(data.records || []));
  offset = data.offset || null;
} while (offset);

console.log(`Found ${targets.length} Announced / In Production records.`);

// 2. Assign each a random upcoming year and PATCH in batches of 10.
let updated = 0;
for (let i = 0; i < targets.length; i += 10) {
  const chunk = targets.slice(i, i + 10).map((r) => ({
    id: r.id,
    fields: { [YEAR_FIELD]: UPCOMING[Math.floor(Math.random() * UPCOMING.length)] },
  }));
  await airtable("PATCH", `/${BASE_ID}/${TABLE_ID}`, { records: chunk });
  updated += chunk.length;
  process.stdout.write(`\r  updated ${updated}/${targets.length}`);
  await sleep(220); // stay under Airtable's ~5 req/sec/base
}
process.stdout.write("\n");
console.log("Done. All upcoming titles now release in 2026-2028.");

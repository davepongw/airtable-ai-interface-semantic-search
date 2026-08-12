// Seed script for the anonymized Titles demo base.
//
// Usage:
//   AIRTABLE_PAT=pat_xxx node seed.mjs
//
// Optional env overrides:
//   BASE_ID, TITLES_TABLE_ID, TITLES=1000, EMPLOYEES=40, INTEGRATIONS=40
//
// The PAT must have: data.records:read, data.records:write, schema.bases:read,
// and access to the base. Nothing is written to disk — the PAT is read from
// the environment only.

const PAT = process.env.AIRTABLE_PAT;
if (!PAT) {
  console.error("Set AIRTABLE_PAT in your environment first: AIRTABLE_PAT=pat_xxx node seed.mjs");
  process.exit(1);
}

const BASE_ID = process.env.BASE_ID || "app4XyteOsYiLOAsc";
const TITLES_TABLE_ID = process.env.TITLES_TABLE_ID || "tblkdQW07gtGW4UK5";
const N_TITLES = Number(process.env.TITLES || 1000);
const N_EMP = Number(process.env.EMPLOYEES || 40);
const N_INT = Number(process.env.INTEGRATIONS || 40);

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
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`${method} ${path} -> ${res.status}: ${t.slice(0, 400)}`);
    }
    return res.json();
  }
  throw new Error(`${method} ${path} -> rate limited after retries`);
}

// --- discover schema --------------------------------------------------------

const meta = await airtable("GET", `/meta/bases/${BASE_ID}/tables`);
const titles = meta.tables.find((t) => t.id === TITLES_TABLE_ID);
if (!titles) throw new Error(`Titles table ${TITLES_TABLE_ID} not found in base ${BASE_ID}`);

const empLinkField = titles.fields.find((f) => f.name === "Linked Employees");
const intLinkField = titles.fields.find((f) => f.name === "Linked Integration Opportunities");
if (!empLinkField || !intLinkField) throw new Error("Could not find the two link fields on Titles");

const empTableId = empLinkField.options.linkedTableId;
const intTableId = intLinkField.options.linkedTableId;
const empTable = meta.tables.find((t) => t.id === empTableId);
const intTable = meta.tables.find((t) => t.id === intTableId);
const empPrimary = empTable.fields.find((f) => f.id === empTable.primaryFieldId).name;
const intPrimary = intTable.fields.find((f) => f.id === intTable.primaryFieldId).name;

console.log(`Titles: ${titles.name} (${TITLES_TABLE_ID})`);
console.log(`Employees: ${empTable.name} (${empTableId}), primary "${empPrimary}"`);
console.log(`Integration Opportunities: ${intTable.name} (${intTableId}), primary "${intPrimary}"`);

// --- create in batches of 10 ------------------------------------------------

async function createAll(tableId, records) {
  const ids = [];
  for (let i = 0; i < records.length; i += 10) {
    const chunk = records.slice(i, i + 10);
    const out = await airtable("POST", `/${BASE_ID}/${tableId}`, { records: chunk, typecast: true });
    ids.push(...out.records.map((r) => r.id));
    process.stdout.write(`\r  ${tableId}: ${ids.length}/${records.length}`);
    await sleep(220); // stay under Airtable's ~5 req/sec/base
  }
  process.stdout.write("\n");
  return ids;
}

// --- generators -------------------------------------------------------------

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const GENRES = ["Drama", "Comedy", "Action", "Thriller", "Science Fiction", "Horror", "Romance",
  "Documentary", "Animation", "Fantasy", "Mystery", "Crime", "Adventure", "Family", "Historical"];
const STATUSES = ["Released", "In Production", "Post-Production", "Announced", "Development", "Cancelled"];
const ADJ = ["Forgotten", "Last", "Silent", "Broken", "Hidden", "Crimson", "Distant", "Frozen", "Golden",
  "Endless", "Secret", "Wild", "Quiet", "Burning", "Fading", "Restless", "Hollow", "Radiant", "Savage", "Gentle"];
const NOUN = ["Orchard", "Horizon", "Samurai", "Kingdom", "River", "Machine", "Signal", "Harvest", "Cathedral",
  "Empire", "Voyage", "Circuit", "Garden", "Mirror", "Storm", "Lantern", "Verdict", "Compass", "Requiem", "Echo"];
const NOUN2 = ["Shadows", "Glass", "Ashes", "Tomorrow", "Silence", "Iron", "Dust", "Stars", "Winter", "Water",
  "Memory", "Ghosts", "Fire", "Bone", "Rain", "Salt", "Thorns", "Velvet", "Static", "Dawn"];
const FIRST = ["Ava", "Liam", "Maya", "Noah", "Zara", "Kai", "Elena", "Omar", "Ivy", "Theo", "Nadia", "Ruben",
  "Priya", "Sofia", "Diego", "Hana", "Marcus", "Leila", "Jonah", "Amara", "Felix", "Yuki", "Grace", "Idris"];
const LAST = ["Okafor", "Nguyen", "Reyes", "Kapoor", "Larsson", "Haddad", "Silva", "Fischer", "Moreau", "Costa",
  "Ivanov", "Tanaka", "Bianchi", "Cohen", "Adeyemi", "Novak", "Rossi", "Khan", "Andersen", "Mensah"];
const BRAND = ["Solstice Motors", "Aperture Athletics", "Nimbus Airlines", "Vertex Cola", "Lumen Devices",
  "Corsair Watches", "Meridian Bank", "Halcyon Hotels", "Ferro Espresso", "Nova Streaming", "Kestrel Optics",
  "Atlas Outdoor", "Vega Cosmetics", "Onyx Motorsport", "Pace Sneakers", "Cirrus Phones", "Ember Whisky",
  "Talos Robotics", "Dune Fragrances", "Polar Snacks"];
const INTTYPE = ["Product Placement", "Co-Marketing", "Sponsorship", "Brand Integration", "Licensing Tie-In"];

const employees = Array.from({ length: N_EMP }, () => ({
  fields: { [empPrimary]: `${pick(FIRST)} ${pick(LAST)}` },
}));
const integrations = Array.from({ length: N_INT }, () => ({
  fields: { [intPrimary]: `${pick(BRAND)} — ${pick(INTTYPE)}` },
}));

console.log(`\nCreating ${N_EMP} employees + ${N_INT} integration opportunities...`);
const empIds = await createAll(empTableId, employees);
const intIds = await createAll(intTableId, integrations);

// unique-ish titles
const patterns = [
  () => `The ${pick(ADJ)} ${pick(NOUN)}`,
  () => `${pick(NOUN)} of ${pick(NOUN2)}`,
  () => `${pick(ADJ)} ${pick(NOUN2)}`,
  () => `A ${pick(ADJ)} ${pick(NOUN)}`,
  () => `${pick(NOUN)} & ${pick(NOUN2)}`,
];
const seen = new Set();
function uniqueTitle() {
  for (let i = 0; i < 12; i++) {
    const t = pick(patterns)();
    if (!seen.has(t)) { seen.add(t); return t; }
  }
  let n = 2, base = pick(patterns)();
  while (seen.has(`${base} ${roman(n)}`)) n++;
  const t = `${base} ${roman(n)}`;
  seen.add(t);
  return t;
}
function roman(n) { return ["II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"][n - 2] || String(n); }

const titleRecords = Array.from({ length: N_TITLES }, () => ({
  fields: {
    Title: uniqueTitle(),
    Genre: pick(GENRES),
    "Release Year": 1990 + Math.floor(Math.random() * 36),
    "Production Status": pick(STATUSES),
    "Linked Employees": [pick(empIds)],
    "Linked Integration Opportunities": [pick(intIds)],
  },
}));

console.log(`\nCreating ${N_TITLES} titles...`);
await createAll(TITLES_TABLE_ID, titleRecords);
console.log("\nDone. Seeded the base.");

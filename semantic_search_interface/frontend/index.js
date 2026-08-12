import {
    initializeBlock,
    useBase,
    useCustomProperties,
} from '@airtable/blocks/interface/ui';
import {FieldType} from '@airtable/blocks/interface/models';
import {useEffect, useMemo, useRef, useState} from 'react';
import './style.css';

// ---- config (custom properties, set in the interface properties panel) -----

const MOVIES_TABLE_ID = 'tblkdQW07gtGW4UK5';
const DEFAULT_WORKER_URL = 'https://claude-search-proxy.daveairtable.workers.dev';

const PAGE_SIZE = 100; // records fetched per Worker/Airtable page
const RESULTS_PER_PAGE = 100; // results shown per page in the grid
const MAX_PAGES = 5000; // hard safety cap on the full-table scan

// Defined outside the component for a stable identity (required by the SDK).
function getCustomProperties(base) {
    const defaultTable =
        base.getTableByIdIfExists(MOVIES_TABLE_ID) ||
        base.tables.find((t) => t.name.toLowerCase().includes('movie')) ||
        base.tables[0];
    return [
        {key: 'searchTable', label: 'Search table', type: 'table', defaultValue: defaultTable},
        {key: 'workerUrl', label: 'Worker URL', type: 'string', defaultValue: DEFAULT_WORKER_URL},
        {key: 'proxySecret', label: 'Proxy secret', type: 'string', defaultValue: ''},
    ];
}

// ---- field helpers ---------------------------------------------------------

const HIDE_FROM_DEFAULT = new Set([
    FieldType.MULTIPLE_RECORD_LINKS,
    FieldType.MULTIPLE_ATTACHMENTS,
    FieldType.BUTTON,
    FieldType.MULTIPLE_COLLABORATORS,
]);

// Field types that can't be expressed as a simple filter condition.
const UNFILTERABLE = new Set([
    FieldType.MULTIPLE_ATTACHMENTS,
    FieldType.BUTTON,
    FieldType.MULTIPLE_COLLABORATORS,
    FieldType.SINGLE_COLLABORATOR,
    FieldType.MULTIPLE_RECORD_LINKS,
    FieldType.MULTIPLE_LOOKUP_VALUES,
    FieldType.ROLLUP,
    FieldType.BARCODE,
    FieldType.EXTERNAL_SYNC_SOURCE,
]);

const NUMBER_TYPES = new Set([
    FieldType.NUMBER,
    FieldType.CURRENCY,
    FieldType.PERCENT,
    FieldType.RATING,
    FieldType.AUTO_NUMBER,
    FieldType.DURATION,
    FieldType.COUNT,
]);

const OP_LABELS = {
    is: 'is',
    isnot: 'is not',
    has: 'has',
    hasnot: 'has not',
    checked: 'is checked',
    unchecked: 'is unchecked',
    eq: '=',
    ne: '≠',
    gt: '>',
    lt: '<',
    ge: '≥',
    le: '≤',
    contains: 'contains',
    notcontains: "doesn't contain",
};

function operatorsFor(type) {
    if (type === FieldType.SINGLE_SELECT) return ['is', 'isnot'];
    if (type === FieldType.MULTIPLE_SELECTS) return ['has', 'hasnot'];
    if (type === FieldType.CHECKBOX) return ['checked', 'unchecked'];
    if (NUMBER_TYPES.has(type)) return ['eq', 'ne', 'gt', 'lt', 'ge', 'le'];
    return ['contains', 'notcontains', 'is'];
}

function fieldChoices(field) {
    try {
        const opts = (field.config && field.config.options) || field.options;
        if (opts && Array.isArray(opts.choices)) return opts.choices.map((c) => c.name);
    } catch {
        /* ignore */
    }
    return undefined;
}

// Build an Airtable filterByFormula condition from one user filter row.
function esc(v) {
    return String(v == null ? '' : v).replace(/"/g, '');
}
function condFormula(c, byName) {
    const f = byName[c.field];
    if (!f) return null;
    const name = `{${c.field}}`;
    const t = f.type;
    if (t === FieldType.CHECKBOX) return c.op === 'unchecked' ? `NOT(${name})` : `${name}=TRUE()`;
    if (t === FieldType.SINGLE_SELECT) {
        if (!c.value) return null;
        const q = `"${esc(c.value)}"`;
        return c.op === 'isnot' ? `${name}!=${q}` : `${name}=${q}`;
    }
    if (t === FieldType.MULTIPLE_SELECTS) {
        if (!c.value) return null;
        const q = `"${esc(c.value)}"`;
        const inner = `FIND(LOWER(${q}), LOWER(ARRAYJOIN(${name})))>0`;
        return c.op === 'hasnot' ? `NOT(${inner})` : inner;
    }
    if (NUMBER_TYPES.has(t)) {
        const n = parseFloat(c.value);
        if (isNaN(n)) return null;
        const m = {eq: '=', ne: '!=', gt: '>', lt: '<', ge: '>=', le: '<='}[c.op] || '=';
        return `${name}${m}${n}`;
    }
    if (!c.value) return null;
    const q = `"${esc(c.value)}"`;
    const inner = `FIND(LOWER(${q}), LOWER(${name}&""))>0`;
    if (c.op === 'notcontains') return `NOT(${inner})`;
    if (c.op === 'is') return `LOWER(${name}&"")=LOWER(${q})`;
    return inner;
}
function buildUserFilter(filters, matchMode, byName) {
    const parts = filters.map((c) => condFormula(c, byName)).filter(Boolean);
    if (!parts.length) return '';
    if (parts.length === 1) return parts[0];
    return `${matchMode === 'any' ? 'OR' : 'AND'}(${parts.join(', ')})`;
}
function condLabel(c) {
    const op = OP_LABELS[c.op] || c.op;
    if (c.op === 'checked' || c.op === 'unchecked') return `${c.field} ${op}`;
    return `${c.field} ${op} ${c.value}`;
}

// Format a raw Airtable REST cell value for display.
function formatValue(v) {
    if (v == null) return '';
    if (typeof v !== 'object') return String(v);
    if (Array.isArray(v)) {
        return v
            .map((item) =>
                item == null
                    ? ''
                    : typeof item === 'object'
                    ? item.name || item.value || item.url || JSON.stringify(item)
                    : String(item),
            )
            .join(', ');
    }
    if ('value' in v) return v.value == null ? '' : String(v.value); // AI-generated field
    if ('name' in v) return String(v.name); // single select
    if ('url' in v) return String(v.url);
    return JSON.stringify(v);
}

function scoreColor(score) {
    if (score == null) return 'bg-gray-gray100 text-gray-gray600 dark:bg-gray-gray700 dark:text-gray-gray200';
    if (score >= 80) return 'bg-green-green text-white';
    if (score >= 50) return 'bg-yellow-yellow text-gray-gray800';
    return 'bg-gray-gray200 text-gray-gray700 dark:bg-gray-gray600 dark:text-gray-gray100';
}

const inputCls =
    'px-2 py-1 rounded border border-gray-gray300 dark:border-gray-gray600 bg-white dark:bg-gray-gray800 text-gray-gray800 dark:text-gray-gray100 text-sm';

// ---- app -------------------------------------------------------------------

function App() {
    const base = useBase();
    const {customPropertyValueByKey, errorState} = useCustomProperties(getCustomProperties);

    const table = customPropertyValueByKey && customPropertyValueByKey.searchTable;
    const workerUrl = (customPropertyValueByKey && customPropertyValueByKey.workerUrl) || '';
    const proxySecret = (customPropertyValueByKey && customPropertyValueByKey.proxySecret) || '';

    const allFields = useMemo(() => {
        if (!table) return [];
        return table.fields.map((f) => ({id: f.id, name: f.name, type: f.type, choices: fieldChoices(f)}));
    }, [table]);

    const fieldsByName = useMemo(() => {
        const m = {};
        for (const f of allFields) m[f.name] = f;
        return m;
    }, [allFields]);

    const filterableFields = useMemo(() => allFields.filter((f) => !UNFILTERABLE.has(f.type)), [allFields]);

    const primaryName = useMemo(() => {
        if (!table) return null;
        return (table.primaryField && table.primaryField.name) || (table.fields[0] && table.fields[0].name) || null;
    }, [table]);

    const [selectedFields, setSelectedFields] = useState([]);
    useEffect(() => {
        if (!allFields.length) return;
        const defaults = [];
        if (primaryName) defaults.push(primaryName);
        for (const f of allFields) {
            if (defaults.length >= 8) break;
            if (f.name === primaryName) continue;
            if (HIDE_FROM_DEFAULT.has(f.type)) continue;
            defaults.push(f.name);
        }
        setSelectedFields(defaults);
        // reset when the table changes
    }, [table && table.id]); // eslint-disable-line react-hooks/exhaustive-deps

    // chat + results state
    const [messages, setMessages] = useState([]);
    const [results, setResults] = useState([]);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState({kept: 0, scanned: 0});
    const [usage, setUsage] = useState({input: 0, output: 0});
    const [error, setError] = useState(null);
    const [input, setInput] = useState('');
    const [showColumns, setShowColumns] = useState(false);

    // record filters (narrow which records are searched)
    const [filters, setFilters] = useState([]);
    const [matchMode, setMatchMode] = useState('all');
    const [showFilters, setShowFilters] = useState(false);
    const nextId = useRef(1);

    // grid controls
    const [filterText, setFilterText] = useState('');
    const [filterField, setFilterField] = useState('__all__');
    const [sortKey, setSortKey] = useState('__score__');
    const [sortDir, setSortDir] = useState('desc');
    const [resultPage, setResultPage] = useState(0);

    const messagesRef = useRef(messages);
    messagesRef.current = messages;

    useEffect(() => {
        setResultPage(0);
    }, [filterText, filterField, sortKey, sortDir]);

    // ---- record-filter editing ----
    function addFilter() {
        const f = filterableFields[0];
        if (!f) return;
        setFilters((xs) => [...xs, {id: nextId.current++, field: f.name, op: operatorsFor(f.type)[0], value: ''}]);
    }
    function updateFilter(id, patch) {
        setFilters((xs) =>
            xs.map((c) => {
                if (c.id !== id) return c;
                const next = {...c, ...patch};
                if (patch.field) {
                    const t = fieldsByName[patch.field] && fieldsByName[patch.field].type;
                    next.op = operatorsFor(t)[0];
                    next.value = '';
                }
                return next;
            }),
        );
    }
    function removeFilter(id) {
        setFilters((xs) => xs.filter((c) => c.id !== id));
    }

    async function runSearch(promptText) {
        if (!promptText.trim() || busy) return;
        if (!workerUrl || !proxySecret) {
            setError('Set the Worker URL and Proxy secret in the properties panel first.');
            return;
        }
        setError(null);
        const conversation = messagesRef.current.map((m) => ({role: m.role, content: m.content}));
        setMessages((m) => [...m, {role: 'user', content: promptText}]);
        setInput('');
        setResults([]);
        setResultPage(0);
        setUsage({input: 0, output: 0});
        setBusy(true);
        setProgress({kept: 0, scanned: 0});

        const schema = allFields.map((f) => ({name: f.name, type: f.type, options: f.choices}));
        const endpoint = workerUrl.replace(/\/+$/, '') + '/search';
        const userFilter = buildUserFilter(filters, matchMode, fieldsByName);
        const filterDesc = filters.length
            ? filters.map(condLabel).join(matchMode === 'any' ? ' OR ' : ' AND ')
            : null;

        let offset = null;
        let fieldsToSearch = null;
        let kept = [];
        let scanned = 0;
        let usageIn = 0;
        let usageOut = 0;
        let clarified = false;

        try {
            // Scan every record in scope (all records, or the user's filtered
            // subset), one page at a time, until Airtable stops paginating.
            for (let guard = 0; guard < MAX_PAGES; guard++) {
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: {'content-type': 'application/json', 'x-proxy-secret': proxySecret},
                    body: JSON.stringify({
                        baseId: base.id,
                        tableId: table.id,
                        tableName: table.name,
                        prompt: promptText,
                        conversation,
                        fields: selectedFields,
                        schema,
                        userFilter,
                        pageSize: PAGE_SIZE,
                        offset,
                        rerank: true,
                    }),
                });
                if (!res.ok) throw new Error(`Worker ${res.status}: ${(await res.text()).slice(0, 200)}`);
                const data = await res.json();
                if (data.error) throw new Error(data.error);

                usageIn += (data.usage && data.usage.input_tokens) || 0;
                usageOut += (data.usage && data.usage.output_tokens) || 0;
                setUsage({input: usageIn, output: usageOut});

                if (data.needsClarification) {
                    const cf =
                        data.fieldsToSearch && data.fieldsToSearch.length
                            ? ` (candidate fields: ${data.fieldsToSearch.join(', ')})`
                            : '';
                    setMessages((m) => [
                        ...m,
                        {role: 'assistant', content: (data.clarificationQuestion || 'Which field(s) should I search?') + cf},
                    ]);
                    clarified = true;
                    break;
                }

                if (data.fieldsToSearch) fieldsToSearch = data.fieldsToSearch;
                scanned += data.rawCount || 0;
                kept = kept.concat(data.records || []);
                setResults(kept.slice());
                setProgress({kept: kept.length, scanned});

                offset = data.offset;
                if (data.done || !offset) break;
            }

            if (!clarified) {
                const summary =
                    `Found ${kept.length} result${kept.length === 1 ? '' : 's'} across ${scanned} record${
                        scanned === 1 ? '' : 's'
                    } scanned` +
                    (filterDesc ? `; filter: ${filterDesc}` : '') +
                    (fieldsToSearch && fieldsToSearch.length ? `; ranked on: ${fieldsToSearch.join(', ')}` : '') +
                    `. Tokens: ${usageIn.toLocaleString()} in / ${usageOut.toLocaleString()} out.`;
                setMessages((m) => [...m, {role: 'assistant', content: summary}]);
            }
        } catch (e) {
            const msg = String((e && e.message) || e);
            setError(msg);
            setMessages((m) => [...m, {role: 'assistant', content: 'Search failed: ' + msg}]);
        } finally {
            setBusy(false);
        }
    }

    function toggleColumn(name) {
        setSelectedFields((cols) => (cols.includes(name) ? cols.filter((c) => c !== name) : [...cols, name]));
    }

    function onSortClick(key) {
        if (sortKey === key) {
            setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        } else {
            setSortKey(key);
            setSortDir(key === '__score__' ? 'desc' : 'asc');
        }
    }

    const displayColumns = selectedFields;

    const rows = useMemo(() => {
        let out = results.slice();
        if (filterText.trim()) {
            const q = filterText.toLowerCase();
            out = out.filter((r) => {
                if (filterField === '__all__') {
                    const hay = displayColumns.map((c) => formatValue(r.fields[c])).join(' ') + ' ' + (r._reason || '');
                    return hay.toLowerCase().includes(q);
                }
                return formatValue(r.fields[filterField]).toLowerCase().includes(q);
            });
        }
        out.sort((a, b) => {
            let av;
            let bv;
            if (sortKey === '__score__') {
                av = a._score == null ? -1 : a._score;
                bv = b._score == null ? -1 : b._score;
            } else {
                av = formatValue(a.fields[sortKey]);
                bv = formatValue(b.fields[sortKey]);
                const an = parseFloat(av);
                const bn = parseFloat(bv);
                if (!isNaN(an) && !isNaN(bn) && av.trim() !== '' && bv.trim() !== '') {
                    av = an;
                    bv = bn;
                } else {
                    av = av.toLowerCase();
                    bv = bv.toLowerCase();
                }
            }
            if (av < bv) return sortDir === 'asc' ? -1 : 1;
            if (av > bv) return sortDir === 'asc' ? 1 : -1;
            return 0;
        });
        return out;
    }, [results, filterText, filterField, sortKey, sortDir, displayColumns]);

    const totalPages = Math.max(1, Math.ceil(rows.length / RESULTS_PER_PAGE));
    const pageClamped = Math.min(resultPage, totalPages - 1);
    const pageStart = pageClamped * RESULTS_PER_PAGE;
    const pagedRows = rows.slice(pageStart, pageStart + RESULTS_PER_PAGE);

    // ---- render states -----------------------------------------------------

    if (errorState) {
        return (
            <Shell>
                <Notice title="Configuration error">
                    {String((errorState && errorState.message) || 'Could not load custom properties.')}
                </Notice>
            </Shell>
        );
    }
    if (!table) {
        return (
            <Shell>
                <Notice title="Choose a table">
                    Open the properties panel (right side of the interface builder) and set the <b>Search table</b>.
                </Notice>
            </Shell>
        );
    }
    if (!workerUrl || !proxySecret) {
        return (
            <Shell>
                <Notice title="Finish configuration">
                    In the properties panel, set the <b>Worker URL</b> and <b>Proxy secret</b> to match your Cloudflare
                    Worker. Search table: <b>{table.name}</b>.
                </Notice>
            </Shell>
        );
    }

    const arrow = (key) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
    const tokenLabel = `${usage.input.toLocaleString()} in / ${usage.output.toLocaleString()} out`;
    const btnCls =
        'text-sm px-2 py-1 rounded border border-gray-gray300 dark:border-gray-gray600 text-gray-gray700 dark:text-gray-gray200 hover:bg-gray-gray100 dark:hover:bg-gray-gray700';

    return (
        <Shell>
            <div className="flex flex-col h-full w-full">
                {/* header */}
                <div className="px-4 py-3 border-b border-gray-gray200 dark:border-gray-gray700 flex items-center gap-2 flex-wrap">
                    <span className="text-lg font-semibold text-gray-gray800 dark:text-gray-gray100">
                        Claude semantic search
                    </span>
                    <span className="text-sm text-gray-gray500 dark:text-gray-gray400">&middot; {table.name}</span>
                    <div className="ml-auto flex items-center gap-2">
                        {(usage.input > 0 || usage.output > 0) && (
                            <span
                                className="text-xs px-2 py-1 rounded bg-gray-gray100 text-gray-gray600 dark:bg-gray-gray700 dark:text-gray-gray200"
                                title="Anthropic tokens used by this search"
                            >
                                🎟 {tokenLabel}
                            </span>
                        )}
                        <button className={btnCls} onClick={() => setShowFilters((s) => !s)}>
                            Record filters ({filters.length})
                        </button>
                        <button className={btnCls} onClick={() => setShowColumns((s) => !s)}>
                            Columns ({selectedFields.length})
                        </button>
                        {(messages.length > 0 || results.length > 0) && (
                            <button
                                className={btnCls}
                                onClick={() => {
                                    setMessages([]);
                                    setResults([]);
                                    setUsage({input: 0, output: 0});
                                    setResultPage(0);
                                    setError(null);
                                }}
                            >
                                New search
                            </button>
                        )}
                    </div>
                </div>

                {/* record filters panel */}
                {showFilters && (
                    <div className="px-4 py-3 border-b border-gray-gray200 dark:border-gray-gray700 bg-gray-gray50 dark:bg-gray-gray800">
                        <div className="flex items-center gap-2 mb-2 text-sm text-gray-gray700 dark:text-gray-gray200">
                            <span>Match</span>
                            <select className={inputCls} value={matchMode} onChange={(e) => setMatchMode(e.target.value)}>
                                <option value="all">all</option>
                                <option value="any">any</option>
                            </select>
                            <span>of these — only matching records are searched (press Search to apply):</span>
                        </div>
                        {filters.map((c) => {
                            const f = fieldsByName[c.field];
                            const type = f && f.type;
                            const isCheckbox = type === FieldType.CHECKBOX;
                            const isSelect = type === FieldType.SINGLE_SELECT || type === FieldType.MULTIPLE_SELECTS;
                            return (
                                <div key={c.id} className="flex items-center gap-2 mb-2 flex-wrap">
                                    <select
                                        className={inputCls}
                                        value={c.field}
                                        onChange={(e) => updateFilter(c.id, {field: e.target.value})}
                                    >
                                        {filterableFields.map((ff) => (
                                            <option key={ff.id} value={ff.name}>
                                                {ff.name}
                                            </option>
                                        ))}
                                    </select>
                                    <select
                                        className={inputCls}
                                        value={c.op}
                                        onChange={(e) => updateFilter(c.id, {op: e.target.value})}
                                    >
                                        {operatorsFor(type).map((o) => (
                                            <option key={o} value={o}>
                                                {OP_LABELS[o] || o}
                                            </option>
                                        ))}
                                    </select>
                                    {!isCheckbox &&
                                        (isSelect ? (
                                            <select
                                                className={inputCls}
                                                value={c.value}
                                                onChange={(e) => updateFilter(c.id, {value: e.target.value})}
                                            >
                                                <option value="">—</option>
                                                {(f.choices || []).map((ch) => (
                                                    <option key={ch} value={ch}>
                                                        {ch}
                                                    </option>
                                                ))}
                                            </select>
                                        ) : (
                                            <input
                                                className={inputCls}
                                                type={NUMBER_TYPES.has(type) ? 'number' : 'text'}
                                                placeholder="value"
                                                value={c.value}
                                                onChange={(e) => updateFilter(c.id, {value: e.target.value})}
                                            />
                                        ))}
                                    <button
                                        className="text-gray-gray400 hover:text-red-red text-sm px-1"
                                        onClick={() => removeFilter(c.id)}
                                        title="Remove condition"
                                    >
                                        ✕
                                    </button>
                                </div>
                            );
                        })}
                        <div className="flex items-center gap-3 mt-1">
                            <button className="text-sm text-blue-blue hover:underline" onClick={addFilter}>
                                + Add condition
                            </button>
                            {filters.length > 0 && (
                                <button
                                    className="text-sm text-gray-gray500 hover:underline"
                                    onClick={() => setFilters([])}
                                >
                                    Clear all
                                </button>
                            )}
                        </div>
                    </div>
                )}

                {/* column picker */}
                {showColumns && (
                    <div className="px-4 py-3 border-b border-gray-gray200 dark:border-gray-gray700 bg-gray-gray50 dark:bg-gray-gray800 max-h-40 overflow-auto">
                        <div className="flex flex-wrap gap-x-4 gap-y-2">
                            {allFields.map((f) => (
                                <label
                                    key={f.id}
                                    className="flex items-center gap-1.5 text-sm text-gray-gray700 dark:text-gray-gray200"
                                >
                                    <input
                                        type="checkbox"
                                        checked={selectedFields.includes(f.name)}
                                        onChange={() => toggleColumn(f.name)}
                                    />
                                    {f.name}
                                </label>
                            ))}
                        </div>
                    </div>
                )}

                {/* chat transcript */}
                <div className="px-4 py-3 space-y-2 overflow-auto" style={{maxHeight: '30%'}}>
                    {messages.length === 0 && (
                        <p className="text-sm text-gray-gray500 dark:text-gray-gray400">
                            Ask in plain language &mdash; e.g. &ldquo;family films that would suit a trampoline
                            park&rdquo;. Every record in {table.name} is scanned and ranked (use <b>Record filters</b> to
                            narrow the set). Results show 100 per page. If it&rsquo;s unclear which fields you mean,
                            it&rsquo;ll ask first. Re-prompt to refine.
                        </p>
                    )}
                    {messages.map((m, i) => (
                        <div key={i} className={m.role === 'user' ? 'text-right' : 'text-left'}>
                            <span
                                className={
                                    'inline-block px-3 py-1.5 rounded-lg text-sm ' +
                                    (m.role === 'user'
                                        ? 'bg-blue-blue text-white'
                                        : 'bg-gray-gray100 text-gray-gray800 dark:bg-gray-gray700 dark:text-gray-gray100')
                                }
                            >
                                {m.content}
                            </span>
                        </div>
                    ))}
                    {busy && (
                        <div className="text-left text-sm text-gray-gray500 dark:text-gray-gray400">
                            Scanning&hellip; {progress.kept} kept / {progress.scanned} scanned &middot; {tokenLabel} tokens
                        </div>
                    )}
                </div>

                {/* input */}
                <form
                    className="px-4 py-2 border-t border-b border-gray-gray200 dark:border-gray-gray700 flex gap-2"
                    onSubmit={(e) => {
                        e.preventDefault();
                        runSearch(input);
                    }}
                >
                    <input
                        className={'flex-1 ' + inputCls + ' px-3 py-2'}
                        placeholder={messages.length ? 'Refine your search…' : 'Search…'}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        disabled={busy}
                    />
                    <button
                        type="submit"
                        className="px-4 py-2 rounded bg-blue-blue text-white text-sm font-medium disabled:opacity-50"
                        disabled={busy || !input.trim()}
                    >
                        {busy ? '…' : 'Search'}
                    </button>
                </form>

                {error && (
                    <div className="px-4 py-2 text-sm text-red-red bg-red-light3 dark:bg-gray-gray800">{error}</div>
                )}

                {/* results toolbar */}
                {results.length > 0 && (
                    <div className="px-4 py-2 flex items-center gap-2 border-b border-gray-gray200 dark:border-gray-gray700 flex-wrap">
                        <span className="text-sm text-gray-gray500 dark:text-gray-gray400">
                            {rows.length} result{rows.length === 1 ? '' : 's'}
                            {rows.length > 0 && ` · showing ${pageStart + 1}–${pageStart + pagedRows.length}`}
                        </span>
                        <select className={inputCls} value={filterField} onChange={(e) => setFilterField(e.target.value)}>
                            <option value="__all__">All fields</option>
                            {displayColumns.map((c) => (
                                <option key={c} value={c}>
                                    {c}
                                </option>
                            ))}
                        </select>
                        <input
                            className={'flex-1 max-w-xs ' + inputCls}
                            placeholder="Filter shown results…"
                            value={filterText}
                            onChange={(e) => setFilterText(e.target.value)}
                        />
                        {totalPages > 1 && (
                            <div className="ml-auto flex items-center gap-2 text-sm text-gray-gray600 dark:text-gray-gray300">
                                <button
                                    className="px-2 py-1 rounded border border-gray-gray300 dark:border-gray-gray600 disabled:opacity-40"
                                    onClick={() => setResultPage((p) => Math.max(0, p - 1))}
                                    disabled={pageClamped === 0}
                                >
                                    Prev
                                </button>
                                <span>
                                    Page {pageClamped + 1} of {totalPages}
                                </span>
                                <button
                                    className="px-2 py-1 rounded border border-gray-gray300 dark:border-gray-gray600 disabled:opacity-40"
                                    onClick={() => setResultPage((p) => Math.min(totalPages - 1, p + 1))}
                                    disabled={pageClamped >= totalPages - 1}
                                >
                                    Next
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {/* results grid */}
                <div className="flex-1 overflow-auto">
                    {results.length > 0 && (
                        <table className="w-full text-sm border-collapse">
                            <thead className="sticky top-0 bg-gray-gray50 dark:bg-gray-gray800">
                                <tr>
                                    <th
                                        className="text-left px-3 py-2 cursor-pointer text-gray-gray600 dark:text-gray-gray300 whitespace-nowrap"
                                        onClick={() => onSortClick('__score__')}
                                    >
                                        Score{arrow('__score__')}
                                    </th>
                                    {displayColumns.map((c) => (
                                        <th
                                            key={c}
                                            className="text-left px-3 py-2 cursor-pointer text-gray-gray600 dark:text-gray-gray300 whitespace-nowrap"
                                            onClick={() => onSortClick(c)}
                                        >
                                            {c}
                                            {arrow(c)}
                                        </th>
                                    ))}
                                    <th className="text-left px-3 py-2 text-gray-gray600 dark:text-gray-gray300">Why</th>
                                </tr>
                            </thead>
                            <tbody>
                                {pagedRows.map((r) => (
                                    <tr
                                        key={r.id}
                                        className="border-t border-gray-gray200 dark:border-gray-gray700 align-top"
                                    >
                                        <td className="px-3 py-2">
                                            <span
                                                className={
                                                    'inline-block px-2 py-0.5 rounded text-xs font-semibold ' +
                                                    scoreColor(r._score)
                                                }
                                            >
                                                {r._score == null ? '—' : r._score}
                                            </span>
                                        </td>
                                        {displayColumns.map((c) => (
                                            <td key={c} className="px-3 py-2 text-gray-gray800 dark:text-gray-gray100">
                                                {formatValue(r.fields[c])}
                                            </td>
                                        ))}
                                        <td className="px-3 py-2 text-gray-gray500 dark:text-gray-gray400 max-w-xs">
                                            {r._reason}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>
        </Shell>
    );
}

function Shell({children}) {
    return <div className="h-screen w-full bg-white dark:bg-gray-gray900 overflow-hidden">{children}</div>;
}

function Notice({title, children}) {
    return (
        <div className="p-8 max-w-lg mx-auto mt-16 text-center">
            <h2 className="text-xl font-semibold text-gray-gray800 dark:text-gray-gray100 mb-2">{title}</h2>
            <p className="text-sm text-gray-gray600 dark:text-gray-gray300">{children}</p>
        </div>
    );
}

initializeBlock({interface: () => <App />});

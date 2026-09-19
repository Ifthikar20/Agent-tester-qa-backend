/**
 * What a person hands the chat: a file, or a paste too long to be a question.
 *
 * Two kinds are understood. CODE — a Playwright, Cypress, Selenium or
 * Puppeteer test, or one of this runner's own flow documents — which
 * chat-translate.js turns into checks the runner can run. A TABLE — CSV,
 * TSV, JSON or a spreadsheet — which the chat can describe, chart
 * (chat-charts.js) or, when its rows are steps, turn into checks too.
 *
 * Nothing here is executed. Code is read as text and rewritten into the flow
 * language, whose executor names elements by role and resolves them through
 * the accessibility tree (targets.js): there is no path from a pasted file to
 * `eval`, a shell or a selector. A spreadsheet is read by a reader of our own
 * (a zip of XML, below) rather than a library, because the one library
 * everybody uses ships with advisories and this needs a fraction of it.
 *
 * Every string a file carried is caller-derived: it reaches the model inside
 * the untrusted block like page text does (chat-tools.js), it is capped
 * before it is kept, and the file itself is kept in memory for a while and
 * never written to disk — the checks it became are what persist.
 */
import { inflateRawSync } from 'node:zlib';
import { detectFramework } from './chat-translate.js';

export { detectFramework };

/** How much a turn may attach: files, bytes each, bytes together. The UI mirrors these (stores/chat.js). */
export const ATTACHMENTS_MAX = 4;
export const ATTACHMENT_MAX_BYTES = 256 * 1024;
export const ATTACHMENTS_MAX_BYTES = 300 * 1024;
/** How long an attachment stays readable in a conversation without being sent again. */
export const ATTACHMENT_TTL_MS = 30 * 60 * 1000;
/** A table is read this far and no further; a chart or a check never needs more. */
export const TABLE_ROWS_MAX = 2000;
export const TABLE_COLS_MAX = 40;
export const CELL_MAX = 200;
const NAME_MAX = 120;

/** The kinds an attachment can be, by what is in it rather than what it is called. */
export const KINDS = Object.freeze(['code', 'flow', 'table', 'text']);

const TEXT_EXT = /\.(csv|tsv|txt|json|js|mjs|cjs|ts|tsx|jsx|py|java|kt|cs|rb|feature|md|log|flow)$/i;
const XLSX_EXT = /\.xlsx$/i;
const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|py|java|kt|cs|rb|feature)$/i;

/** A file name as it is kept: one line, no path, bounded. */
export const safeName = (s) => String(s ?? '').replace(/[\\/]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) || 'untitled';

// ---- what a file is ----------------------------------------------------------------------------

/** `a,b,c` lines, or tabs, or semicolons — the delimiter that splits the first lines the same way. */
export function sniffDelimiter(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.trim()).slice(0, 8);
  if (lines.length < 2) return null;
  for (const d of ['\t', ',', ';']) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    if (counts[0] >= 1 && counts.every((c) => c === counts[0])) return d;
  }
  return null;
}
function countOutsideQuotes(line, d) {
  let n = 0;
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === d && !q) n++;
  }
  return n;
}

/** What an attachment is, from its name first and its content second. */
export function kindOf(name, text) {
  const n = String(name ?? '');
  if (/\.(csv|tsv|xlsx)$/i.test(n)) return 'table';
  if (/\.json$/i.test(n)) return 'table';
  if (/\.flow$/i.test(n)) return 'flow';
  const framework = detectFramework(text);
  if (framework === 'flow') return 'flow';
  if (framework) return 'code';
  if (CODE_EXT.test(n)) return 'code';
  if (looksLikeJsonTable(text) || sniffDelimiter(text)) return 'table';
  return 'text';
}
const looksLikeJsonTable = (text) => /^\s*[[{]/.test(String(text ?? '')) && (() => { try { return tableFromJson(JSON.parse(text)) !== null; } catch { return false; } })();

// ---- intake --------------------------------------------------------------------------------------

/**
 * The attachments a turn carried, validated and read: `{ items, rejected }`.
 * Each item is `{ name, kind, size, text?, table?, framework? }`. A rejection
 * names the file and the reason, so a person can fix the one thing.
 *
 * The wire shape is `{ name, encoding: 'text'|'base64', data }` — JSON, on
 * the same route as the words, under the route's own body limit; a
 * spreadsheet rides as base64 and is the one binary the chat reads.
 */
export function acceptAttachments(raw) {
  const items = [];
  const rejected = [];
  if (raw == null) return { items, rejected };
  const list = Array.isArray(raw) ? raw : [];
  if (!Array.isArray(raw)) rejected.push({ name: 'attachments', why: 'not a list' });
  let total = 0;
  for (const a of list.slice(0, ATTACHMENTS_MAX + 1)) {
    const name = safeName(a?.name);
    if (items.length >= ATTACHMENTS_MAX) { rejected.push({ name, why: `at most ${ATTACHMENTS_MAX} files in one turn` }); break; }
    const encoding = a?.encoding === 'base64' ? 'base64' : 'text';
    if (typeof a?.data !== 'string') { rejected.push({ name, why: 'no content' }); continue; }
    let bytes;
    try { bytes = encoding === 'base64' ? Buffer.from(a.data, 'base64') : Buffer.from(a.data, 'utf8'); } catch { rejected.push({ name, why: 'could not be decoded' }); continue; }
    if (!bytes.length) { rejected.push({ name, why: 'empty' }); continue; }
    if (bytes.length > ATTACHMENT_MAX_BYTES) { rejected.push({ name, why: `${kb(bytes.length)} — files up to ${kb(ATTACHMENT_MAX_BYTES)}` }); continue; }
    total += bytes.length;
    if (total > ATTACHMENTS_MAX_BYTES) { rejected.push({ name, why: `together more than ${kb(ATTACHMENTS_MAX_BYTES)}` }); continue; }
    try {
      items.push(readAttachment(name, bytes));
    } catch (err) {
      rejected.push({ name, why: String(err.message ?? err).slice(0, 160) });
    }
  }
  return { items, rejected };
}
const kb = (n) => `${Math.round(n / 1024)} kB`;

/** One file, read: a spreadsheet through the zip reader, everything else as UTF-8 text. */
export function readAttachment(name, bytes) {
  const size = bytes.length;
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (XLSX_EXT.test(name) || isZip) {
    if (!isZip) throw new Error('not a spreadsheet (no zip signature)');
    const table = tableFromXlsx(bytes);
    return { name, kind: 'table', size, table };
  }
  if (!TEXT_EXT.test(name) && /\.[a-z0-9]{1,6}$/i.test(name)) throw new Error('a kind of file the chat does not read — code, CSV, TSV, JSON, XLSX or plain text');
  const text = bytes.toString('utf8').replace(/^﻿/, '');
  if (/�/.test(text.slice(0, 4000)) && !/\.(md|txt|log)$/i.test(name)) throw new Error('not text');
  const kind = kindOf(name, text);
  if (kind === 'table') {
    const table = /\.json$/i.test(name) || /^\s*[[{]/.test(text) ? parseJsonTable(text) : parseDelimited(text);
    return { name, kind, size, table, text: text.slice(0, 4000) };
  }
  const framework = kind === 'code' || kind === 'flow' ? detectFramework(text) : null;
  return { name, kind, size, text, ...(framework ? { framework } : {}) };
}

/** An attachment as the transcript keeps it: what it was, never what it said. */
export const attachmentMeta = (a) => ({
  name: a.name, kind: a.kind, size: a.size,
  ...(a.framework ? { framework: a.framework } : {}),
  ...(a.table ? { rows: a.table.rows.length, columns: a.table.columns.length } : {}),
  // Lines as a person counts them: a final newline ends the last line rather than starting an empty one.
  ...(a.text != null && !a.table ? { lines: a.text.replace(/\r?\n$/, '').split('\n').length } : {}),
});

// ---- tables ------------------------------------------------------------------------------------

/** A table as every reader produces it: `{ columns: [{ name, type }], rows: [[cell, …]], truncated }`. */
function shapeTable(columns, rows, { truncated = false } = {}) {
  const cols = columns.slice(0, TABLE_COLS_MAX).map((c, i) => ({ name: cell(c) || `column ${i + 1}`, type: 'text' }));
  const body = rows.slice(0, TABLE_ROWS_MAX).map((r) => cols.map((_, i) => cell(r[i])));
  for (const [i, c] of cols.entries()) c.type = typeOf(body.map((r) => r[i]));
  return { columns: cols, rows: body, truncated: truncated || rows.length > TABLE_ROWS_MAX || columns.length > TABLE_COLS_MAX };
}
const cell = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, CELL_MAX);

/** A column is numeric when every non-empty cell reads as a number; a date when every one parses as a date. */
function typeOf(values) {
  const have = values.filter((v) => v !== '');
  if (!have.length) return 'text';
  if (have.every((v) => numberOf(v) !== null)) return 'number';
  if (have.every((v) => dateOf(v) !== null)) return 'date';
  return 'text';
}
/** `1,234`, `$5.6`, `12%`, `-3` → a number; anything else → null. */
export function numberOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').trim().replace(/^[$€£]/, '').replace(/[,\s]/g, '').replace(/%$/, '');
  if (!s || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
/** An ISO-ish date, or a common written one — never a bare number, which is a count. */
export function dateOf(v) {
  const s = String(v ?? '').trim();
  if (!/^\d{4}-\d{2}(-\d{2})?([T ].*)?$|^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$|^\d{1,2} [A-Za-z]{3,9} \d{4}$|^[A-Za-z]{3,9} \d{1,2},? \d{4}$/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** CSV, TSV or `;`-separated text: quotes, doubled quotes and line breaks inside quotes understood. */
export function parseDelimited(text, delimiter = null) {
  const d = delimiter ?? sniffDelimiter(text) ?? ',';
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  const s = String(text ?? '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === d) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      if (rows.length > TABLE_ROWS_MAX + 1) break;
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((c) => c.trim() !== '')) rows.push(row); }
  if (!rows.length) throw new Error('no rows');
  const [head, ...body] = rows;
  // A first row that is all numbers is data, not a header.
  const headed = !head.every((c) => numberOf(c) !== null);
  return shapeTable(headed ? head : head.map((_, i) => `column ${i + 1}`), headed ? body : rows, { truncated: rows.length > TABLE_ROWS_MAX + 1 });
}

/** A JSON document that is a table: rows as objects, rows as arrays, or either under the first list-valued key. */
export function parseJsonTable(text) {
  let doc;
  try { doc = JSON.parse(text); } catch (err) { throw new Error(`not JSON: ${err.message.slice(0, 80)}`); }
  const t = tableFromJson(doc);
  if (!t) throw new Error('JSON, but not a table — a list of rows is what the chat reads');
  return t;
}
function tableFromJson(doc) {
  let list = Array.isArray(doc) ? doc : null;
  if (!list && doc && typeof doc === 'object') {
    for (const k of ['rows', 'data', 'items', 'results', 'records', ...Object.keys(doc)]) {
      if (Array.isArray(doc[k])) { list = doc[k]; break; }
    }
  }
  if (!list || !list.length) return null;
  if (list.every((r) => Array.isArray(r))) {
    const [head, ...body] = list;
    const headed = head.every((c) => typeof c === 'string');
    return shapeTable(headed ? head : head.map((_, i) => `column ${i + 1}`), headed ? body : list);
  }
  if (!list.every((r) => r && typeof r === 'object' && !Array.isArray(r))) return null;
  const columns = [];
  for (const r of list.slice(0, TABLE_ROWS_MAX)) for (const k of Object.keys(r)) if (!columns.includes(k)) { columns.push(k); if (columns.length >= TABLE_COLS_MAX) break; }
  return shapeTable(columns, list.map((r) => columns.map((k) => r[k])));
}

// ---- xlsx ----------------------------------------------------------------------------------------
/**
 * A .xlsx is a zip of XML files. The central directory at the end of the zip
 * names every entry with its sizes and where its local header is; the entry
 * is inflated from there. No zip64, no encryption, no library.
 */
const INFLATE_MAX = 24 * 1024 * 1024;
export function unzip(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66 * 1024); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip directory is damaged');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (flags & 0x1) throw new Error('the spreadsheet is encrypted');
    entries.set(name, { method, csize, usize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const read = (name) => {
    const e = entries.get(name);
    if (!e) return null;
    if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) throw new Error('zip entry is damaged');
    const nameLen = buf.readUInt16LE(e.offset + 26);
    const extraLen = buf.readUInt16LE(e.offset + 28);
    const start = e.offset + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + e.csize);
    if (e.method === 0) return data;
    if (e.method !== 8) throw new Error(`zip method ${e.method} is not supported`);
    if (e.usize > INFLATE_MAX) throw new Error('the spreadsheet is too large');
    return inflateRawSync(data, { maxOutputLength: INFLATE_MAX });
  };
  return { names: [...entries.keys()], read };
}

const unescapeXml = (s) => String(s ?? '').replace(/&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#\d+);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e] ?? (e[1] === 'x' ? String.fromCodePoint(parseInt(e.slice(2), 16)) : String.fromCodePoint(Number(e.slice(1)))));
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`)); return m ? unescapeXml(m[1]) : null; };
/** Every `<t>` inside one element, joined — a rich-text cell is several runs. */
const textsOf = (xml) => [...String(xml).matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join('');
const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d.*$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

/** The first sheet with rows, as a table. Cells are text, numbers or booleans; a date column is recognised by its heading. */
export function tableFromXlsx(bytes) {
  const zip = unzip(bytes);
  const workbook = zip.read('xl/workbook.xml');
  if (!workbook) throw new Error('not a spreadsheet (no workbook)');
  const rels = new Map([...String(zip.read('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const sheets = [...String(workbook).matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ name: attr(m[0], 'name'), rid: attr(m[0], 'r:id') ?? attr(m[0], 'id') }));
  const shared = [...String(zip.read('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textsOf(m[1]));
  for (const sheet of sheets) {
    const target = rels.get(sheet.rid) ?? `worksheets/sheet${sheets.indexOf(sheet) + 1}.xml`;
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const xml = zip.read(path);
    if (!xml) continue;
    const rows = [];
    for (const rm of String(xml).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = `<c${cm[1]}>`;
        const ref = attr(tag, 'r') ?? '';
        const i = ref ? colIndex(ref) : row.length;
        const t = attr(tag, 't');
        const inner = cm[2] ?? '';
        const v = (inner.match(/<v>([\s\S]*?)<\/v>/) ?? [])[1];
        let value = '';
        if (t === 's') value = shared[Number(v)] ?? '';
        else if (t === 'inlineStr' || t === 'str') value = t === 'str' ? unescapeXml(v ?? '') : textsOf(inner);
        else if (t === 'b') value = v === '1' ? 'true' : 'false';
        else if (t === 'e') value = '';
        else if (v != null) { const n = Number(v); value = Number.isFinite(n) ? n : unescapeXml(v); }
        while (row.length < i) row.push('');
        row[i] = value;
        if (row.length > TABLE_COLS_MAX + 1) break;
      }
      if (row.some((c) => c !== '' && c != null)) rows.push(row);
      if (rows.length > TABLE_ROWS_MAX + 1) break;
    }
    if (!rows.length) continue;
    const [head, ...body] = rows;
    const headed = !head.every((c) => typeof c === 'number');
    const columns = headed ? head : head.map((_, i) => `column ${i + 1}`);
    const data = headed ? body : rows;
    // A column headed "date" holding serial numbers is dates: written back as days.
    columns.forEach((c, i) => {
      if (!/\bdate\b|\bday\b|\bwhen\b|\bmonth\b/i.test(String(c))) return;
      if (!data.some((r) => typeof r[i] === 'number') || !data.every((r) => r[i] === '' || r[i] == null || (typeof r[i] === 'number' && r[i] > 20000 && r[i] < 80000))) return;
      for (const r of data) if (typeof r[i] === 'number') r[i] = new Date(EXCEL_EPOCH + Math.round(r[i]) * 86400000).toISOString().slice(0, 10);
    });
    const table = shapeTable(columns, data, { truncated: rows.length > TABLE_ROWS_MAX + 1 });
    table.sheet = sheet.name;
    table.sheets = sheets.length;
    return table;
  }
  throw new Error('the spreadsheet has no rows');
}

// ---- a table, described ------------------------------------------------------------------------

/** The columns that could stand as X (text or date) and as Y (numbers) in a chart. */
export function chartableColumns(table) {
  const x = table.columns.map((c, i) => ({ ...c, i })).filter((c) => c.type !== 'number');
  const y = table.columns.map((c, i) => ({ ...c, i })).filter((c) => c.type === 'number');
  return { x, y };
}

/** A table whose rows are checks: a column of flow text or of steps, a name beside it. */
export function checkColumns(table) {
  const find = (re) => table.columns.findIndex((c) => re.test(String(c.name)));
  const flow = find(/^(flow|script|steps?|test|case)$/i);
  const name = find(/^(name|case ?name|title|check)$/i);
  const url = find(/^(url|address|page|start|entry)$/i);
  return flow >= 0 ? { flow, name, url } : null;
}

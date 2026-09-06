/**
 * The flow language: a strict subset of mermaid `flowchart` that is also the
 * test script. One edge is exactly one browser interaction, so the source and
 * the picture are the same file — paste it into a README and GitHub draws
 * your suite.
 *
 *   flowchart TD
 *     home(("http://localhost:3000/demo.html"))
 *     dash["#/dashboard"]
 *     saved{{"Profile saved"}}
 *
 *     home -->|fill 'Email' : textbox = $QA_USER| home
 *     home -->|click 'Sign in' : button| dash
 *     dash --> saved
 *
 * Node shape is the assertion:
 *   id(("url"))    entry point            -> goto
 *   id["/path"]    arrival asserts url    -> expect url contains
 *   id{{"text"}}   arrival asserts text   -> expect text visible
 *   id("name")     just a name            -> no assertion
 *
 * Edge label is the action, `;`-separated for several on one transition:
 *   click 'Name' : role
 *   hover 'Name' : role          (a menu that opens on hover)
 *   fill  'Name' : role = <value>
 *   check 'Name' : role is <n> chars
 *   wait  <n>ms
 *
 * Values: 'literal' | $VAULT_KEY | 'a' * 20
 *
 * Syntax constraints below are not stylistic — they are what mermaid's
 * flowchart parser actually accepts inside `|...|`, verified by rendering:
 * double quotes, parentheses and square brackets are all parse errors there.
 * Hence single-quoted names and `'a' * 20` rather than `repeat("a", 20)`.
 */

const SHAPES = [
  // order matters: (( )) must be tried before ( )
  { re: /^(\w+)\(\("(.*)"\)\)$/, kind: 'entry' },
  { re: /^(\w+)\{\{"(.*)"\}\}$/, kind: 'text' },
  { re: /^(\w+)\[\("(.*)"\)\]$/, kind: 'plain' },
  { re: /^(\w+)\["(.*)"\]$/,     kind: 'url' },
  { re: /^(\w+)\("(.*)"\)$/,     kind: 'plain' },
];

/** `a -->|label| b`, `a --> b`, and chains of either. */
const EDGE = /\s*(-{2,3}>|={2,3}>)\s*(?:\|([^|]*)\|\s*)?/;

const unq = (s) => s.trim().replace(/^'(.*)'$/s, '$1');

/** `'a' * 20` -> 'aaa…'; `$KEY` -> a vault reference; else a literal. */
function value(raw) {
  const s = raw.trim();
  if (s.startsWith('$')) return { valueRef: `secrets.${s.slice(1)}` };

  const rep = s.match(/^'(.*)'\s*[*×]\s*(\d+)$/s);
  if (rep) return { value: rep[1].repeat(Math.min(Number(rep[2]), 500)) };

  const n = s.match(/^(\d+)\s*chars?$/);
  if (n) return { value: 'a'.repeat(Math.min(Number(n[1]), 500)) };

  return { value: unq(s) };
}

/** `'Sign in' : button` -> `button:Sign in`, the target grammar targets.js speaks. */
function target(raw) {
  const m = raw.trim().match(/^(.*?)\s*:\s*([A-Za-z]+)$/s);
  if (!m) {
    // Bare alias, e.g. `auth.submit`. Still goes through parseTarget later.
    return unq(raw);
  }
  return `${m[2].trim()}:${unq(m[1])}`;
}

/** One `;`-separated clause of an edge label -> one IR step. */
function op(clause) {
  const s = clause.trim();
  if (!s) return null;

  let m;
  if ((m = s.match(/^click\s+(.+)$/i))) {
    return { op: 'click', target: target(m[1]) };
  }
  // Go there and stay, without clicking — for a menu that only exists while
  // the pointer is on whatever opens it.
  if ((m = s.match(/^hover\s+(.+)$/i))) {
    return { op: 'hover', target: target(m[1]) };
  }
  if ((m = s.match(/^fill\s+(.+?)\s*=\s*(.+)$/i))) {
    return { op: 'fill', target: target(m[1]), ...value(m[2]) };
  }
  if ((m = s.match(/^check\s+(.+?)\s+is\s+(.+)$/i))) {
    return { op: 'expect', assert: 'valueEquals', target: target(m[1]), ...value(m[2]) };
  }
  if ((m = s.match(/^wait\s+(\d+)\s*ms$/i))) {
    return { op: 'wait', ms: Number(m[1]) };
  }
  if ((m = s.match(/^see\s+(.+)$/i))) {
    return { op: 'expect', assert: 'textVisible', value: unq(m[1]) };
  }
  // Mermaid is permissive; this runner must not be. An edge we cannot read is
  // a hard error, never a silently skipped step — otherwise a typo passes.
  throw new Error(`Unreadable edge action "${s}"`);
}

/** Arriving at a node is its assertion, if it has one. */
function arrival(node) {
  if (node.kind === 'url') return { op: 'expect', assert: 'urlContains', value: node.label };
  if (node.kind === 'text') return { op: 'expect', assert: 'textVisible', value: node.label };
  return null;
}

/**
 * flow text -> { suite, cases: [{ name, steps }] }
 *
 * Each root-to-leaf path is one case, so a shared prefix (a login, say) is
 * written once and several tests hang off it. Edges are walked in declaration
 * order, depth first.
 */
export function parseFlow(text) {
  const nodes = new Map();
  const edges = [];
  const marks = new Map();      // step index -> where the click landed
  let entry = null;             // what the entry page offered when recorded
  let suite = 'Flow';

  const declare = (token) => {
    const t = token.trim();
    if (!t) return null;
    for (const { re, kind } of SHAPES) {
      const m = t.match(re);
      if (m) {
        const [, id, label] = m;
        // A later declaration with a shape wins over a bare reference.
        nodes.set(id, { id, kind, label: label.replace(/\\"/g, '"') });
        return id;
      }
    }
    if (/^\w+$/.test(t)) {
      if (!nodes.has(t)) nodes.set(t, { id: t, kind: 'plain', label: t });
      return t;
    }
    throw new Error(`Cannot read node "${t}"`);
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/;+$/, '');
    if (!line) continue;

    let m;
    // The suite name rides in a mermaid comment, so the script stays a valid
    // diagram while still carrying its own title.
    if ((m = line.match(/^(?:%%)?\s*suite\s+(.+)$/i))) {
      suite = unq(m[1].trim().replace(/^["']|["']$/g, ''));
      continue;
    }
    if ((m = line.match(/^%%\s*entry\s+(\[.*\])$/))) {
      try { entry = JSON.parse(m[1]); } catch { /* unreadable, so ignore it */ }
      continue;
    }
    if ((m = line.match(/^%%\s*at\s+(\d+)\s+(-?\d+),(-?\d+)\s+(\d+)x(\d+)\s+in\s+(\d+)x(\d+)$/))) {
      const [, i, x, y, w, h, vw, vh] = m.map(Number);
      marks.set(i, { x, y, w, h, vw, vh });
      continue;
    }
    if (line.startsWith('%%')) continue;
    if (/^(flowchart|graph)\b/i.test(line)) continue;
    if (/^(classDef|class|style|linkStyle|subgraph|end)\b/.test(line)) continue;

    if (!EDGE.test(line)) { declare(line); continue; }

    // Split the chain into node tokens and the edges between them.
    const parts = line.split(new RegExp(EDGE.source, 'g'));
    // parts = [node, arrow, label, node, arrow, label, node, ...]
    let prev = declare(parts[0]);
    for (let i = 1; i < parts.length; i += 3) {
      const lbl = parts[i + 1];
      const next = declare(parts[i + 2]);
      if (prev && next) edges.push({ from: prev, to: next, label: lbl ?? '' });
      prev = next;
    }
  }

  if (!nodes.size) throw new Error('No nodes — is this a flowchart?');

  const entries = [...nodes.values()].filter((n) => n.kind === 'entry');
  const incoming = new Set(edges.map((e) => e.to));
  const roots = entries.length
    ? entries
    : [...nodes.values()].filter((n) => !incoming.has(n.id)).slice(0, 1);
  if (!roots.length) throw new Error('No entry node — mark one as id(("http://…"))');

  const cases = [];
  for (const root of roots) {
    const head = [];
    if (root.kind === 'entry') head.push({ op: 'goto', url: root.label });
    const a = arrival(root);
    if (a) head.push(a);
    walk(root.id, head, new Set(), edges, nodes, cases, [root.id]);
  }
  if (!cases.length) throw new Error('Nothing to run');
  // Re-attach the recorded landing points, by position in the emitted order.
  if (marks.size) {
    for (const c of cases) c.steps.forEach((s, i) => { if (marks.has(i)) s.at = marks.get(i); });
  }
  if (entry) for (const c of cases) { const g = c.steps.find((s) => s.op === 'goto'); if (g) g.entry = entry; }
  return { suite, cases };
}

/** An edge's label -> its steps. */
const opsOf = (e) => (e.label ?? '').split(';').map(op).filter(Boolean);

function walk(id, steps, seenEdges, edges, nodes, cases, path) {
  let cur = steps;
  let seen = seenEdges;

  // A self-loop is "another step on the same place", so it CONTINUES the case
  // rather than forking it. Consume them in declaration order, up to the first
  // edge that actually leaves.
  for (;;) {
    const rest = edges.filter((e) => e.from === id && !seen.has(e));
    if (!rest.length || rest[0].to !== id) break;
    seen = new Set(seen).add(rest[0]);
    cur = cur.concat(opsOf(rest[0]));
  }

  const leaving = edges.filter((e) => e.from === id && e.to !== id && !seen.has(e));
  const stranded = edges.filter((e) => e.from === id && e.to === id && !seen.has(e));
  if (stranded.length) {
    throw new Error(
      `Node "${id}": a self-loop is declared after the edge that leaves it. ` +
      `Move it above, or its steps would be silently dropped.`
    );
  }

  if (!leaving.length) {
    cases.push({ name: path.join(' → '), steps: cur });
    return;
  }
  // Several edges leaving one node fork into separate cases, so a shared
  // prefix — a login, say — is written once.
  for (const e of leaving) {
    const next = cur.concat(opsOf(e));
    const a = arrival(nodes.get(e.to));
    if (a) next.push(a);
    walk(e.to, next, new Set(seen).add(e), edges, nodes, cases, [...path, e.to]);
  }
}

/** Cases -> one runnable plan, re-navigating at the head of each case. */
export function flatten({ suite, cases }) {
  if (cases.length === 1) return { suite, steps: cases[0].steps };
  const steps = [];
  for (const c of cases) steps.push(...c.steps);
  return { suite, steps };
}

/** Convenience: flow text straight to the IR the executor already runs. */
export const parse = (text) => flatten(parseFlow(text));

// ---------------------------------------------------------------- emitting

/** Node/edge labels: strip what mermaid cannot lex rather than escape it. */
const nodeText = (s) => String(s ?? '').replace(/["\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
const edgeText = (s) => String(s ?? '')
  .replace(/["()[\]|\n\r]/g, ' ')   // all parse errors inside |...|
  .replace(/\s+/g, ' ').trim();

const showTarget = (t) => {
  const i = t.indexOf(':');
  return i < 1 ? t : `'${edgeText(t.slice(i + 1))}' : ${t.slice(0, i)}`;
};

function showOp(step) {
  switch (step.op) {
    case 'click': return `click ${showTarget(step.target)}`;
    case 'hover': return `hover ${showTarget(step.target)}`;
    case 'fill': {
      // A recorded password must never round-trip as its value.
      const v = step.valueRef
        ? `$${step.valueRef.replace(/^secrets\./, '')}`
        : `'${edgeText(step.value)}'`;
      return `fill ${showTarget(step.target)} = ${v}`;
    }
    case 'wait': return `wait ${step.ms}ms`;
    case 'expect':
      if (step.assert === 'valueEquals') {
        return `check ${showTarget(step.target)} is ${String(step.value).length} chars`;
      }
      return null;   // url/text assertions become node shapes, not edges
    default: return null;
  }
}

/**
 * IR -> flow text. The inverse of parseFlow for anything parseFlow produces,
 * which is what lets teach-mode hand you a script you can edit and re-run.
 */
export function toFlow(plan) {
  const nodes = [];
  const lines = [];
  let n = 0;
  let cur = null;          // current node id
  let pending = [];        // actions not yet attached to an edge

  const nodeId = () => `n${n++}`;
  const emitNode = (kind, label) => {
    const id = nodeId();
    const t = nodeText(label);
    const shape = { entry: `(("${t}"))`, url: `["${t}"]`, text: `{{"${t}"}}`, plain: `("${t}")` }[kind];
    nodes.push(`  ${id}${shape}`);
    return id;
  };
  const flush = (to) => {
    const label = pending.filter(Boolean).join('; ');
    lines.push(label ? `  ${cur} -->|${label}| ${to}` : `  ${cur} --> ${to}`);
    pending = [];
    cur = to;
  };

  for (const step of plan.steps) {
    if (step.op === 'goto') {
      const id = emitNode('entry', step.url);
      if (cur) flush(id); else cur = id;
      continue;
    }
    if (step.op === 'expect' && (step.assert === 'urlContains' || step.assert === 'textVisible')) {
      const id = emitNode(step.assert === 'urlContains' ? 'url' : 'text', step.value);
      if (!cur) cur = emitNode('plain', 'start');
      flush(id);
      continue;
    }
    const s = showOp(step);
    if (s) pending.push(s);
  }
  // Anything left over is a self-loop: more steps, same place.
  if (pending.length && cur) flush(cur);

  // Where each click actually landed. A comment, so it round-trips through the
  // language and stays out of the picture — it is evidence, not instruction.
  const marks = plan.steps
    .map((s, i) => (s.at ? `%% at ${i} ${s.at.x},${s.at.y} ${s.at.w}x${s.at.h} in ${s.at.vw}x${s.at.vh}` : null))
    .filter(Boolean);

  // What the entry page offered when this was recorded.
  const entry = plan.steps.find((s) => s.op === 'goto' && s.entry?.length);
  if (entry) marks.unshift(`%% entry ${JSON.stringify(entry.entry)}`);

  return [
    `%% suite "${nodeText(plan.suite ?? 'Recorded flow')}"`,
    'flowchart TD',
    ...nodes,
    '',
    ...lines,
    ...(marks.length ? ['', ...marks] : []),
  ].join('\n');
}

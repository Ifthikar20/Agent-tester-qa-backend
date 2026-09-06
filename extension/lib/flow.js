/**
 * The test case language.
 *
 * A case is a graph: nodes are places, edges are what you did to get from one
 * to the next. One edge is exactly one transition, so the source reads like the
 * test it is.
 *
 *   testcase TD
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
 * Edge label is the action. Several on one transition can be `;`-separated, or
 * written one per line underneath, indented — which is what a recording of any
 * length produces, and the only form anybody can read:
 *
 *   n0 --> n1
 *     scroll to top
 *     click 'Learn' : navigation/link
 *     click 'Changelog' : navigation/link
 *
 * The vocabulary itself — every verb, how it is written and written back —
 * lives in vocabulary.js. This file is the shape of the document.
 *
 * It is NOT mermaid. It used to be: the header said `flowchart` and the stored
 * text was fed straight to a diagram renderer, which meant the grammar could
 * only contain what mermaid's lexer accepts — no double quotes, parentheses or
 * brackets anywhere in an action, so `Download (PDF)` was silently stored as
 * `Download PDF` and stopped resolving. `asFlowchart()` below translates a case
 * into mermaid when something wants to draw one, and takes that damage with it:
 * the picture loses the parentheses, the test keeps them.
 */

import {
  VERBS, OP_NAMES, verbFor, parseAction, showAction, showTarget, unq, value, target,
} from './vocabulary.js';

export { VERBS, OP_NAMES, verbFor, parseAction, showAction, showTarget, unq, value, target };

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

/** The header line. `flowchart`/`graph` still parse — every case on disk has one. */
const HEADER = /^(testcase|flowchart|graph)\b\s*(TD|TB|LR|RL|BT)?/i;

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

  // The edge an indented action line belongs to, and how far in its own line
  // started. Anything indented past that continues it; anything at or before
  // it closes the block.
  let open = null;

  for (const raw of text.split('\n')) {
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim().replace(/;+$/, '');
    // A block runs to the next blank line or dedent, so a stray indented line
    // further down the file cannot silently join an edge it has nothing to do
    // with.
    if (!line) { open = null; continue; }

    // A continuation: one action per line, under the edge it belongs to.
    if (open && indent > open.indent && !line.startsWith('%%')) {
      open.edge.label = open.edge.label ? `${open.edge.label}; ${line}` : line;
      continue;
    }
    open = null;

    let m;
    // The suite name rides in a comment, so a case that is pasted somewhere
    // still carries its own title.
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
    if (HEADER.test(line)) continue;
    if (/^(classDef|class|style|linkStyle|subgraph|end)\b/.test(line)) continue;

    if (!EDGE.test(line)) { declare(line); continue; }

    // Split the chain into node tokens and the edges between them.
    const parts = line.split(new RegExp(EDGE.source, 'g'));
    // parts = [node, arrow, label, node, arrow, label, node, ...]
    let prev = declare(parts[0]);
    let last = null;
    for (let i = 1; i < parts.length; i += 3) {
      const lbl = parts[i + 1];
      const next = declare(parts[i + 2]);
      if (prev && next) {
        last = { from: prev, to: next, label: lbl ?? '' };
        edges.push(last);
      }
      prev = next;
    }
    // Indented lines below a chain continue its LAST edge, which is the only
    // reading that means anything.
    if (last) open = { edge: last, indent };
  }

  if (!nodes.size) throw new Error('No nodes — is this a test case?');

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
const opsOf = (e) => (e.label ?? '').split(';').map(parseAction).filter(Boolean);

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

/** Convenience: case text straight to the IR the executor already runs. */
export const parse = (text) => flatten(parseFlow(text));

// ---------------------------------------------------------------- emitting

/**
 * What THIS language cannot lex, and nothing more.
 *
 * A node label is delimited by `"` and an edge label by `|`, so those two and a
 * line break have to go. Everything else — parentheses, brackets, quotes inside
 * a name — is kept, because it is part of the element's real accessible name
 * and dropping it means the target stops resolving. Mermaid's narrower rules
 * are mermaid's problem, and are applied in asFlowchart().
 */
const nodeText = (s) => String(s ?? '').replace(/["\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
const edgeText = (s) => String(s ?? '').replace(/[|\n\r]/g, ' ').replace(/\s+/g, ' ').trim();

/** More than this on one line and nobody reads it; it becomes a block instead. */
const ONE_LINE_MAX = 2;

/**
 * IR -> case text. The inverse of parseFlow for anything parseFlow produces,
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
    const acts = pending.filter(Boolean).map(edgeText);
    if (!acts.length) {
      lines.push(`  ${cur} --> ${to}`);
    } else if (acts.length <= ONE_LINE_MAX) {
      lines.push(`  ${cur} -->|${acts.join('; ')}| ${to}`);
    } else {
      // A recording of any length lands here. Four actions crammed into one
      // `|...|` is a line nobody reads, and reading it is the entire point.
      lines.push(`  ${cur} --> ${to}`, ...acts.map((a) => `    ${a}`));
    }
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
    // Not `if (s)`: a step the vocabulary cannot write back now throws, because
    // being quietly dropped from a script you are about to trust is worse.
    pending.push(showAction(step));
  }
  // Anything left over is a self-loop: more steps, same place.
  if (pending.length && cur) flush(cur);

  // Where each click actually landed. A comment, so it round-trips through the
  // language and stays out of the picture — it is evidence, not instruction.
  const marks = plan.steps
    .map((s, i) => (s.at ? `%% at ${i} ${s.at.x},${s.at.y} ${s.at.w}x${s.at.h} in ${s.at.vw}x${s.at.vh}` : null))
    .filter(Boolean);

  // Where each click actually went, hop by hop. A comment, like the coordinate
  // marks: it is what happened, not an instruction — but it is the thing you
  // need in front of you to decide whether `check 2 redirects` belongs here.
  plan.steps.forEach((s, i) => {
    if (!s.via?.length) return;
    marks.push(`%% via ${i} ${s.via.map((h) => `${h.status ?? '?'} ${h.url}`).join(' -> ')}`);
  });

  // What the entry page offered when this was recorded.
  const entry = plan.steps.find((s) => s.op === 'goto' && s.entry?.length);
  if (entry) marks.unshift(`%% entry ${JSON.stringify(entry.entry)}`);

  return [
    `%% suite "${nodeText(plan.suite ?? 'Recorded flow')}"`,
    'testcase TD',
    ...nodes,
    '',
    ...lines,
    ...(marks.length ? ['', ...marks] : []),
  ].join('\n');
}

// --------------------------------------------------------------- rendering

/** Everything mermaid cannot lex inside `["…"]` or `|…|`, and only that. */
const forMermaid = (s) => String(s).replace(/["()[\]|]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * A case -> a mermaid flowchart, for anywhere a picture is wanted: a README, a
 * ticket, a pull request. Paste the output and GitHub draws your suite.
 *
 * This is a view, not the document. It folds indented action blocks back onto
 * their edge and strips the characters mermaid's parser rejects — so a name
 * containing brackets survives in the test and is merely tidied in the drawing.
 */
export function asFlowchart(text, direction = 'TD') {
  const out = [];
  let open = null;          // an edge line awaiting its indented actions

  const closeBlock = () => {
    if (!open) return;
    const acts = open.actions.map(forMermaid).filter(Boolean);
    out.push(acts.length ? `  ${open.from} -->|${acts.join('; ')}| ${open.to}` : `  ${open.from} --> ${open.to}`);
    open = null;
  };

  let header = false;
  for (const raw of text.split('\n')) {
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    if (open && line && indent > open.indent && !line.startsWith('%%')) {
      open.actions.push(line);
      continue;
    }
    closeBlock();

    if (!line) { out.push(''); continue; }
    if (HEADER.test(line)) {
      out.push(`flowchart ${line.match(HEADER)[2] ?? direction}`);
      header = true;
      continue;
    }
    // Comments carry evidence (`%% at`, `%% via`) and the suite name. Mermaid
    // ignores them, so they ride along untouched.
    if (line.startsWith('%%')) { out.push(line); continue; }

    // A single edge, labelled or not, may have indented actions under it —
    // the same rule parseFlow reads by, or the two would disagree about what
    // a case says.
    const one = line.match(/^(\w+)\s*-{2,3}>\s*(?:\|([^|]*)\|\s*)?(\w+)$/);
    if (one) {
      open = { from: one[1], to: one[3], indent, actions: one[2] ? [one[2]] : [] };
      continue;
    }

    // Node labels and edge labels: same treatment, different delimiters.
    out.push('  ' + line
      .replace(/"([^"]*)"/g, (_, t) => `"${forMermaid(t)}"`)
      .replace(/\|([^|]*)\|/g, (_, t) => `|${forMermaid(t)}|`));
  }
  closeBlock();

  if (!header) out.unshift(`flowchart ${direction}`);
  return out.join('\n');
}

import { labelAction } from './vocabulary.js';

/**
 * IR -> mermaid `block-beta`.
 *
 * Pure function over the same data structure the executor walks, so the
 * picture cannot drift from what actually runs. Pass `results` and the same
 * function renders a run report instead of a plan: every step carries its
 * outcome and the failing step is highlighted with its error.
 *
 * Layout notes, all learned from rendering against the real parser:
 *  - block-beta sizes a cell roughly square, so LABEL LENGTH is what drives
 *    the diagram's height. Short labels, aggressively truncated.
 *  - Nested `block:...end` groups stretch their rows enormously. Everything
 *    here is one flat grid; full-width bands do the chunking instead.
 *  - A hexagon has less usable width than a rectangle in the same cell, so
 *    checkpoints get a smaller budget than actions.
 */

/** Per-shape label budgets, in characters. Exceeding these clips visibly. */
const BUDGET = { title: 62, page: 58, action: 24, check: 20, error: 84 };

/**
 * Everything that reaches a mermaid label goes through here, once. A bare `"`
 * inside `["..."]` is a lexical error, and a diagram that does not parse fails
 * silently inside someone else's docs — so quotes become typographic quotes,
 * which the parser has no opinion about.
 */
function q(s) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\\/g, '')
    .replace(/["`]/g, '”')
    .replace(/\s+/g, ' ')
    .trim();
}

function trunc(s, n) {
  const c = q(s);
  return c.length > n ? c.slice(0, n - 1) + '…' : c;
}

/**
 * Step -> the text in its block.
 *
 * Each verb draws itself — the label and its character budget are declared
 * beside that verb's syntax in vocabulary.js, so a new verb arrives in the
 * diagram already knowing how to appear rather than falling through to a
 * default that prints its op name and nothing else. Secrets are named, never
 * expanded.
 */
export function label(step, n) {
  const i = n === undefined ? '' : `${n} `;
  return `${i}${labelAction(step, trunc)}`;
}

/** A step that gets its own full-width band rather than a grid cell. */
const isBand = (s) => s.op === 'goto';
const isCheck = (s) => s.op === 'expect';

/**
 * @param {{suite:string, steps:object[]}} plan
 * @param {{results?: Array<{i:number, ok:boolean, ms?:number, error?:string}>,
 *          columns?:number, numbered?:boolean}} [opts]
 * @returns {string} mermaid block-beta source
 */
export function toMermaid(plan, opts = {}) {
  const COLS = Math.max(1, opts.columns ?? 3);
  const numbered = opts.numbered ?? true;
  const byIndex = new Map((opts.results ?? []).map((r) => [r.i, r]));
  const ran = byIndex.size > 0;

  const out = [];
  const cls = { page: [], action: [], check: [], pass: [], fail: [] };
  const spine = [];
  let col = 0;

  const line = (s) => out.push('  ' + s);
  // Finish the current row before a full-width band, or the grid shears.
  const endRow = () => {
    if (col % COLS) line(Array(COLS - (col % COLS)).fill('space').join(' '));
    col = 0;
  };
  // Outcome beats kind once a run exists, so colour means "what happened".
  const bucket = (i, kind) => {
    const r = byIndex.get(i);
    return r ? (r.ok ? 'pass' : 'fail') : kind;
  };

  out.push('block-beta');
  line(`columns ${COLS}`);

  const failed = [...byIndex.values()].filter((r) => !r.ok).length;
  const head = ran
    ? `${plan.suite} · ${byIndex.size}/${plan.steps.length} run · ${failed ? `${failed} failed` : 'all passed'}`
    : `${plan.suite} · ${plan.steps.length} steps`;
  line(`suite["${trunc(head, BUDGET.title)}"]:${COLS}`);

  plan.steps.forEach((step, i) => {
    const id = `s${i}`;
    const text = q(label(step, numbered ? i + 1 : undefined));

    if (isBand(step)) {
      endRow();
      line(`${id}("${text}"):${COLS}`);   // rounded band, full width
      cls[bucket(i, 'page')].push(id);
      spine.push(id);
      return;
    }
    if (isCheck(step)) {
      line(`${id}{{"${text}"}}`);         // hexagon reads as a gate
      cls[bucket(i, 'check')].push(id);
      spine.push(id);
      col++;
      return;
    }
    line(`${id}["${text}"]`);
    cls[bucket(i, 'action')].push(id);
    col++;
  });

  // The error, as its own band, so a failed run explains itself.
  const bad = [...byIndex.values()].find((r) => !r.ok && r.error);
  if (bad) {
    endRow();
    line(`err["✕ ${q(trunc(bad.error, BUDGET.error))}"]:${COLS}`);
    cls.fail.push('err');
  }

  // Arrows only along the spine — pages and checkpoints. Chaining every step
  // in a wrapping grid produces a cat's cradle; the step numbers carry order.
  if (spine.length > 1) {
    out.push('');
    for (let i = 0; i < spine.length - 1; i++) line(`${spine[i]} --> ${spine[i + 1]}`);
  }

  out.push('');
  line('classDef page fill:#ffe0b2,stroke:#fb8c00,stroke-width:2px,color:#4e342e');
  line('classDef action fill:#e3f2fd,stroke:#1e88e5,color:#0d47a1');
  line('classDef check fill:#ede7f6,stroke:#5e35b1,color:#311b92');
  line('classDef pass fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20');
  line('classDef fail fill:#ffebee,stroke:#c62828,stroke-width:2px,color:#b71c1c');
  for (const [name, ids] of Object.entries(cls)) {
    if (ids.length) line(`class ${ids.join(',')} ${name}`);
  }

  return out.join('\n');
}

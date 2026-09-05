/**
 * Line-oriented parser: text -> IR. It produces a data structure, never
 * anything executable.
 *
 * In the real system this stage is replaced by a model emitting IR directly
 * through a tool-use schema. The validator downstream doesn't care which
 * produced it, which is exactly the point.
 */
export function parse(text) {
  const steps = [];
  let suite = 'Ad-hoc run';

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [verb, ...rest] = line.split(/\s+/);
    const args = rest.join(' ');

    switch (verb) {
      case 'suite':
        suite = strip(args);
        break;

      case 'goto':
        steps.push({ op: 'goto', url: strip(args) });
        break;

      case 'click':
        steps.push({ op: 'click', target: strip(args) });
        break;

      // fill <target> with <value>   |   fill <target> with $secrets.KEY
      case 'fill': {
        const m = args.match(/^(\S+)\s+with\s+(.+)$/);
        if (!m) throw new Error(`Bad fill: ${line}`);
        const [, target, rhs] = m;
        const v = strip(rhs);
        steps.push(
          v.startsWith('$')
            ? { op: 'fill', target, valueRef: v.slice(1) }
            : { op: 'fill', target, value: expand(v) }
        );
        break;
      }

      // expect url contains "/settings"
      // expect text "Profile saved"
      // expect value profile.username is repeat("a", 20)
      case 'expect': {
        const u = args.match(/^url\s+contains\s+(.+)$/);
        const v = args.match(/^value\s+(\S+)\s+is\s+(.+)$/);
        const t = args.match(/^text\s+(.+)$/);
        if (u)      steps.push({ op: 'expect', assert: 'urlContains', value: strip(u[1]) });
        else if (v) steps.push({ op: 'expect', assert: 'valueEquals', target: v[1], value: expand(strip(v[2])) });
        else if (t) steps.push({ op: 'expect', assert: 'textVisible', value: strip(t[1]) });
        else throw new Error(`Bad expect: ${line}`);
        break;
      }

      case 'wait':
        steps.push({ op: 'wait', ms: parseInt(args, 10) || 500 });
        break;

      default:
        throw new Error(`Unknown verb "${verb}"`);
    }
  }

  if (!steps.length) throw new Error('Nothing to run');
  return { suite, steps };
}

const strip = (s) => (s ?? '').trim().replace(/^["']|["']$/g, '');

// repeat("a", 20) -> "aaaa…"  — bounded, no general expression evaluation.
function expand(v) {
  const m = v.match(/^repeat\(\s*["'](.+?)["']\s*,\s*(\d+)\s*\)$/);
  if (!m) return v;
  const n = Math.min(parseInt(m[2], 10), 500);
  return m[1].repeat(n);
}

import { sleep } from './cursor.js';

/**
 * Page-object registry. The DSL names keys from this map, never raw selectors.
 * Unknown keys fail validation before anything touches the browser, so a model
 * that hallucinates "#usr_nm_2" cannot reach Chrome.
 */
export const registry = {
  'auth.email':         (p) => p.getByLabel('Email'),
  'auth.password':      (p) => p.getByLabel('Password'),
  'auth.submit':        (p) => p.getByRole('button', { name: 'Sign in' }),
  'nav.settings':       (p) => p.getByRole('link', { name: 'Settings' }),
  'settings.profileTab':(p) => p.getByRole('button', { name: 'Profile' }),
  'profile.username':   (p) => p.getByLabel('Username'),
  'profile.save':       (p) => p.getByRole('button', { name: 'Save changes' }),
};

/** Never in the IR, never in a log, never in git. */
const secrets = {
  'secrets.QA_USER': 'qa@example.com',
  'secrets.QA_PASS': 'hunter2-but-from-a-vault',
};

/** Only these origins may be reached by a goto. Everything else is SSRF. */
const ALLOWED_ORIGINS = [`http://localhost:${process.env.PORT || 3000}`];

function point(box, opts) {
  const x = box.x + (opts.leftEdge ? Math.min(14, box.width / 2) : box.width / 2);
  return [x, box.y + box.height / 2];
}

async function boxOf(el, target) {
  const b = await el.boundingBox();
  if (!b) throw new Error(`"${target}" resolved but has no box`);
  return b;
}

async function pointAt(page, target, cursor, opts = {}) {
  const build = registry[target];
  if (!build) throw new Error(`Unknown target "${target}"`);
  const el = build(page);
  await el.waitFor({ state: 'visible', timeout: 8000 });
  await el.scrollIntoViewIfNeeded();

  const [x, y] = point(await boxOf(el, target), opts);
  await cursor.glideTo(x, y, opts.ms);

  // The page can reflow during the glide — async content landing, a smooth
  // scroll still settling. Re-read and correct, or we click stale pixels.
  const [x2, y2] = point(await boxOf(el, target), opts);
  if (Math.hypot(x2 - cursor.x, y2 - cursor.y) > 2) await cursor.glideTo(x2, y2, 120);

  await sleep(140); // let hover settle, and let the viewer's eye catch up
  return el;
}

/**
 * The whole executable vocabulary. Five hand-written functions.
 * There is no `eval`, no `evaluate`, no raw-selector op. That absence is the
 * security model: there is structurally no path from generated text to
 * arbitrary code.
 */
export const OPS = {
  async goto(page, step) {
    await page.goto(step.url, { waitUntil: 'domcontentloaded' });
  },

  async click(page, step, ctx) {
    await pointAt(page, step.target, ctx.cursor);
    await ctx.cursor.click();
  },

  async fill(page, step, ctx) {
    await pointAt(page, step.target, ctx.cursor, { leftEdge: true });
    await ctx.cursor.click(); // focus the way a user does, not via .fill()
    const value = step.valueRef ? secrets[step.valueRef] : step.value;
    if (value === undefined) throw new Error(`No value for ${step.target}`);
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type(value, { delay: 42 });
  },

  async expect(page, step) {
    if (step.assert === 'urlContains') {
      await page.waitForURL((u) => u.href.includes(step.value), { timeout: 8000 });
    } else if (step.assert === 'textVisible') {
      await page.getByText(step.value, { exact: false }).first()
        .waitFor({ state: 'visible', timeout: 8000 });
    } else if (step.assert === 'valueEquals') {
      const actual = await registry[step.target](page).inputValue();
      if (actual !== step.value) {
        throw new Error(
          `${step.target} is "${actual}" (${actual.length} chars), ` +
          `expected ${step.value.length} chars`
        );
      }
    } else {
      throw new Error(`Unknown assertion "${step.assert}"`);
    }
  },

  async wait(page, step) {
    await sleep(Math.min(step.ms ?? 500, 5000));
  },
};

/**
 * Validation gate. In production this is a Zod or JSON Schema check driven by
 * the same schema you hand the model as a tool definition. The point is that
 * it runs between "model produced something" and "browser did something".
 */
export function validate(plan) {
  if (!plan || !Array.isArray(plan.steps)) throw new Error('Plan has no steps');
  if (plan.steps.length > 60) throw new Error('Plan too long');

  plan.steps.forEach((s, i) => {
    if (!OPS[s.op]) throw new Error(`Step ${i}: unknown op "${s.op}"`);
    if ('target' in s && !registry[s.target]) {
      throw new Error(`Step ${i}: unknown target "${s.target}"`);
    }
    if (s.op === 'goto') {
      let u;
      try { u = new URL(s.url ?? ''); }
      catch { throw new Error(`Step ${i}: goto needs an absolute http(s) url`); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error(`Step ${i}: goto needs an http(s) url, got ${u.protocol}`);
      }
      // Scheme alone is not enough: any http origin reachable from inside the
      // network is an SSRF target. Allowlist origins, not protocols.
      if (!ALLOWED_ORIGINS.includes(u.origin)) {
        throw new Error(`Step ${i}: origin ${u.origin} is not allowlisted`);
      }
    }
    if (s.op === 'fill' && typeof s.value === 'string' && /pass|secret|token/i.test(s.value)) {
      throw new Error(`Step ${i}: literal credential — use valueRef`);
    }
  });

  return plan;
}

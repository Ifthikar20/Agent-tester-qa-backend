/**
 * An organisation's name, as the runner uses it: a directory.
 *
 * Every store the runner keeps — the origin allowlist, the vault, run
 * history, the suites — is keyed by the organisation in the token, and the
 * key is a path segment: `.ghostclick/<org>/` and `suites/<org>/`
 * (docs/AUTH.md §10 [authz-tenancy-1]). A path segment that came out of a
 * signed token is still a path segment, so the shape is pinned here, once,
 * and every store refuses anything else before it touches the filesystem.
 * The control plane guarantees the same shape (tenants.slugs), which is why
 * the two never disagree about what a slug is.
 *
 * `local` is the organisation of a runner with no login: one person, one
 * laptop, one workspace, and the same code path as everyone else so that
 * laptop mode is not a second implementation.
 */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const LOCAL = 'local';

/** Lowercase letters, digits and hyphens, starting with a letter or digit, at most 63 long. */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const isOrg = (org) => typeof org === 'string' && SLUG.test(org);

export function assertOrg(org) {
  if (!isOrg(org)) throw new Error(`not an organisation slug: ${JSON.stringify(org)}`);
  return org;
}

const ROOT = fileURLToPath(new URL('./', import.meta.url));

/** `.ghostclick/<org>/` — machine-local state, gitignored. */
export const stateDir = (org) => join(ROOT, '.ghostclick', assertOrg(org));

/** `suites/<org>/` — project data, in the repository. */
export const suitesDir = (org) => join(ROOT, 'suites', assertOrg(org));

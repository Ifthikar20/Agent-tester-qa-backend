/**
 * The words that mean a control does something a rule must not do on its own.
 *
 * A rule may draft a case that clicks a link, because following a link is how
 * you find out whether it goes where it says. It may not draft one that clicks
 * "Delete account", "Pay now" or "Sign up" — those press something in the real
 * world, on somebody's real site, and a person has to be the one who decides
 * that. So `draftByRules` vets every click against this list and drafts none
 * that matches (chat-plan.js).
 *
 * `sign up` is in the list deliberately. Creating an account is a real-world
 * action with a real-world consequence, and the fact that it reads here beside
 * pay and delete is the reason a signup a person asked for has to arrive as an
 * approval carrying the origin, never as a rule the runner applies to itself.
 *
 * Kept as its own module rather than inside the drafter: the same list is what
 * the fix layer uses to decide a model's move is one it may not make, and two
 * copies of a safety word list is one copy too many.
 */
const HARM_WORDS = 'delet\\w*|remov\\w*|destroy\\w*|eras\\w*|discard\\w*|pay|payment|buy|purchas\\w*|order|checkout|' +
  'confirm\\w*|submit\\w*|accept\\w*|agree\\w*|allow\\w*|approv\\w*|sign ?(?:out|up)|log ?out|unsubscrib\\w*|cancel\\w*|' +
  'publish\\w*|send|transfer\\w*|archiv\\w*|reset|revoke\\w*|disabl\\w*|deactivat\\w*|close (?:my )?(?:account|project|workspace)';

/** `link:Delete this project` matches; `link:Pricing` does not. */
export const HARMFUL = new RegExp(`\\b(${HARM_WORDS})\\b`, 'i');

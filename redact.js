/**
 * Vault values, taken out of text on its way out of the runner.
 *
 * An app logging the token it just received is not unusual, and a secret that
 * never leaves the server must not leave it through a console line, a
 * monitored element's text or a screenshot's caption. The rule is one function
 * so the page's console (server.js) and the monitoring engine (monitor.js)
 * apply the same one to the same organisation's vault.
 *
 * Two characters would match everywhere; a real secret is not that short.
 */
export function redactWith(vault, text) {
  let out = String(text ?? '');
  if (!vault) return out;
  for (const name of vault.names()) {
    const v = vault.get(`secrets.${name}`);
    if (typeof v === 'string' && v.length >= 4) out = out.split(v).join(`$${name}`);
  }
  return out;
}

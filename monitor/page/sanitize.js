// ---- the excerpt's sanitiser ------------------------------------------------
/**
 * An element's markup, cut down to evidence.
 *
 * The compiler and the judge (monitor-resolver.js) read an excerpt of the
 * element's own markup so a rule can bind to what is really there — which
 * child carries the price, whether "rows" are table rows or list items, which
 * class the rule names. What they must never read is code: a page's scripts,
 * its inline handlers, an embedded document, a URL that runs something. Those
 * are removed here, in the page, before the markup leaves it; long attribute
 * values are cut, whitespace collapsed, and the whole thing capped at a tag
 * boundary so the model sees the shape and not a wall of bytes.
 *
 * Pure — a string in, a string out, no DOM — so the runner's offline check
 * runs the same function without a browser (monitor-page.js pageSanitizer).
 * This file is the first in the page bundle; core.js calls it.
 */
const EXCERPT_HTML_MAX = 6000;
const EXCERPT_ATTR_MAX = 120;
const CODE_TAGS = 'script|style|template|noscript|svg|iframe|object|embed';

function sanitizeHtml(html, max) {
  const limit = max > 0 ? max : EXCERPT_HTML_MAX;
  let s = String(html == null ? '' : html);
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // Whole elements that are code, style or a document of their own: gone,
  // the tag left as a note that something was there. An unclosed one takes
  // the rest of the string with it.
  s = s.replace(new RegExp('<(' + CODE_TAGS + ')\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>', 'gi'), '<$1/>');
  s = s.replace(new RegExp('<(' + CODE_TAGS + ')\\b(?![^>]*/>)[^>]*>[\\s\\S]*$', 'gi'), '<$1/>');
  // Attributes: handlers and embedded documents out, URL schemes that run
  // something cut to their scheme, long values cut.
  s = s.replace(/<([a-zA-Z][\w:-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>`]+))?)*)\s*(\/?)>/g, (m, tag, attrs, slash) => {
    const out = [];
    const re = /([^\s"'<>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'<>`]+))?/g;
    let a;
    while ((a = re.exec(attrs))) {
      const name = a[1].toLowerCase();
      if (/^on/.test(name) || name === 'srcdoc') continue;
      if (a[2] == null) { out.push(a[1]); continue; }
      const quoted = a[2][0] === '"' || a[2][0] === "'";
      const q = quoted ? a[2][0] : '"';
      let v = quoted ? a[2].slice(1, -1) : a[2];
      if (/^\s*(javascript|vbscript|data):/i.test(v)) v = v.replace(/^\s*(javascript|vbscript|data):[\s\S]*$/i, '$1:…');
      if (v.length > EXCERPT_ATTR_MAX) v = v.slice(0, EXCERPT_ATTR_MAX) + '…';
      out.push(a[1] + '=' + q + v + q);
    }
    return '<' + tag + (out.length ? ' ' + out.join(' ') : '') + (slash ? '/' : '') + '>';
  });
  s = s.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
  if (s.length > limit) {
    const cut = s.lastIndexOf('>', limit);
    s = (cut > limit / 2 ? s.slice(0, cut + 1) : s.slice(0, limit)) + '…';
  }
  return s;
}

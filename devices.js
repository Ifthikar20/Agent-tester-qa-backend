/**
 * The devices you can drive the page as.
 *
 * A device is a viewport plus what a site reads to decide it is on a phone: the
 * width and height it lays out for, the pixel ratio it renders at, whether it is
 * "mobile" (which changes layout and turns clicks into taps), and the user-agent
 * it announces. Selecting one in the console applies it to the LIVE page over
 * CDP — no reload, no lost login — so the same flow can be run at 375px and at
 * 1440px and the difference is a dropdown, not a second suite.
 *
 * `desktop` is first and matches the console's default viewport (server.js VIEW),
 * so with nothing selected the behaviour is exactly today's.
 *
 * The list is the server's, and the console draws its dropdown from what the
 * server sends (the `ready` greeting), so the two cannot drift.
 */

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

/**
 * id -> { label, width, height, dpr, mobile, ua? }. width/height are CSS pixels
 * (the layout viewport and the coordinate space the cursor uses); dpr is only
 * what the page sees as devicePixelRatio. A desktop device leaves the user-agent
 * alone (ua omitted); a mobile one announces itself so a site serves its phone
 * page. Keep it a curated handful — a dropdown, not a catalogue.
 */
export const DEVICES = {
  desktop:     { label: 'Desktop',     width: 1180, height: 760,  dpr: 1,   mobile: false },
  laptop:      { label: 'Laptop',      width: 1280, height: 800,  dpr: 1,   mobile: false },
  wide:        { label: 'Wide',        width: 1440, height: 900,  dpr: 1,   mobile: false },
  ipad:        { label: 'iPad',        width: 768,  height: 1024, dpr: 2,   mobile: true,  ua: IPAD },
  'ipad-pro':  { label: 'iPad Pro',    width: 1024, height: 1366, dpr: 2,   mobile: true,  ua: IPAD },
  'iphone-se': { label: 'iPhone SE',   width: 375,  height: 667,  dpr: 2,   mobile: true,  ua: IPHONE },
  'iphone-14': { label: 'iPhone 14',   width: 390,  height: 844,  dpr: 3,   mobile: true,  ua: IPHONE },
  'pixel-7':   { label: 'Pixel 7',     width: 412,  height: 915,  dpr: 2.6, mobile: true,  ua: ANDROID },
};

export const DEFAULT_DEVICE = 'desktop';

/** A device by id, or the default when the id is unknown. */
export const deviceOf = (id) => DEVICES[id] ?? DEVICES[DEFAULT_DEVICE];

/**
 * What the console needs to draw its dropdown: id + label + size + whether it is
 * a phone/tablet (for the little icon), and never the user-agent string.
 */
export const deviceList = () =>
  Object.entries(DEVICES).map(([id, d]) => ({ id, label: d.label, width: d.width, height: d.height, mobile: d.mobile }));

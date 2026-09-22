// Service worker for "Namaz — El-Feth" (prayer times, El-Feth Moskee Tilburg).
//
// ===========================================================================
//  BUMP CACHE_VERSION TO PUSH AN UPDATE ONTO THE PHONE. Nothing else forces it.
// ===========================================================================
// A browser only treats a worker as "new" when the bytes of this file change,
// and the old files are only thrown away when the cache NAME changes. So the
// ritual is: edit anything in the app -> bump CACHE_VERSION -> commit -> push.
// Forgetting it is the one reason an update appears never to arrive.
const CACHE_VERSION = 'elfeth-v1';

// Every cache this app has ever opened starts with this prefix so activate()
// can delete the old ones without touching a different app on the same origin.
// (github.io is ONE origin shared by every repo of the account; deleting
// "every cache" here would sabotage the other apps installed on the phone.)
// Keep this a prefix of CACHE_VERSION.
const CACHE_PREFIX = 'elfeth-';

// A string that appears in our own index.html and in nothing else. It is how we
// tell our page apart from a wifi login page, which is otherwise identical from
// the outside: HTTP 200, content-type text/html. See isOurPage() for the exact,
// deliberately forgiving rule — the app still works if index.html omits it.
//
//   INTEGRATION NOTE: index.html should carry
//     <meta name="app-id" content="elfeth-prayer-times">
//   Without it nothing breaks; with it, hotel/airport wifi cannot replace the
//   cached app with a login form.
const SHELL_MARKER = 'elfeth-prayer-times';

// The directory this worker was served from, e.g. "/el-feth-prayer-times/".
// Derived, not hard-coded, because the same files have to work at the root of a
// custom domain, under /<repo>/ on GitHub Pages, and at whatever path a local
// test server picks. Anything outside this directory is none of our business.
const DIR = self.location.pathname.replace(/[^/]*$/, '');

// Our own script URL. Never serve this from the cache: a cached worker can pin
// the app to an old version forever, and that is not fixable remotely.
const SELF_PATH = self.location.pathname;

// The shell. Written relative so the list stays readable; resolved against the
// worker URL below, which is exactly how the page will ask for them.
const SHELL = [
  './',                       // the bare directory URL - what the home-screen icon opens
  './index.html',
  './times.json',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',   // iOS ignores the manifest icons for the home screen
];

// Two resolvers, both against the worker's own URL (the base for every relative
// URL inside a service worker):
//   absUrl() -> the full URL, for building Requests.
//   abs()    -> the path only, for route comparisons and cache keys. Cache keys
//               resolve against the same base, so the two always agree.
const absUrl = function (p) { return new URL(p, self.location.href).href; };
const abs = function (p) { return new URL(p, self.location.href).pathname; };

// ---------------------------------------------------------------------------
// "is this really the thing I asked for?"
// ---------------------------------------------------------------------------
// Captive portals - hotel, airport, train, guest wifi - answer EVERY request
// with HTTP 200 and their own login page. Cache that once and index.html or
// times.json has been replaced by a login form: the app is then broken offline,
// permanently, with no obvious way for him to clear it. So a response only gets
// into the cache if it is OK, was not redirected, and is not HTML where HTML has
// no business being.
//
// './', './index.html', and any extensionless route are pages; everything with
// an extension we do not recognise is treated as an asset rather than being
// forced to look like HTML (data/*.md, a .txt, a favicon someone adds later).
function expectsHtml(path) {
  return /\.html?$/.test(path) || !/\.[a-z0-9]+$/i.test(path);
}

function looksRight(resp, path) {
  if (!resp || !resp.ok) return false;
  // A redirect means something answered on someone else's behalf. It also makes
  // the response illegal to hand back for a navigation request, which throws.
  if (resp.redirected) return false;
  if (resp.type === 'opaque' || resp.type === 'opaqueredirect' || resp.type === 'error') return false;

  const got = (resp.headers.get('content-type') || '').toLowerCase();

  // A page must be HTML, or declare nothing at all - servers do omit the type
  // for a bare directory URL.
  if (expectsHtml(path)) return !got || got.indexOf('html') !== -1;

  // An asset must not be a login page. That single rule is the whole protection,
  // and stating it that way keeps us tolerant of servers that mislabel
  // .webmanifest or a font: a wrong-but-honest type is a nuisance, not an
  // attack, and rejecting it would cost offline support for no gain.
  return got.indexOf('html') === -1;
}

async function bodyText(resp) {
  // clone() first: reading a body consumes it, and the caller still needs it.
  try { return await resp.clone().text(); } catch (e) { return null; }
}

// The content-type test cannot save the HTML shell, because a login page IS
// html. This can: a page we already trust tells us what our own page looks
// like. The rule is deliberately self-calibrating -
//   - no cached copy yet, or the cached copy has no marker -> accept anything
//     (nothing to lose, and we must not break an index.html that omits it),
//   - cached copy HAS the marker but the new response does not -> reject.
// So the protection switches itself on the first time it sees a real shell, and
// forgetting the meta tag costs nothing.
async function isOurPage(cache, cacheKey, resp) {
  const prev = await cache.match(cacheKey);
  if (!prev) return true;
  const prevText = await bodyText(prev);
  if (!prevText || prevText.indexOf(SHELL_MARKER) === -1) return true;
  const nowText = await bodyText(resp);
  return !!nowText && nowText.indexOf(SHELL_MARKER) !== -1;
}

// ---------------------------------------------------------------------------
// fetching with a short leash
// ---------------------------------------------------------------------------
// A network that accepts the connection and then says nothing - the classic
// "connected, no internet" - must never leave him staring at a blank screen.
const NET_TIMEOUT_MS = 3000;        // on the critical path: page and times.json
const PRECACHE_TIMEOUT_MS = 15000;  // install: slow mobile data deserves patience

async function fromNetwork(url, ms) {
  // Fetched by URL string rather than by passing the Request through: a request
  // whose mode is "navigate" cannot be re-created with a different init in every
  // engine, and these are all static public files - none of our headers, cookies
  // or credentials matter.
  const ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
  let timer = 0;
  const timeout = new Promise(function (_, reject) {
    timer = setTimeout(function () {
      if (ctrl) ctrl.abort();   // actually let the socket go, do not merely stop listening
      reject(new Error('timeout'));
    }, ms);
  });
  try {
    return await Promise.race([
      fetch(url, {
        cache: 'no-store',          // bypass the HTTP cache; that is what "fresh" means here
        credentials: 'same-origin',
        redirect: 'follow',         // follow it, then reject it in looksRight()
        signal: ctrl ? ctrl.signal : undefined
      }),
      timeout
    ]);
  } finally {
    clearTimeout(timer);            // a stray timer keeps the worker alive for nothing
  }
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------
// caches.keys() is in creation order, so the last one of ours is the cache the
// currently installed version built.
async function previousCache() {
  const keys = (await caches.keys()).filter(function (k) {
    return k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE_VERSION;
  });
  if (!keys.length) return null;
  return caches.open(keys[keys.length - 1]);
}

// One shell file. Every failure is swallowed and, where possible, the copy the
// previous version cached is carried forward. That matters: activate() deletes
// the old cache, so a version bump that happens to land while he is on hotel
// wifi or in a tunnel must not end with an app that has no offline copy at all.
// (cache.addAll() would be worse still - it is atomic, so a single 404 on an
// icon would abandon the whole install. Partial offline beats none.)
async function precacheOne(cache, prev, p) {
  const key = abs(p);
  try {
    const resp = await fromNetwork(absUrl(p), PRECACHE_TIMEOUT_MS);
    if (!looksRight(resp, key)) throw new Error('unusable response');
    if (expectsHtml(key) && prev && !(await isOurPage(prev, key, resp))) {
      throw new Error('not our page');   // a portal, not the app
    }
    await cache.put(key, resp);
    return;
  } catch (e) {
    if (!prev) return;
    const old = await prev.match(key);
    if (old) await cache.put(key, old).catch(function () {});
  }
}

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    const cache = await caches.open(CACHE_VERSION);
    const prev = await previousCache();
    await Promise.all(SHELL.map(function (p) {
      return precacheOne(cache, prev, p).catch(function () {});
    }));
    // Take over without waiting for every tab to close: there is no audio and
    // no unsaved state in this app, so an instant swap interrupts nothing.
    await self.skipWaiting();
  })());
});

// ---------------------------------------------------------------------------
// activate
// ---------------------------------------------------------------------------
self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(function (k) { return k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE_VERSION; })
      .map(function (k) { return caches.delete(k); }));
    // Claim the page that is already open, otherwise it keeps being served by
    // the previous worker until it is closed - and for an installed iOS PWA
    // "closed" can be days away.
    await self.clients.claim();
  })());
});

// Lets the page ask for an immediate swap if it ever finds a worker stuck in
// "waiting". skipWaiting() above normally makes this moot, but it costs nothing
// and covers a worker that installed while the page was hidden.
self.addEventListener('message', function (event) {
  const d = event.data;
  if (d === 'SKIP_WAITING' || (d && d.type === 'SKIP_WAITING')) self.skipWaiting();
});

// ---------------------------------------------------------------------------
// network-first (the page and times.json)
// ---------------------------------------------------------------------------
// We want today's file, but the cached copy - at worst a day stale - beats
// waiting, and always beats a blank screen.
async function freshFirst(request, cacheKey) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const resp = await fromNetwork(request.url, NET_TIMEOUT_MS);
    if (!looksRight(resp, cacheKey)) throw new Error('unusable response');
    if (expectsHtml(cacheKey) && !(await isOurPage(cache, cacheKey, resp))) {
      throw new Error('not our page');   // portal login screen; serve the real app instead
    }
    // Clone before returning: a body can only be read once. put() is
    // deliberately not awaited so the page is never held up by a disk write.
    cache.put(cacheKey, resp.clone()).catch(function () {});
    return resp;
  } catch (err) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
    // Nothing cached (iOS evicts the storage of apps it decides are idle).
    // Try the directory URL as a stand-in for index.html and vice versa, then
    // give up and let the browser report the failure itself - a hand-made
    // "you are offline" page would be one more thing on screen he did not ask for.
    if (cacheKey === abs('./index.html')) {
      const alt = await cache.match(abs('./'));
      if (alt) return alt;
    } else if (cacheKey === abs('./')) {
      const alt2 = await cache.match(abs('./index.html'));
      if (alt2) return alt2;
    }
    return fetch(request).catch(function () { return Response.error(); });
  }
}

// ---------------------------------------------------------------------------
// cache-first (everything else inside our folder: icons, fonts, images)
// ---------------------------------------------------------------------------
// Those only change when CACHE_VERSION changes, so the cache is authoritative
// and we never pay for a round trip on them.
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const resp = await fetch(request);
    // Only same-origin, in-scope requests get here, so anything failing
    // looksRight() is an interception: we still hand it to the page (letting the
    // browser complain is its job) but it must not enter the cache.
    if (looksRight(resp, new URL(request.url).pathname)) {
      cache.put(request, resp.clone()).catch(function () {});
    }
    return resp;
  } catch (err) {
    // Offline and not precached: a cache-busting "?v=2" misses an exact match
    // even when we do hold the file, so retry ignoring the query string.
    const loose = await cache.match(request, { ignoreSearch: true });
    if (loose) return loose;
    return Response.error();
  }
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------
self.addEventListener('fetch', function (event) {
  const req = event.request;

  // POST/HEAD/etc. are not ours to answer, and Cache Storage cannot key on them.
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Cross-origin (a font CDN, a map tile, anything) goes straight to the
  // network: we must not cache what we cannot validate, and an opaque response
  // is indistinguishable from a portal's rubbish.
  if (url.origin !== self.location.origin) return;

  // Same origin, but a different app elsewhere on this Pages site. DIR ends in
  // "/", so a sibling repo whose name merely starts the same way is excluded.
  if (url.pathname.indexOf(DIR) !== 0) return;

  // Never serve the worker itself from the cache - see SELF_PATH above.
  if (url.pathname === SELF_PATH) return;

  // The page: fresh if the network is quick, cached the moment it dawdles.
  if (req.mode === 'navigate') {
    event.respondWith(freshFirst(req, abs('./index.html')));
    return;
  }

  // The prayer times: the one file that genuinely changes under us (the
  // scheduled scrape rewrites it), so it gets the same fresh-first treatment.
  if (url.pathname === abs('./times.json')) {
    event.respondWith(freshFirst(req, abs('./times.json')));
    return;
  }

  event.respondWith(cacheFirst(req));
});

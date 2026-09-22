# Namaz — El-Feth

Prayer times for **El-Feth Moskee**, Stedekestraat 27, Tilburg, installed on a
phone's home screen as a PWA. English, and deliberately bare: there is nothing on the screen that is not a
time or the name of a prayer. Works completely offline and keeps itself up to
date without anyone touching it.

It shows, in this order:

- **the time left until the next adhan**, live to the second, and when it is;
- **the window that is open right now** as an interval, with how far through it
  you are and how long is left;
- **every window of the day as an interval**, Tahajjud first, then the five.

That is all. No location line, no date, no clock (the phone has one), no
buttons, no settings, no install banner. It is a display.

## The prayer windows

| | from | to |
|---|---|---|
| **Tahajjud** (voluntary) | last third of the night | Fajr |
| **Fajr** | fajr | sunrise |
| **Dhuhr** | dhuhr | asr |
| **Asr** | asr | maghrib |
| **Maghrib** | maghrib | isha |
| **Isha** | isha | next Fajr |

Deliberate choices, not oversights:

- **Tahajjud** is the last third of the night: `night = fajr − maghrib`, and the
  window is `fajr − night/3 → fajr`. The night that ends at Fajr on a given day
  began at **the previous day's Maghrib**. It overlaps Isha, because it really
  does — Isha is the obligatory window and keeps the accent bar; Tahajjud sits
  inset behind a dashed rule and never takes the solid fill. That is the whole
  distinction, and it needs no badge.
- **Asr** is the standard opinion (shadow factor 1), not Hanafi, because that is
  what the mosque publishes.
- **Sunrise** is a boundary, never a prayer row, and is not shown as one: the
  Fajr row's interval already ends at it, to the minute.
- Between sunrise and Dhuhr **nothing is open**, and the app says so rather than
  pretending Fajr is still running.
- In the small hours the Isha row shows **last night's** instance — the one you
  are actually standing in — marked *last night* so it cannot be misread
  against the Maghrib row above it.

## Where the times come from

`times.json` is generated. **Do not edit it by hand.**

| | source | precedence |
|---|---|---|
| 1 | `data/print-<year>-<mm>.md` — the mosque's **printed** calendar, typed up | wins |
| 2 | `data/elfeth-<year>-raw.json` — the mosque's own website feed | ground truth |
| 3 | Mawaqit | cross-check only |

The feed is the WordPress *Daily Prayer Time for Mosques* plugin on the mosque's
own site:

```
https://www.el-feth.nl/wp-json/dpt/v1/prayertime?filter=year
```

The `*_begins` fields are used — those are the adhan times. The `*_jamah`
congregation times differ by a minute or two and are deliberately ignored.

**Mawaqit is not wrong.** It was suspected of being off; across all 2190 values
of 2026 it differs from the mosque's own site on exactly one (1 January Isha,
18:29 vs 18:30). It is kept as an independent cross-check, nothing more.

Against the printed September 2026 sheet, 179 of 180 values match the feed
exactly. The one exception is **1 September Isha**: print `22:01`, feed `22:00`.
The printed sheet wins — it is the calendar handed out at the mosque — so that
day is tagged `src: "p"` in `times.json`.

### Why the file stores UTC

Every time is stored as **minutes after 00:00 UTC** on its calendar day, keyed
`MM-DD`, and the app renders it through `Europe/Amsterdam`. Local clock times
would silently break every time daylight saving moved to a different calendar
date in a different year. Storing the instant and re-applying the *current*
year's rules means the file stays correct in 2027, 2030 and beyond. Verified:
all 2190 values re-render to the exact clock time **and** the exact date they
came from, and the switch days land correctly in 2026–2029.

29 February is absent (2026 is not a leap year); the app falls back to 28
February, which is at most a minute out, once every four years.

### Refreshing by hand

```
node data/fetch-elfeth.js 2027    # refuses a partial or malformed year
node data/build-times.js          # -> times.json
node tools/embed-seed.js          # -> re-embeds the copy inside index.html
```

Then bump `CACHE_VERSION` in `sw.js`, commit and push. The scheduled workflow
does exactly this every night, and commits only when something actually changed.

## How an update reaches the phone

1. Make the change.
2. **Bump `CACHE_VERSION` in `sw.js`.** Skipping this is the one reason an
   update appears never to arrive — the browser serves the old files from Cache
   Storage until the cache *name* changes.
3. Commit and push. Pages redeploys in a couple of minutes.

The app re-checks on open, on returning to it, on regained connectivity, and
every 15 minutes. A new service worker takes over and the page reloads itself —
there is nothing playing and nothing unsaved, so that is always safe. An
installed-but-waiting worker is nudged with `SKIP_WAITING`, because iOS will
otherwise park one for days.

`.github/workflows/refresh-times.yml` scrapes the feed nightly at 03:17 UTC,
rebuilds `times.json`, re-embeds the seed, bumps the cache version and pushes —
**only if the times actually changed**. A failed or partial scrape is a warning
that changes nothing, never a commit.

## Offline

Three layers, so the screen is never blank:

1. the service worker's precached copy of `times.json`;
2. a copy in `localStorage` from the last successful fetch;
3. a copy **compiled into `index.html`** (`<script type="application/json"
   id="seed">`), which survives a first launch with no network at all and a
   phone whose Cache Storage iOS has evicted for being idle.

The stored copy and the seed are compared by their `generated` date and the
fresher one wins. A captive-portal response (200 with a login page) is rejected
before it can reach either the cache or the screen.

## iPhone

The app was measured, not assumed, in Chromium at 320×568, 375×667, 375×812,
393×724, 393×852 and 430×932 with real safe-area insets simulated, at seven
moments across the year (midday, Tahajjud at 03:10 on the longest night of the
year, the minute before Isha, the sunrise→Dhuhr gap, New Year's Eve, and both
daylight-saving switch days).

**All 42 combinations fit on one screen — no scrolling, no clipping, no
horizontal overflow, no console errors** — down to and including a 320×568
iPhone 5/SE1, in every state. The layout is also the same height at midday and
at 03:00, so a scrollbar never appears as a surprise in the middle of the night.

Also handled: `viewport-fit=cover` with safe-area padding on all four edges,
`black-translucent` status bar, an opaque 180×180 `apple-touch-icon.png` (iOS
ignores the manifest icons and renders transparency as black), `overscroll-behavior`
and a matching `html` background so the rubber band never shows a wrong colour,
`touch-action:manipulation` so a stray double tap cannot zoom a standalone
window with no reload button, tabular figures and a zero-padded countdown so no
digit ever shifts, and a timer that re-derives everything from the clock on
`visibilitychange` rather than trusting counters iOS froze hours ago.

Install: open the page in Safari → Share → **Add to Home Screen**.

## Layout of the repository

```
index.html          the whole app: inline CSS, inline JS, embedded schedule
sw.js               service worker — CACHE_VERSION lives at the top
manifest.webmanifest
times.json          generated; never hand-edited
icon-*.png apple-touch-icon.png
data/
  fetch-elfeth.js   downloads and validates a year from the mosque feed
  build-times.js    raw + printed sheet -> times.json
  print-2026-09.md  the printed calendar, typed up, as a cross-check
  *-raw.json        committed on purpose: the audit trail
  README.md         the data pipeline in detail
tools/
  embed-seed.js     re-embeds times.json into index.html
  make-icons.js     regenerates the icons, no dependencies
docs/design-candidates/   three design candidates this app was chosen from
.github/workflows/
  refresh-times.yml nightly scrape -> rebuild -> commit, only if changed
  pages.yml         deploy to GitHub Pages
```

No build step, no dependencies, no framework. Plain HTML, CSS and JS, and Node
scripts that use only the standard library.

# Where the prayer times come from

`times.json` in the repository root is **generated**. Do not edit it by hand —
the next build overwrites it. Everything it contains is produced from the files
in this folder by `node data/build-times.js`.

## The sources, in order of precedence

| # | Source | File | Wins over |
|---|---|---|---|
| 1 | The **printed calendar** handed out at the mosque, typed up by hand | `print-<year>-<mm>.md` | everything |
| 2 | **El-Feth Moskee's own website feed** (`el-feth.nl`, WordPress plugin *Daily Prayer Time for Mosques*) | `elfeth-<year>-raw.json` | Mawaqit |
| 3 | **Mawaqit** (`mawaqit.net/en/el-feth-tilburg-1`), used only for a day the feed is missing | `mawaqit-<year>-raw.json` | nothing |
| 4 | Linear interpolation between the neighbouring days, for a gap none of the above covers | — | nothing |

Each day in `times.json` carries a `src` tag saying which of these it came from:
`f` = feed, `p` = printed sheet, `m` = Mawaqit, `c` = computed.

The mosque's own feed is the ground truth. Mawaqit is not a second opinion — it
is the *same data*, republished, and the build proves that every time it runs:
across all 2190 values of 2026 the two differ on exactly one (1 January Isha,
18:29 vs 18:30). If that number ever grows, one of the two has moved and the
build log will say so.

Where the **printed sheet** disagrees with the feed, the printed sheet wins: it
is the calendar physically handed out at the mosque, and it is what the people
praying there are looking at. For September 2026 that is a single value
(1 September Isha, feed 22:00 → print 22:01). Every override is listed in the
build output.

Only the `*_begins` fields are used. The `*_jamah` fields are congregation
times, a minute or two later, and are deliberately ignored everywhere.

## Why UTC is stored rather than the local clock time

Every source publishes **local Amsterdam clock times**. Storing those verbatim
would rot, because the EU daylight-saving switch moves every year: it is the
last Sunday of March and the last Sunday of October, which in 2026 means
29 March and 25 October, but in 2027 means 28 March and 31 October. A table
printed for 2026 and replayed in 2027 would be a full hour wrong for about a
week each spring and autumn.

So each clock time is converted **once**, at build time, to the UTC instant it
really referred to, using the offset actually in force on that date *in the
source year*. `times.json` stores minutes after 00:00 UTC of that calendar day.
The app adds those minutes to UTC midnight and renders the instant through
`Europe/Amsterdam`, which re-applies whatever rule the **current** year has.

The physical event stays fixed; only the clock label moves — which is exactly
what happens to sunrise itself. The stored fajr for 28 March (239 minutes after
00:00 UTC) renders as **04:59 in 2026** and **05:59 in 2027**, because by
28 March 2027 the clocks have already gone forward. The same value for 29 March
renders as 05:56 in both years, because that date is summer time in both. That
is the behaviour you want, and it is checked, not assumed:

* every stored value is re-rendered through `Intl.DateTimeFormat` with
  `timeZone: 'Europe/Amsterdam'` and must reproduce the exact clock time it came
  from — all 2190 of them, or the build refuses to write;
* the hand-written EU rule is compared minute by minute against the IANA time
  zone database at all eight switches of the source year and the three after it;
* the days on which the rendered hour legitimately moves in a later year must be
  exactly the days lying between the two years' switch dates — no more, no
  fewer.

29 February is absent in a common year. The app falls back to `02-28`, which is
within a minute of correct.

## Refreshing for a new year

The mosque publishes one year at a time and the feed has no year parameter — it
serves whatever year it currently holds. So this is a once-a-year job, done when
the new calendar appears (usually late December):

```
node data/fetch-elfeth.js 2027     # refuses to write a partial or broken year
node data/build-times.js           # rebuilds ../times.json and verifies it
```

Then bump the cache version in `sw.js`, commit and push.

`fetch-elfeth.js` exits non-zero and writes nothing unless the download parses,
covers **every** calendar day of the year asked for, and has every time field
shaped `HH:MM:SS`. Asking for 2027 before the mosque has published it therefore
fails loudly rather than replacing a good file with a partial one. Mawaqit
failing is only a warning — it is a cross-check, not the ground truth.

Other useful invocations:

```
node data/fetch-elfeth.js 2027 --dry-run   # fetch and validate, write nothing
node data/fetch-elfeth.js --check data/elfeth-2026-raw.json
node data/build-times.js 2026              # build a specific year
```

If a feed ever lands incomplete, a page of the paper calendar can be typed into
`data/print-<year>-<mm>.md` and it will be used in preference to everything
else. The table is parsed generically: any column order, and Dutch, Turkish or
transliterated headers (`Gün/Sabah/Güneş/Öğle/İkindi/Akşam/Yatsı` as readily as
`dag/Fajr/Shurooq/Dhohr/Asr/Maghrib/Isha`). A sheet that disagrees with the feed
by more than 3 minutes, or on more than 5% of its values, aborts the build — at
that point it is not a typo, it is the wrong sheet.

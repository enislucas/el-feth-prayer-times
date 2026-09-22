#!/usr/bin/env node
'use strict';

/**
 * build-times.js — turn the raw mosque feed into ../times.json.
 *
 *   node data/build-times.js            # newest data/elfeth-<year>-raw.json
 *   node data/build-times.js 2026       # a specific year
 *
 * Precedence, highest first:
 *   1. data/print-<year>-<mm>.md   the paper calendar handed out at the mosque
 *   2. data/elfeth-<year>-raw.json the mosque's own website feed
 *   3. data/mawaqit-<year>-raw.json  only to fill a day the feed is missing
 *   4. linear interpolation        only for a gap none of the above covers
 *
 * ---------------------------------------------------------------------------
 * The one thing that must be exactly right: daylight saving.
 *
 * Every source publishes LOCAL Amsterdam clock times. Storing those verbatim
 * would rot: the EU switch dates move every year (last Sunday of March, last
 * Sunday of October), so a table printed for 2026 is an hour wrong for roughly
 * a week each spring and autumn in 2027, 2028, 2029...
 *
 * So each clock time is converted to UTC using the offset REALLY IN FORCE on
 * that date in the SOURCE year, and stored as minutes after 00:00 UTC of that
 * calendar day. The app adds those minutes to UTC midnight and renders the
 * instant through Europe/Amsterdam, which re-applies whatever rule the CURRENT
 * year has. Solar events are fixed in UTC; only their clock label moves.
 *
 * The EU rule is implemented here from first principles rather than taken from
 * Intl, and then checked AGAINST Intl — two independent paths that must agree.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = __dirname;
const OUT_FILE = path.join(DATA_DIR, '..', 'times.json');
const TZ = 'Europe/Amsterdam';

const PLACE = 'Tilburg, Nederland';
const MOSQUE = 'Moscheea El-Feth';

// Output key -> field in the mosque feed. asr_mithl_1 is the standard opinion
// (shadow factor 1), which is the one this app shows; asr_mithl_2 is Hanafi.
const FIELD_MAP = {
  fajr: 'fajr_begins',
  sunrise: 'sunrise',
  dhuhr: 'zuhr_begins',
  asr: 'asr_mithl_1',
  maghrib: 'maghrib_begins',
  isha: 'isha_begins'
};
const KEYS = Object.keys(FIELD_MAP);           // fixed output order
// Mawaqit's calendar rows are positional: [fajr, shuruq, dhuhr, asr, maghrib, isha].
const MAWAQIT_ORDER = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];

// A printed sheet that disagrees by more than this is not a typo, it is the
// wrong sheet (wrong year, wrong mosque, mis-typed column) — refuse to build.
const PRINT_SANE_DIFF_MIN = 3;
const PRINT_SANE_DIFF_RATIO = 0.05;

/* ------------------------------------------------------------- small utils */

function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function daysInMonth(y, m) {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}
const pad2 = n => String(n).padStart(2, '0');

/** "HH:MM" or "HH:MM:SS" -> minutes after local midnight. Seconds are ignored:
 *  every source publishes whole minutes and the trailing :00 is decoration. */
function clockToMinutes(s) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s).trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}
const minutesToClock = n => pad2(Math.floor(n / 60)) + ':' + pad2(n % 60);

function die(msg) {
  console.error('FATAL: ' + msg);
  process.exit(1);
}

/* ------------------------------------------------ EU daylight saving, by rule */

/** Instant (ms) of the last Sunday of `month` at `hourUTC` in `year`. */
function lastSundayUTC(year, month, hourUTC) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();   // day 0 of next month
  const dow = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return Date.UTC(year, month - 1, lastDay - dow, hourUTC, 0, 0, 0);
}

/**
 * The EU rule, written out: CEST (UTC+2) from the last Sunday of March at
 * 01:00 UTC until the last Sunday of October at 01:00 UTC, CET (UTC+1) either
 * side. Both switches happen at the same instant everywhere in the EU, which is
 * why the boundary is expressed in UTC and not in local time.
 */
function dstWindow(year) {
  return { start: lastSundayUTC(year, 3, 1), end: lastSundayUTC(year, 10, 1) };
}
function offsetMinutesByRule(instant, year) {
  const w = dstWindow(year);
  return (instant >= w.start && instant < w.end) ? 120 : 60;
}

/**
 * Local Amsterdam wall-clock time -> { utc, offset }.
 * Solved rather than assumed: try each candidate offset and keep the one that
 * is self-consistent (the offset in force at the instant it produces is the
 * offset we used). +120 is tried first so the ambiguous hour repeated each
 * October resolves to its first, still-summer occurrence.
 */
function wallToUtc(y, m, d, minutes, year) {
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0, 0) + minutes * 60000;
  for (const off of [120, 60]) {
    const cand = naive - off * 60000;
    if (offsetMinutesByRule(cand, year) === off) return { utc: cand, offset: off, gap: false };
  }
  // A local time that never happened (02:00–02:59 on the March Sunday). No
  // prayer in Tilburg falls there, but be loud rather than quietly wrong.
  return { utc: naive - 60 * 60000, offset: 60, gap: true };
}

/* ---------------------------------------- the independent check: via Intl/ICU */

const AMS_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const UTC_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

function partsOf(fmt, instant) {
  const p = Object.create(null);
  for (const part of fmt.formatToParts(new Date(instant))) p[part.type] = part.value;
  return {
    date: p.year + '-' + p.month + '-' + p.day,
    hm: p.hour + ':' + p.minute,
    ms: Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute)
  };
}
/** What the app will actually show: the instant rendered in Europe/Amsterdam. */
const renderAmsterdam = instant => partsOf(AMS_FMT, instant);
/** Amsterdam's UTC offset at an instant, straight from the IANA tz database. */
function offsetMinutesByIntl(instant) {
  return Math.round((partsOf(AMS_FMT, instant).ms - partsOf(UTC_FMT, instant).ms) / 60000);
}

/* --------------------------------------------------------- printed sheets */

// Column headers seen on the mosque's sheets, in Dutch/Turkish/transliteration.
// Deliberately generous: the sheet is typed by hand from a photograph.
const HEADER_ALIASES = {
  day:     ['dag', 'day', 'datum', 'date', 'zi', 'gun', 'gün'],
  fajr:    ['fajr', 'fadjr', 'sabah', 'imsak'],
  sunrise: ['shurooq', 'shuruq', 'shuruk', 'sunrise', 'zonsopgang', 'opkomst', 'gunes', 'güneş'],
  dhuhr:   ['dhohr', 'dhuhr', 'zuhr', 'duhr', 'dohr', 'ogle', 'öğle', 'middag'],
  asr:     ['asr', 'ikindi', 'ikindi', 'namiddag'],
  maghrib: ['maghrib', 'magrib', 'aksam', 'akşam', 'zonsondergang'],
  isha:    ['isha', 'ishaa', 'isya', 'yatsi', 'yatsı', 'avond']
};

const normHeader = s => String(s).toLowerCase().trim()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')       // drop accents: öğle -> ogle
  .replace(/[^a-z]/g, '');

function headerKey(cell) {
  const n = normHeader(cell);
  if (!n) return null;
  for (const key of Object.keys(HEADER_ALIASES)) {
    for (const alias of HEADER_ALIASES[key]) {
      if (n === normHeader(alias)) return key;
    }
  }
  return null;    // e.g. "dag (nl)" — a weekday-name column, of no interest
}

const splitRow = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
const isSeparator = cells => cells.every(c => /^:?-{2,}:?$/.test(c));

/**
 * Parse any data/print-<year>-<mm>.md. The month comes from the filename, the
 * columns from the table header — nothing about September is hardcoded.
 * Returns { year, month, rows: Map<day, {key: minutes}> }.
 */
function parsePrintSheet(file) {
  const name = path.basename(file);
  const m = /^print-(\d{4})-(\d{2})\.md$/.exec(name);
  if (!m) throw new Error(name + ': filename must be print-<year>-<mm>.md');
  const year = Number(m[1]), month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(name + ': month ' + month + ' is not a month');

  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let header = null, colMap = null;
  const rows = new Map();

  for (const line of lines) {
    if (!line.trim().startsWith('|')) {
      if (header && rows.size) break;      // table finished
      continue;
    }
    const cells = splitRow(line);
    if (isSeparator(cells)) continue;
    if (!header) {
      header = cells;
      colMap = cells.map(headerKey);
      const found = colMap.filter(Boolean);
      const missing = ['day'].concat(KEYS).filter(k => found.indexOf(k) === -1);
      if (missing.length) {
        throw new Error(name + ': table header is missing column(s): ' + missing.join(', ') +
                        ' (saw: ' + cells.join(' | ') + ')');
      }
      continue;
    }
    const row = Object.create(null);
    let day = null;
    for (let i = 0; i < cells.length && i < colMap.length; i++) {
      const key = colMap[i];
      if (!key) continue;
      const cell = cells[i];
      if (key === 'day') {
        const n = Number(cell.replace(/[^\d]/g, ''));
        if (!Number.isInteger(n)) throw new Error(name + ': unreadable day "' + cell + '"');
        day = n;
        continue;
      }
      const mins = clockToMinutes(cell);
      if (mins === null) throw new Error(name + ': ' + key + ' "' + cell + '" is not a clock time');
      row[key] = mins;
    }
    if (day === null) throw new Error(name + ': a row has no day number');
    if (day < 1 || day > daysInMonth(year, month)) {
      throw new Error(name + ': day ' + day + ' is outside ' + year + '-' + pad2(month));
    }
    if (rows.has(day)) throw new Error(name + ': day ' + day + ' appears twice');
    if (Object.keys(row).length !== KEYS.length) {
      throw new Error(name + ': day ' + day + ' has ' + Object.keys(row).length + ' of ' + KEYS.length + ' times');
    }
    rows.set(day, row);
  }

  if (!rows.size) throw new Error(name + ': no table rows found');
  return { year, month, rows, name };
}

/* ------------------------------------------------------------------- main */

function main() {
  const argvYear = process.argv.slice(2).find(a => /^\d{4}$/.test(a));

  // ---- 1. the mosque feed ------------------------------------------------
  const rawFiles = fs.readdirSync(DATA_DIR)
    .map(f => ({ f, m: /^elfeth-(\d{4})-raw\.json$/.exec(f) }))
    .filter(x => x.m)
    .map(x => ({ file: path.join(DATA_DIR, x.f), year: Number(x.m[1]) }))
    .sort((a, b) => a.year - b.year);
  if (!rawFiles.length) die('no data/elfeth-<year>-raw.json found. Run: node data/fetch-elfeth.js');

  const chosen = argvYear
    ? rawFiles.find(r => r.year === Number(argvYear))
    : rawFiles[rawFiles.length - 1];
  if (!chosen) die('no raw file for ' + argvYear + ' (have: ' + rawFiles.map(r => r.year).join(', ') + ')');

  const YEAR = chosen.year;
  console.log('El-Feth Moskee Tilburg — building times.json for ' + YEAR);
  console.log('  feed:    ' + path.basename(chosen.file));

  let feed;
  try { feed = JSON.parse(fs.readFileSync(chosen.file, 'utf8')); }
  catch (err) { die(path.basename(chosen.file) + ' is not JSON: ' + err.message); }
  if (Array.isArray(feed) && feed.length === 1 && Array.isArray(feed[0])) feed = feed[0];
  if (!Array.isArray(feed) || !feed.length) die(path.basename(chosen.file) + ' is not a day array');

  /** date key "MM-DD" -> { fajr..isha in local minutes, src } */
  const days = new Map();
  for (const entry of feed) {
    const d = entry && entry.d_date;
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (Number(d.slice(0, 4)) !== YEAR) continue;
    const rec = { src: 'f' };
    let ok = true;
    for (const key of KEYS) {
      const mins = clockToMinutes(entry[FIELD_MAP[key]]);
      if (mins === null) { ok = false; break; }
      rec[key] = mins;
    }
    if (ok) days.set(d.slice(5), rec);
  }
  console.log('  feed has ' + days.size + ' usable day(s) of ' + YEAR);

  // Keep the feed as it arrived. The Mawaqit cross-check below is run twice:
  // once against this pristine copy (does the mosque's site still agree with
  // Mawaqit?) and once against the built result (which carries the printed
  // sheet's overrides, so a difference there is expected, not alarming).
  const feedOnly = new Map();
  for (const [k, v] of days) feedOnly.set(k, Object.assign({}, v));

  // ---- 2. printed sheets win over the feed -------------------------------
  const printFiles = fs.readdirSync(DATA_DIR).filter(f => /^print-\d{4}-\d{2}\.md$/.test(f)).sort();
  const overrides = [];
  let printValuesChecked = 0, printDaysCovered = 0;

  for (const f of printFiles) {
    const sheetYear = Number(f.slice(6, 10));
    if (sheetYear !== YEAR) { console.log('  print:   ' + f + ' — different year, skipped'); continue; }
    let sheet;
    try { sheet = parsePrintSheet(path.join(DATA_DIR, f)); }
    catch (err) { die(err.message); }

    let overridesHere = 0, worstDiff = 0;
    for (const [day, row] of sheet.rows) {
      const key = pad2(sheet.month) + '-' + pad2(day);
      const rec = days.get(key);
      printDaysCovered++;
      if (!rec) {                                   // the sheet covers a day the feed lost
        const fresh = { src: 'p' };
        for (const k of KEYS) fresh[k] = row[k];
        days.set(key, fresh);
        overrides.push(key + ' (whole day, absent from the feed)');
        overridesHere += KEYS.length;
        continue;
      }
      for (const k of KEYS) {
        printValuesChecked++;
        const diff = Math.abs(row[k] - rec[k]);
        if (diff === 0) continue;
        worstDiff = Math.max(worstDiff, diff);
        overrides.push(key + ' ' + k + ': feed ' + minutesToClock(rec[k]) +
                       ' -> print ' + minutesToClock(row[k]));
        rec[k] = row[k];
        rec.src = 'p';
        overridesHere++;
      }
    }
    const ratio = printValuesChecked ? overridesHere / printValuesChecked : 0;
    console.log('  print:   ' + f + ' — ' + sheet.rows.size + ' day(s), ' +
                overridesHere + ' value(s) overridden');
    // Refuse to go on quietly: a real typo on a paper sheet is a minute or two
    // on one line, not a systematic shift.
    if (worstDiff > PRINT_SANE_DIFF_MIN) {
      die(f + ' disagrees with the feed by up to ' + worstDiff + ' minutes. That is not a ' +
          'typo — check the sheet is the right year and the columns are in the right order.');
    }
    if (ratio > PRINT_SANE_DIFF_RATIO) {
      die(f + ' disagrees with the feed on ' + (ratio * 100).toFixed(1) + '% of values ' +
          '(threshold ' + (PRINT_SANE_DIFF_RATIO * 100) + '%). Refusing to build.');
    }
  }
  if (!printFiles.length) console.log('  print:   none on disk');

  // ---- 3. Mawaqit: a witness, and a fallback for gaps ---------------------
  const mawaqitFile = path.join(DATA_DIR, 'mawaqit-' + YEAR + '-raw.json');
  const mawaqitDisagreements = [];
  const mawaqitVsFeed = [];
  let mawaqitChecked = 0, mawaqitFills = 0, mawaqitStatus;

  if (!fs.existsSync(mawaqitFile)) {
    mawaqitStatus = 'not on disk — cross-check skipped';
  } else {
    let conf = null;
    try { conf = JSON.parse(fs.readFileSync(mawaqitFile, 'utf8')); }
    catch (err) { conf = null; mawaqitStatus = 'unreadable (' + err.message + ') — cross-check skipped'; }

    if (conf && Array.isArray(conf.calendar) && conf.calendar.length === 12) {
      const maw = new Map();
      for (let m = 1; m <= 12; m++) {
        const month = conf.calendar[m - 1] || {};
        for (let d = 1; d <= daysInMonth(YEAR, m); d++) {
          const row = month[String(d)];
          if (!Array.isArray(row) || row.length < 6) continue;
          // Mawaqit renders a 366-row template whatever the year, padding the
          // days that do not exist with "00:00". A placeholder is not a time.
          if (row.slice(0, 6).every(v => v === '00:00')) continue;
          const rec = Object.create(null);
          let ok = true;
          MAWAQIT_ORDER.forEach((k, i) => {
            const mins = clockToMinutes(row[i]);
            if (mins === null) ok = false; else rec[k] = mins;
          });
          if (ok) maw.set(pad2(m) + '-' + pad2(d), rec);
        }
      }

      // Fill anything the feed and the sheets both missed, before comparing.
      for (const [key, rec] of maw) {
        if (days.has(key)) continue;
        const fresh = { src: 'm' };
        for (const k of KEYS) fresh[k] = rec[k];
        days.set(key, fresh);
        mawaqitFills++;
      }

      for (const [key, rec] of days) {
        const other = maw.get(key);
        if (!other) continue;
        for (const k of KEYS) {
          mawaqitChecked++;
          if (other[k] !== rec[k]) {
            mawaqitDisagreements.push(key + ' ' + k + ': built ' + minutesToClock(rec[k]) +
                                      ' (' + rec.src + ') vs mawaqit ' + minutesToClock(other[k]));
          }
        }
      }

      // Same comparison against the untouched feed. This is the claim worth
      // re-proving every build: Mawaqit is not a second opinion, it is the same
      // data, so any growth in this number means one of the two has moved.
      for (const [key, rec] of feedOnly) {
        const other = maw.get(key);
        if (!other) continue;
        for (const k of KEYS) {
          if (other[k] !== rec[k]) {
            mawaqitVsFeed.push(key + ' ' + k + ': feed ' + minutesToClock(rec[k]) +
                               ' vs mawaqit ' + minutesToClock(other[k]));
          }
        }
      }

      mawaqitStatus = mawaqitChecked + ' value(s) compared, ' +
                      mawaqitDisagreements.length + ' disagreement(s) with the built result, ' +
                      mawaqitVsFeed.length + ' with the raw feed' +
                      (mawaqitFills ? ', ' + mawaqitFills + ' day(s) filled from it' : '');
    } else if (conf) {
      mawaqitStatus = 'no 12-month calendar — cross-check skipped';
    }
  }
  console.log('  mawaqit: ' + mawaqitStatus);

  // ---- 4. interpolate any remaining gap ----------------------------------
  const allKeys = [];
  for (let m = 1; m <= 12; m++) {
    for (let d = 1; d <= daysInMonth(YEAR, m); d++) allKeys.push(pad2(m) + '-' + pad2(d));
  }
  const missing = allKeys.filter(k => !days.has(k));
  for (const key of missing) {
    const i = allKeys.indexOf(key);
    let before = null, after = null;
    for (let j = i - 1; j >= 0; j--) if (days.has(allKeys[j])) { before = j; break; }
    for (let j = i + 1; j < allKeys.length; j++) if (days.has(allKeys[j])) { after = j; break; }
    if (before === null || after === null) {
      die('no data at all for ' + key + ' and nothing to interpolate between. ' +
          'Re-run node data/fetch-elfeth.js ' + YEAR);
    }
    const a = days.get(allKeys[before]), b = days.get(allKeys[after]);
    const t = (i - before) / (after - before);
    const rec = { src: 'c' };
    // Prayer times move by only a minute or two a day, so a straight line
    // across a one- or two-day hole is accurate to well under a minute.
    for (const k of KEYS) rec[k] = Math.round(a[k] + (b[k] - a[k]) * t);
    days.set(key, rec);
  }
  if (missing.length) {
    console.log('  gaps:    ' + missing.length + ' day(s) interpolated (' + missing.join(', ') + ')');
  }

  // ---- 5. local clock -> minutes after 00:00 UTC --------------------------
  const out = {};
  const localCheck = new Map();     // key -> { field: "HH:MM" } as it went in
  let gapTimes = 0, minStored = Infinity, maxStored = -Infinity;

  for (const key of allKeys) {
    const rec = days.get(key);
    const month = Number(key.slice(0, 2)), day = Number(key.slice(3, 5));
    const row = {};
    const asPrinted = {};
    for (const k of KEYS) {
      const local = rec[k];
      const conv = wallToUtc(YEAR, month, day, local, YEAR);
      if (conv.gap) {
        gapTimes++;
        console.warn('  WARNING: ' + key + ' ' + k + ' ' + minutesToClock(local) +
                     ' is a local time that does not exist (spring-forward gap)');
      }
      const utcMinutes = Math.round((conv.utc - Date.UTC(YEAR, month - 1, day)) / 60000);
      if (utcMinutes < 0 || utcMinutes > 1439) {
        die(key + ' ' + k + ' converts to ' + utcMinutes + ' minutes, which falls outside its ' +
            'own UTC day. The MM-DD key would no longer address it.');
      }
      row[k] = utcMinutes;
      asPrinted[k] = minutesToClock(local);
      minStored = Math.min(minStored, utcMinutes);
      maxStored = Math.max(maxStored, utcMinutes);
    }
    row.src = rec.src;
    out[key] = row;
    localCheck.set(key, asPrinted);
  }

  // ---- 6. verification ----------------------------------------------------
  console.log('');
  console.log('Verification');

  // 6a. Round-trip every stored value through ICU. This is the real proof: it
  // does not reuse the rule above, it asks the tz database what the app will
  // show and compares that with the clock time the sheet/feed actually printed.
  let checked = 0, mismatches = [];
  for (const key of allKeys) {
    const month = Number(key.slice(0, 2)), day = Number(key.slice(3, 5));
    const midnight = Date.UTC(YEAR, month - 1, day);
    for (const k of KEYS) {
      const rendered = renderAmsterdam(midnight + out[key][k] * 60000);
      const wantHm = localCheck.get(key)[k];
      const wantDate = YEAR + '-' + key;
      checked++;
      if (rendered.hm !== wantHm || rendered.date !== wantDate) {
        if (mismatches.length < 20) {
          mismatches.push(key + ' ' + k + ': stored ' + out[key][k] + ' renders as ' +
                          rendered.date + ' ' + rendered.hm + ', source said ' + wantDate + ' ' + wantHm);
        }
      }
    }
  }
  console.log('  round-trip: ' + (checked - mismatches.length) + '/' + checked +
              ' stored values re-render in ' + TZ + ' as the exact clock time they came from');
  if (mismatches.length) {
    for (const m of mismatches) console.error('    - ' + m);
    die(mismatches.length + '+ values do not round-trip. times.json NOT written.');
  }

  // 6b. The hand-written EU rule against the IANA database, minute by minute
  // around each switch, for the source year and the three after it.
  const switchYears = [];
  for (let y = YEAR; y <= YEAR + 3; y++) switchYears.push(y);
  const switchLines = [];
  for (const y of switchYears) {
    const w = dstWindow(y);
    for (const [label, instant, before, after] of [
      ['spring', w.start, 60, 120],
      ['autumn', w.end, 120, 60]
    ]) {
      const obsBefore = offsetMinutesByIntl(instant - 60000);
      const obsAfter = offsetMinutesByIntl(instant + 60000);
      const local = renderAmsterdam(instant);
      if (obsBefore !== before || obsAfter !== after) {
        die('EU rule disagrees with ' + TZ + ' for the ' + label + ' ' + y + ' switch: ' +
            'expected +' + before / 60 + 'h -> +' + after / 60 + 'h, ICU says +' +
            obsBefore / 60 + 'h -> +' + obsAfter / 60 + 'h');
      }
      // And the switch must not be a minute earlier or later than the rule says.
      if (offsetMinutesByIntl(instant - 60 * 60000) !== before ||
          offsetMinutesByIntl(instant + 60 * 60000) !== after) {
        die('EU rule is off by up to an hour for the ' + label + ' ' + y + ' switch');
      }
      switchLines.push('    ' + y + ' ' + label + ': ' + local.date + ' ' + local.hm + ' local ' +
                       '(+' + before / 60 + 'h -> +' + after / 60 + 'h)');
    }
  }
  console.log('  EU rule == ' + TZ + ' at every switch, ' + switchYears[0] + '-' +
              switchYears[switchYears.length - 1] + ':');
  for (const l of switchLines) console.log(l);

  // 6c. What the app will do in later years. A stored UTC value keeps the solar
  // event fixed, so on the days that lie between two years' switch dates the
  // clock label legitimately moves by exactly one hour — and nowhere else.
  for (const y of switchYears.slice(1)) {
    const shifted = [];
    let bad = 0;
    for (const key of allKeys) {
      if (key === '02-29') continue;                       // not in a non-leap target year
      const month = Number(key.slice(0, 2)), day = Number(key.slice(3, 5));
      const srcRender = renderAmsterdam(Date.UTC(YEAR, month - 1, day) + out[key].fajr * 60000);
      const tgtRender = renderAmsterdam(Date.UTC(y, month - 1, day) + out[key].fajr * 60000);
      const diff = clockToMinutes(tgtRender.hm) - clockToMinutes(srcRender.hm);
      if (tgtRender.date !== y + '-' + key) { bad++; continue; }   // must stay on its own day
      if (diff === 0) continue;
      if (Math.abs(diff) !== 60) { bad++; continue; }
      shifted.push(key);
    }
    if (bad) die(bad + ' day(s) render wrongly in ' + y + ' (not 0 or +/-60 minutes, or landed on another date)');
    const srcW = dstWindow(YEAR), tgtW = dstWindow(y);
    const expected = expectedShiftedDays(YEAR, y, srcW, tgtW);
    const same = shifted.length === expected.length && shifted.every((k, i) => k === expected[i]);
    if (!same) {
      die('in ' + y + ' the hour moves on ' + JSON.stringify(shifted) +
          ' but the two years\' switch dates predict ' + JSON.stringify(expected));
    }
    console.log('  ' + y + ': ' + shifted.length + ' day(s) shift by exactly one hour' +
                (shifted.length ? ' (' + shifted[0] + '..' + shifted[shifted.length - 1] + ')' : '') +
                ' — exactly the days between the ' + YEAR + ' and ' + y + ' switch dates');
  }

  // ---- 7. write -----------------------------------------------------------
  const generated = renderAmsterdam(Date.now()).date;
  const srcCount = { f: 0, p: 0, m: 0, c: 0 };
  for (const key of allKeys) srcCount[out[key].src]++;

  const header = {
    place: PLACE,
    mosque: MOSQUE,
    timeZone: TZ,
    sourceYear: YEAR,
    generated,
    note: 'minutes after 00:00 UTC on the given calendar day; the app adds them to UTC ' +
          'midnight and renders the instant in ' + TZ + ', so the clock times stay correct ' +
          'in any year whatever date daylight saving moves to. src: f = mosque feed ' +
          '(el-feth.nl), p = printed mosque calendar (wins over the feed), m = mawaqit, ' +
          'c = interpolated. Generated by data/build-times.js — do not edit by hand.'
  };

  // One line per day: a 30 kB file a phone re-downloads is worth keeping tidy,
  // and a one-line-per-day diff is readable when the year is refreshed.
  const lines = [];
  for (const [k, v] of Object.entries(header)) lines.push('  ' + JSON.stringify(k) + ': ' + JSON.stringify(v) + ',');
  lines.push('  "days": {');
  allKeys.forEach((key, i) => {
    const row = out[key];
    const body = KEYS.map(k => '"' + k + '":' + row[k]).join(',') + ',"src":"' + row.src + '"';
    lines.push('    ' + JSON.stringify(key) + ': {' + body + '}' + (i === allKeys.length - 1 ? '' : ','));
  });
  lines.push('  }');
  const json = '{\n' + lines.join('\n') + '\n}\n';

  JSON.parse(json);                         // never ship something we cannot read back
  fs.writeFileSync(OUT_FILE, json);

  // ---- 8. summary ---------------------------------------------------------
  console.log('');
  console.log('Summary');
  console.log('  days written:      ' + allKeys.length + ' (' + (allKeys.length * KEYS.length) + ' values)');
  console.log('  src breakdown:     f=' + srcCount.f + ' (mosque feed), p=' + srcCount.p +
              ' (printed sheet), m=' + srcCount.m + ' (mawaqit), c=' + srcCount.c + ' (interpolated)');
  console.log('  print overrides:   ' + overrides.length +
              (printDaysCovered ? ' (' + printDaysCovered + ' printed day(s) checked)' : ''));
  for (const o of overrides) console.log('      ' + o);
  console.log('  mawaqit:           ' + mawaqitStatus);
  for (const d of mawaqitDisagreements) console.log('      vs built: ' + d);
  for (const d of mawaqitVsFeed) console.log('      vs feed:  ' + d);
  if (gapTimes) console.log('  DST-gap times:     ' + gapTimes);
  console.log('  stored range:      ' + minStored + '..' + maxStored + ' minutes after 00:00 UTC');
  console.log('  wrote ' + path.resolve(OUT_FILE) + ' (' + fs.statSync(OUT_FILE).size + ' bytes)');
}

/**
 * The days on which a UTC-stored time renders an hour differently in `tgtYear`
 * than in `srcYear`: the symmetric difference between the two years' summer
 * windows, expressed as MM-DD keys.
 */
function expectedShiftedDays(srcYear, tgtYear, srcW, tgtW) {
  const keys = [];
  for (let m = 1; m <= 12; m++) {
    for (let d = 1; d <= daysInMonth(srcYear, m); d++) {
      if (m === 2 && d === 29) continue;
      // Compare noon, safely clear of both switch instants.
      const srcNoon = Date.UTC(srcYear, m - 1, d, 12);
      const tgtNoon = Date.UTC(tgtYear, m - 1, d, 12);
      const srcOff = (srcNoon >= srcW.start && srcNoon < srcW.end) ? 120 : 60;
      const tgtOff = (tgtNoon >= tgtW.start && tgtNoon < tgtW.end) ? 120 : 60;
      if (srcOff !== tgtOff) keys.push(pad2(m) + '-' + pad2(d));
    }
  }
  return keys;
}

main();

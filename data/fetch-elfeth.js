#!/usr/bin/env node
'use strict';

/**
 * fetch-elfeth.js — download one whole year of adhan times for El-Feth Moskee
 * (Stedekestraat 27, Tilburg) and, as an independent witness, the Mawaqit copy.
 *
 *   node data/fetch-elfeth.js                    # current year in Amsterdam
 *   node data/fetch-elfeth.js 2027               # a specific year
 *   node data/fetch-elfeth.js 2027 --dry-run     # fetch + validate, write nothing
 *   node data/fetch-elfeth.js --check data/elfeth-2026-raw.json
 *
 * Why the paranoia: data/elfeth-<year>-raw.json is the ground truth this app is
 * built from, and the mosque's WordPress endpoint has no year parameter — it
 * serves whatever year it currently holds. A half-published year, a WAF
 * challenge page, or simply asking for 2027 in December 2026 would all return
 * something JSON.parse() is perfectly happy with. So nothing is written until
 * the payload has been proven to cover every single calendar day of the year
 * that was asked for, with every time field shaped HH:MM:SS. A good file on
 * disk is never replaced by a worse one.
 *
 * Mawaqit is only a cross-check. If it fails we warn and carry on: the mosque's
 * own site is the ground truth, and build-times.js treats a missing Mawaqit
 * copy as "cross-check skipped", not as an error.
 *
 * Exit code is 1 on any fatal problem, so a CI job notices.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = __dirname;
const FEED_URL = 'https://www.el-feth.nl/wp-json/dpt/v1/prayertime?filter=year';
const MAWAQIT_URL = 'https://mawaqit.net/en/el-feth-tilburg-1';

// The six values the app actually uses. The *_jamah (congregation) fields are
// deliberately ignored everywhere: they differ from the adhan by a minute or two.
const REQUIRED_FIELDS = [
  'fajr_begins', 'sunrise', 'zuhr_begins', 'asr_mithl_1', 'maghrib_begins', 'isha_begins'
];

const HTTP_TIMEOUT_MS = 30000;
const HTTP_ATTEMPTS = 3;
// A browser-ish UA: bare undici gets challenged by some WordPress hosts.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0 Safari/537.36 elfeth-prayer-times/1.0';

/* ------------------------------------------------------------------ dates */

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m /* 1-12 */) {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

function allDatesOfYear(y) {
  const out = [];
  for (let m = 1; m <= 12; m++) {
    for (let d = 1; d <= daysInMonth(y, m); d++) {
      out.push(y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'));
    }
  }
  return out;
}

function currentYearInAmsterdam() {
  // Not the machine's local year: this project is anchored to the mosque's
  // clock, and it may well be run from another continent.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam', year: 'numeric'
  }).formatToParts(new Date());
  return Number(parts.find(p => p.type === 'year').value);
}

/* --------------------------------------------------------------- network */

async function httpText(url, label) {
  let lastErr;
  for (let attempt = 1; attempt <= HTTP_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: {
          'user-agent': UA,
          'accept': 'application/json,text/html;q=0.9,*/*;q=0.8',
          'accept-language': 'nl,en;q=0.8'
        },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
      const text = await res.text();
      if (!text.trim()) throw new Error('empty response body');
      return text;
    } catch (err) {
      lastErr = err;
      if (attempt < HTTP_ATTEMPTS) {
        console.warn('  ' + label + ': attempt ' + attempt + ' failed (' + err.message + '), retrying...');
      }
    }
  }
  throw new Error(label + ': ' + (lastErr && lastErr.message));
}

/* -------------------------------------------------------------- validate */

const HHMMSS = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The single gate every payload has to pass. Returns
 * { ok, problems[], days[], covered }. The problem list is capped so a wholly
 * broken payload does not print 2000 lines, but `ok` reflects every check.
 */
function validateFeed(text, year) {
  const problems = [];
  const note = msg => { if (problems.length < 25) problems.push(msg); };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, problems: ['payload is not JSON: ' + err.message], days: [], covered: 0 };
  }

  // The plugin answers [[ {day}, {day}, ... ]] — one array wrapping one array.
  let days = parsed;
  if (Array.isArray(days) && days.length === 1 && Array.isArray(days[0])) days = days[0];
  if (!Array.isArray(days) || days.length === 0 || typeof days[0] !== 'object' || days[0] === null) {
    return { ok: false, problems: ['payload is not the expected [[{...}]] day array'], days: [], covered: 0 };
  }

  const seen = new Map();
  let badCount = 0;

  for (const day of days) {
    const date = day && day.d_date;
    if (typeof date !== 'string' || !ISO_DATE.test(date)) {
      badCount++; note('day entry with unusable d_date: ' + JSON.stringify(date));
      continue;
    }
    if (seen.has(date)) { badCount++; note('duplicate day ' + date); continue; }
    seen.set(date, day);

    for (const field of REQUIRED_FIELDS) {
      const v = day[field];
      if (typeof v !== 'string' || !HHMMSS.test(v)) {
        badCount++; note(date + ': ' + field + ' is ' + JSON.stringify(v) + ', expected HH:MM:SS');
      }
    }
    // Anything else that claims to be a time must look like one too. A
    // half-rendered row usually shows up here first.
    for (const key of Object.keys(day)) {
      if (REQUIRED_FIELDS.indexOf(key) !== -1) continue;
      if (!/_begins$|_jamah$|^asr_mithl_/.test(key)) continue;
      const v = day[key];
      if (typeof v !== 'string' || !HHMMSS.test(v)) {
        badCount++; note(date + ': ' + key + ' is ' + JSON.stringify(v) + ', expected HH:MM:SS');
      }
    }
  }

  const wanted = allDatesOfYear(year);
  const missing = wanted.filter(d => !seen.has(d));
  const extra = Array.from(seen.keys()).filter(d => Number(d.slice(0, 4)) !== year);

  if (missing.length) {
    note(missing.length + ' of ' + wanted.length + ' days of ' + year + ' are missing ' +
         '(first: ' + missing[0] + ', last: ' + missing[missing.length - 1] + ')');
  }
  if (extra.length) {
    const years = Array.from(new Set(extra.map(d => d.slice(0, 4)))).sort().join(', ');
    note(extra.length + ' day(s) belong to another year (' + years + ') — the feed has no ' +
         'year parameter, it serves whatever year it currently holds');
  }

  const ok = badCount === 0 && missing.length === 0 && extra.length === 0;
  return { ok, problems, days: Array.from(seen.values()), covered: seen.size };
}

/* --------------------------------------------------------------- mawaqit */

/**
 * Pull the `confData = { ... }` object out of the Mawaqit page by matching
 * braces. A regex cannot do this: the object is deeply nested and contains
 * braces inside strings (mosque name, announcements, hadith text).
 */
function extractConfData(html) {
  const marker = /confData\s*=\s*/g;
  let m;
  while ((m = marker.exec(html)) !== null) {
    const start = html.indexOf('{', m.index + m[0].length - 1);
    if (start === -1) continue;
    let depth = 0, inStr = false, quote = '', escaped = false;
    for (let i = start; i < html.length; i++) {
      const c = html[i];
      if (inStr) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === quote) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return html.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * null when the calendar really is the requested year; a reason string if not.
 *
 * Mawaqit renders a 366-row template whatever the year, so in a common year
 * February carries a 29th row of "00:00" placeholders. That is normal and must
 * not be mistaken for a wrong-year page — but a placeholder row on a day that
 * DOES exist means the page is genuinely unusable.
 */
function validateMawaqit(conf, year) {
  if (!conf || !Array.isArray(conf.calendar) || conf.calendar.length !== 12) {
    return 'confData has no 12-month calendar';
  }
  for (let m = 1; m <= 12; m++) {
    const month = conf.calendar[m - 1];
    if (!month || typeof month !== 'object') return 'calendar month ' + m + ' is missing';
    const want = daysInMonth(year, m);
    const got = Object.keys(month).length;
    const padAllowed = (m === 2 && !isLeap(year)) ? 1 : 0;
    if (got < want || got > want + padAllowed) {
      return 'calendar month ' + m + ' has ' + got + ' days, ' + year + ' needs ' + want +
             ' (the page always serves the current year — it may not be ' + year + ')';
    }
    for (let d = 1; d <= want; d++) {
      const row = month[String(d)];
      if (!Array.isArray(row) || row.length < 6) return 'calendar ' + m + '/' + d + ' is not a 6-value row';
      for (const v of row) {
        if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) {
          return 'calendar ' + m + '/' + d + ' contains ' + JSON.stringify(v) + ', expected HH:MM';
        }
      }
      if (row.slice(0, 6).every(v => v === '00:00')) {
        return 'calendar ' + m + '/' + d + ' is an empty placeholder row (all 00:00)';
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ main */

function usage() {
  console.log('usage: node data/fetch-elfeth.js [year] [--dry-run] [--skip-mawaqit]');
  console.log('       node data/fetch-elfeth.js --check <file.json> [year]');
}

async function main() {
  const argv = process.argv.slice(2);
  let year = null, checkFile = null, dryRun = false, skipMawaqit = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--skip-mawaqit') skipMawaqit = true;
    else if (a === '--check') checkFile = argv[++i];
    else if (a === '-h' || a === '--help') { usage(); return 0; }
    else if (/^\d{4}$/.test(a)) year = Number(a);
    else { console.error('unrecognised argument: ' + a); usage(); return 1; }
  }

  // --check validates a file already on disk against the same gate the download
  // must pass, so the refusal path can be exercised without the network.
  if (checkFile) {
    const fromName = (path.basename(checkFile).match(/(\d{4})/) || [])[1];
    const guessed = year || Number(fromName);
    if (!guessed) { console.error('--check needs a year (in the filename or as an argument)'); return 1; }
    let text;
    try { text = fs.readFileSync(checkFile, 'utf8'); }
    catch (err) { console.error('cannot read ' + checkFile + ': ' + err.message); return 1; }
    const v = validateFeed(text, guessed);
    console.log('checking ' + checkFile + ' as year ' + guessed);
    if (v.ok) {
      console.log('  OK — ' + v.covered + ' days, every required time field present and well formed');
      return 0;
    }
    console.error('  REJECTED — ' + v.problems.length + ' problem(s):');
    for (const p of v.problems) console.error('    - ' + p);
    return 1;
  }

  if (!year) year = currentYearInAmsterdam();
  const feedPath = path.join(DATA_DIR, 'elfeth-' + year + '-raw.json');
  const mawaqitPath = path.join(DATA_DIR, 'mawaqit-' + year + '-raw.json');

  console.log('El-Feth Moskee Tilburg — fetching ' + year);
  console.log('  feed: ' + FEED_URL);

  let text;
  try {
    text = await httpText(FEED_URL, 'mosque feed');
  } catch (err) {
    console.error('FATAL: could not download the mosque feed — ' + err.message);
    if (fs.existsSync(feedPath)) console.error('       ' + path.basename(feedPath) + ' left untouched.');
    return 1;
  }
  console.log('  downloaded ' + text.length + ' bytes');

  const v = validateFeed(text, year);
  if (!v.ok) {
    console.error('FATAL: the download is not a complete, well formed ' + year + ':');
    for (const p of v.problems) console.error('    - ' + p);
    if (fs.existsSync(feedPath)) {
      console.error('       Refusing to overwrite ' + path.basename(feedPath) + ' with it.');
    }
    return 1;
  }
  console.log('  validated: all ' + v.covered + ' days of ' + year + ', every required field HH:MM:SS');

  // Say what would change before changing it. A silent rewrite of the ground
  // truth is exactly the thing you want to spot in a CI log a year from now.
  if (fs.existsSync(feedPath)) {
    const old = fs.readFileSync(feedPath, 'utf8');
    if (old === text) {
      console.log('  identical to what is already on disk');
    } else {
      let changed = -1;
      const oldV = validateFeed(old, year);
      if (oldV.days.length) {
        const oldDays = new Map(oldV.days.map(d => [d.d_date, d]));
        changed = 0;
        for (const d of v.days) {
          const prev = oldDays.get(d.d_date);
          if (!prev || REQUIRED_FIELDS.some(f => prev[f] !== d[f])) changed++;
        }
      }
      console.log('  differs from the file on disk (' + (changed < 0 ? 'unknown' : changed) + ' day(s) changed)');
    }
  }

  if (dryRun) {
    console.log('  --dry-run: nothing written');
  } else {
    fs.writeFileSync(feedPath, text);          // verbatim, exactly as served
    console.log('  wrote ' + feedPath);
  }

  // ---- Mawaqit: a warning if it fails, never fatal ------------------------
  if (skipMawaqit) {
    console.log('  --skip-mawaqit: cross-check source not fetched');
  } else {
    try {
      console.log('  cross-check: ' + MAWAQIT_URL);
      const html = await httpText(MAWAQIT_URL, 'mawaqit');
      const raw = extractConfData(html);
      if (!raw) throw new Error('no `confData = {...}` found in the page');
      let conf;
      try { conf = JSON.parse(raw); }
      catch (err) { throw new Error('confData is not parseable JSON: ' + err.message); }
      const bad = validateMawaqit(conf, year);
      if (bad) throw new Error(bad);
      if (dryRun) {
        console.log('  --dry-run: mawaqit validated, nothing written');
      } else {
        fs.writeFileSync(mawaqitPath, JSON.stringify(conf, null, 1));
        console.log('  wrote ' + mawaqitPath);
      }
    } catch (err) {
      console.warn('  WARNING: Mawaqit cross-check unavailable — ' + err.message);
      console.warn('           Not fatal: the mosque\'s own feed is the ground truth.');
      if (fs.existsSync(mawaqitPath)) {
        console.warn('           Keeping the existing ' + path.basename(mawaqitPath) + '.');
      }
    }
  }

  console.log('Done. Next: node data/build-times.js');
  return 0;
}

main().then(code => { process.exitCode = code; })
      .catch(err => { console.error('FATAL:', (err && err.stack) || err); process.exitCode = 1; });

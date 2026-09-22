/*
 * Re-embeds times.json into index.html.
 *
 *   node tools/embed-seed.js
 *
 * index.html carries a compiled-in copy of the schedule in
 * <script type="application/json" id="seed">. The app reads it only as a last
 * resort (see loadSeed() in index.html): a first launch with no network, or a
 * phone whose Cache Storage iOS has evicted for being idle. Both are cases
 * where times.json is unreachable but the page itself is on screen, and they
 * are the difference between the app showing the times and showing an apology.
 *
 * Because it is a copy, it goes stale the moment times.json is rebuilt. That is
 * why the refresh workflow runs this script immediately after build-times.js
 * and commits index.html alongside it. Run it by hand after any manual rebuild.
 *
 * The app compares the two copies by their "generated" date and uses whichever
 * is newer, so a stale seed is never actually harmful - but a seed a year out
 * of date would be served to a phone with no network, and the point of the seed
 * is precisely that phone.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'index.html');
const TIMES = path.join(ROOT, 'times.json');

const OPEN = '<script type="application/json" id="seed">';
const CLOSE = '</scr' + 'ipt>';

function main() {
  const times = JSON.parse(fs.readFileSync(TIMES, 'utf8'));

  // Refuse to embed something that is not a schedule. This runs unattended in
  // CI, and a half-written file baked into the page would be invisible until
  // the one day someone opened the app with no signal.
  const dayCount = Object.keys(times.days || {}).length;
  if (dayCount < 365) {
    throw new Error(`times.json has only ${dayCount} days; refusing to embed it`);
  }

  const seed = JSON.stringify(times);
  // A "</script>" anywhere inside would close the tag early and the rest of the
  // schedule would be parsed as markup. It cannot happen with numeric data, but
  // this costs nothing and the failure would be baffling.
  if (/<\/script/i.test(seed)) {
    throw new Error('schedule contains a closing script tag');
  }

  const page = fs.readFileSync(PAGE, 'utf8');
  const start = page.indexOf(OPEN);
  if (start === -1) throw new Error('no seed element in index.html');
  const from = start + OPEN.length;
  const to = page.indexOf(CLOSE, from);
  if (to === -1) throw new Error('seed element is not closed');

  const updated = page.slice(0, from) + seed + page.slice(to);
  if (updated === page) {
    console.log('seed already current (' + dayCount + ' days, generated ' + times.generated + ')');
    return;
  }
  fs.writeFileSync(PAGE, updated);
  console.log('seed embedded: ' + dayCount + ' days, generated ' + times.generated +
              ', ' + seed.length + ' bytes');
}

main();

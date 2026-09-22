#!/usr/bin/env node
'use strict';
/*
 * make-icons.js - regenerates every app icon from code.
 *
 *   node tools/make-icons.js            write + verify
 *   node tools/make-icons.js --verify   verify the files already on disk
 *
 * Why hand-rolled: this repo has no dependencies and no build step, and it must
 * stay that way. Everything below uses only the Node standard library: draw into
 * a raw RGB(A) buffer, deflate it with zlib, wrap it in the four PNG chunks by
 * hand.
 *
 * The mark: a two-centred mihrab arch drawn as a warm gold outline, standing on
 * a plinth, with a pale-sand crescent inside the niche - night sky behind it all.
 * No text: lettering is unreadable at 40px and looks amateur next to Apple's own
 * icons.
 *
 * Rejected on the way here, so nobody "improves" it back: a SOLID gold arch.
 * A filled, flat-bottomed arch silhouette reads as a headstone, and a slab of
 * gold that size is loud rather than restrained. Outlining the arch and letting
 * the crescent carry the recognition keeps the gold sparse - which is what makes
 * it sit calmly next to Apple's icons - and the plinth, wider than the arch,
 * grounds the shape as architecture instead of a marker.
 *
 * Two constraints that are easy to break and expensive to notice later:
 *  1. apple-touch-icon.png must be FULLY OPAQUE. iOS composites it on black, so
 *     any transparency shows up as black blotches. It is written as PNG colour
 *     type 2 (truecolour, no alpha channel at all) so it cannot regress.
 *  2. Corners are NOT pre-rounded. iOS applies its own superellipse mask; a
 *     pre-rounded icon ends up with a dark halo inside Apple's rounding.
 *  Also: icon-512 doubles as the maskable icon, so the whole mark stays inside
 *  the middle 80% safe area - Android may crop everything outside it.
 */

const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const OUT_DIR = path.resolve(__dirname, '..');

/* ------------------------------------------------------------------ *
 * The drawing, expressed once in a 512x512 reference space and then
 * sampled at whatever size is asked for. Nothing here knows about px.
 * ------------------------------------------------------------------ */

const REF = 512;
const SAFE = 0.80;                       // maskable safe area, middle 80%

// Two-centred ("drop") arch, described by its CENTRELINE; the visible outline is
// everything within STROKE/2 of that line. The two arcs spring from one line and
// are struck from centres pulled k inwards, which gives a gentle point rather
// than the harsh equilateral one - closer to a real mihrab than to a clip-art
// dome. Stroke weight is chosen so the outline is still ~2 device px wide at a
// 40px home-screen size; anything finer dissolves.
const STROKE = 26;
const HALF = STROKE / 2;

const ARCH = (function () {
  const cx = 256;
  const W = 210;                         // opening width, centreline to centreline
  const k = W / 4;                       // how far the arc centres move inwards
  const R = W / 2 + k;                   // radius that still passes the springing
  const spring = 272;                    // springline
  const jambBase = 382;                  // where the jambs die into the plinth
  const h = Math.sqrt(R * R - k * k);
  return { cx: cx, W: W, k: k, R: R, spring: spring, jambBase: jambBase,
           apex: spring - h, thApex: Math.atan2(h, k),
           x0: cx - W / 2, x1: cx + W / 2, top: spring - h - HALF };
})();

// The plinth is deliberately wider than the arch: it reads as ground, and it is
// what stops the whole thing looking like a headstone.
const PLINTH = { x0: 124, x1: 388, cy: 389, h: 18 };

// Crescent = disc minus a slightly smaller disc pushed up and to the right, so
// the horns point up-right the way they do on every flag he grew up with.
// Nudged right of the arch's axis on purpose: the bite is taken out of the
// upper right, so the crescent's mass sits left of its own disc centre and a
// geometrically centred moon looks shoved into the left jamb.
const MOON = { x: 266, y: 252, R: 62, ox: 25, oy: -15, r: 54 };

// Distance from a point to the arch centreline. Mirrored into the right half so
// only one arc and one jamb need solving.
function distArch(x, y) {
  const mx = x < ARCH.cx ? 2 * ARCH.cx - x : x;
  const ax = ARCH.cx - ARCH.k, ay = ARCH.spring;   // centre of the right-hand arc
  const dx = mx - ax, dy = y - ay;
  const d = Math.sqrt(dx * dx + dy * dy);
  const th = Math.atan2(dy, dx);                   // 0 at the springing, -thApex at the apex
  let best;
  if (th <= 0 && th >= -ARCH.thApex && d > 1e-9) {
    best = Math.abs(d - ARCH.R);                   // foot of the perpendicular is on the arc
  } else {                                         // otherwise the nearer arc end wins
    const e1x = mx - ARCH.x1, e1y = y - ARCH.spring;
    const e2x = mx - ARCH.cx, e2y = y - ARCH.apex;
    best = Math.min(Math.sqrt(e1x * e1x + e1y * e1y), Math.sqrt(e2x * e2x + e2y * e2y));
  }
  const jy = y < ARCH.spring ? ARCH.spring : (y > ARCH.jambBase ? ARCH.jambBase : y);
  const jx = mx - ARCH.x1, jdy = y - jy;
  return Math.min(best, Math.sqrt(jx * jx + jdy * jdy));
}

// The area the centreline encloses - used for the recessed niche behind the moon.
function inNiche(x, y) {
  if (y >= ARCH.spring) return y <= ARCH.jambBase && x >= ARCH.x0 && x <= ARCH.x1;
  const a = x - (ARCH.cx - ARCH.k), b = x - (ARCH.cx + ARCH.k), dy = y - ARCH.spring;
  const rr = ARCH.R * ARCH.R;
  return (a * a + dy * dy) <= rr && (b * b + dy * dy) <= rr;
}

function inPlinth(x, y) {
  const r = PLINTH.h / 2;
  const a = PLINTH.x0 + r, b = PLINTH.x1 - r;
  const px = x < a ? a : (x > b ? b : x);
  const dx = x - px, dy = y - PLINTH.cy;
  return (dx * dx + dy * dy) <= r * r;
}

function inMoon(x, y) {
  const dx = x - MOON.x, dy = y - MOON.y;
  if (dx * dx + dy * dy > MOON.R * MOON.R) return false;
  const ex = x - (MOON.x + MOON.ox), ey = y - (MOON.y + MOON.oy);
  return (ex * ex + ey * ey) > MOON.r * MOON.r;
}

// Anything that is not sky. The maskable-safe-area check walks this.
function inMark(x, y) {
  return inMoon(x, y) || inPlinth(x, y) || distArch(x, y) <= HALF;
}

// The moon is positioned by eye, so this guards the one thing eyeballing gets
// wrong: a horn touching the stonework. Any future nudge that closes the gap
// fails the build instead of shipping a smudge.
const MOON_CLEARANCE = 12;
function checkGeometry() {
  let worst = Infinity, at = null;
  for (let y = MOON.y - MOON.R - 1; y <= MOON.y + MOON.R + 1; y += 0.25) {
    for (let x = MOON.x - MOON.R - 1; x <= MOON.x + MOON.R + 1; x += 0.25) {
      if (!inMoon(x, y)) continue;
      const gap = distArch(x, y) - HALF;
      if (gap < worst) { worst = gap; at = [x.toFixed(1), y.toFixed(1)]; }
    }
  }
  if (worst < MOON_CLEARANCE) {
    throw new Error('moon comes within ' + worst.toFixed(1) + 'px of the arch at ' +
                    at + ' (want >= ' + MOON_CLEARANCE + ')');
  }
  console.log('  geometry: moon clears the arch by ' + worst.toFixed(1) + 'px');
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function mix(a, b, t) { return a + (b - a) * t; }

// Night sky: a cool ink gradient, one warm bloom sitting behind the niche, and
// a restrained vignette so the square never looks flat when it is large.
function sky(x, y, out) {
  const t = clamp01(y / REF);
  let r = mix(26, 11, t), g = mix(33, 15, t), b = mix(69, 34, t);

  const dx = x - 256, dy = y - 250;
  const u = clamp01(Math.sqrt(dx * dx + dy * dy) / 340);
  const bloom = 0.16 * Math.pow(1 - u, 2.2);
  r += (226 - r) * bloom; g += (176 - g) * bloom; b += (104 - b) * bloom;

  const vx = (x - 256) / 256, vy = (y - 256) / 256;
  const vd = clamp01((Math.sqrt(vx * vx + vy * vy) - 0.62) / 0.65);
  const dim = 1 - 0.24 * vd * vd;

  out[0] = r * dim; out[1] = g * dim; out[2] = b * dim;
}

// The stonework: warm gold, paler at the apex where the light falls, deeper at
// the floor. Kept a step below the moon in brightness so the moon stays the
// thing the eye lands on.
function gold(x, y, out) {
  const t = clamp01((y - ARCH.top) / (PLINTH.cy + PLINTH.h / 2 - ARCH.top));
  out[0] = mix(230, 172, t);
  out[1] = mix(203, 133, t);
  out[2] = mix(152, 77, t);
}

// The moon: the brightest thing in the icon, and the only pure highlight.
function sand(x, y, out) {
  const t = clamp01((y - (MOON.y - MOON.R)) / (2 * MOON.R));
  out[0] = mix(250, 228, t);
  out[1] = mix(240, 206, t);
  out[2] = mix(216, 163, t);
}

// Inside the arch the sky is lifted a little, so the opening reads as a lit
// recess rather than as a hole. Multiplicative, so the gradient and the warm
// bloom underneath both survive.
function niche(x, y, out) {
  sky(x, y, out);
  out[0] = out[0] * 1.16 + 13;
  out[1] = out[1] * 1.16 + 15;
  out[2] = out[2] * 1.16 + 25;
}

const _c = [0, 0, 0];
function shadeAt(x, y, out) {
  if (inMoon(x, y)) sand(x, y, _c);
  else if (distArch(x, y) <= HALF || inPlinth(x, y)) gold(x, y, _c);
  else if (inNiche(x, y)) niche(x, y, _c);
  else sky(x, y, _c);
  out[0] = _c[0]; out[1] = _c[1]; out[2] = _c[2];
}

/* ------------------------------------------------------------------ *
 * Rasteriser. Supersampled, averaged in linear light - averaging sRGB
 * values directly muddies every edge against a dark background, which
 * is exactly the situation here.
 * ------------------------------------------------------------------ */

const LIN = new Float64Array(4096);
for (let i = 0; i < 4096; i++) {
  const v = i / 4095;
  LIN[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function toLin(v) { return LIN[Math.round(clamp01(v / 255) * 4095)]; }
function toSrgb(v) {
  v = clamp01(v);
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(s * 255)));
}

function render(size, ss) {
  const px = new Uint8Array(size * size * 3);
  const scale = REF / size;
  const n = ss * ss;
  const c = [0, 0, 0];
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let ar = 0, ag = 0, ab = 0;
      for (let sy = 0; sy < ss; sy++) {
        const y = (py + (sy + 0.5) / ss) * scale;
        for (let sx = 0; sx < ss; sx++) {
          const x = (pxi + (sx + 0.5) / ss) * scale;
          shadeAt(x, y, c);
          ar += toLin(c[0]); ag += toLin(c[1]); ab += toLin(c[2]);
        }
      }
      const o = (py * size + pxi) * 3;
      px[o] = toSrgb(ar / n); px[o + 1] = toSrgb(ag / n); px[o + 2] = toSrgb(ab / n);
    }
  }
  return px;
}

/* ------------------------------------------------------------------ *
 * PNG writer (colour type 2 = RGB, colour type 6 = RGBA).
 * ------------------------------------------------------------------ */

const CRC = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// Per-scanline adaptive filtering, the usual minimum-sum-of-absolute-values
// heuristic. Costs nothing and roughly halves the file.
function filterRows(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc((stride + 1) * height);
  const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride),
                Buffer.alloc(stride), Buffer.alloc(stride)];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = raw.subarray(y * stride, (y + 1) * stride);
    const score = [0, 0, 0, 0, 0];
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      cand[0][i] = row[i];
      cand[1][i] = (row[i] - a) & 0xff;
      cand[2][i] = (row[i] - b) & 0xff;
      cand[3][i] = (row[i] - ((a + b) >> 1)) & 0xff;
      cand[4][i] = (row[i] - pred) & 0xff;
      for (let f = 0; f < 5; f++) {
        const v = cand[f][i];
        score[f] += v < 128 ? v : 256 - v;
      }
    }
    let best = 0;
    for (let f = 1; f < 5; f++) if (score[f] < score[best]) best = f;
    out[y * (stride + 1)] = best;
    cand[best].copy(out, y * (stride + 1) + 1);
    prev = row;
  }
  return out;
}

function encodePng(rgb, size, withAlpha) {
  const bpp = withAlpha ? 4 : 3;
  let raw;
  if (withAlpha) {
    raw = Buffer.alloc(size * size * 4);
    for (let i = 0, j = 0; i < size * size; i++, j += 4) {
      raw[j] = rgb[i * 3]; raw[j + 1] = rgb[i * 3 + 1];
      raw[j + 2] = rgb[i * 3 + 2]; raw[j + 3] = 255;
    }
  } else {
    raw = Buffer.from(rgb.buffer, rgb.byteOffset, rgb.length);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;                       // bit depth
  ihdr[9] = withAlpha ? 6 : 2;       // colour type
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(filterRows(raw, size, size, bpp), { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------------ *
 * Verification - decode what we actually wrote, not what we meant to.
 * ------------------------------------------------------------------ */

function decodePng(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) throw new Error('bad PNG signature');
  }
  let off = 8, w = 0, h = 0, depth = 0, type = 0;
  const idat = [];
  for (;;) {
    const len = buf.readUInt32BE(off);
    const name = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (crc32(buf.subarray(off + 4, off + 8 + len)) !== buf.readUInt32BE(off + 8 + len)) {
      throw new Error('bad CRC in ' + name);
    }
    if (name === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; type = data[9];
    } else if (name === 'IDAT') {
      idat.push(data);
    }
    off += 12 + len;
    if (name === 'IEND') break;
  }
  if (off !== buf.length) throw new Error('trailing bytes after IEND');
  const bpp = type === 6 ? 4 : 3;
  const stride = w * bpp;
  const inf = zlib.inflateSync(Buffer.concat(idat));
  if (inf.length !== (stride + 1) * h) throw new Error('unexpected IDAT length');
  const out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = inf[y * (stride + 1)];
    const src = inf.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[y * stride + i - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = (i >= bpp && y > 0) ? out[(y - 1) * stride + i - bpp] : 0;
      let v = src[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      out[y * stride + i] = v & 0xff;
    }
  }
  return { w: w, h: h, depth: depth, type: type, bpp: bpp, pixels: out };
}

function verify(file, size, mustBeOpaque, maskable) {
  const buf = fs.readFileSync(file);
  const img = decodePng(buf);
  const say = [];
  if (img.w !== size || img.h !== size) {
    throw new Error(file + ': ' + img.w + 'x' + img.h + ', expected ' + size + 'x' + size);
  }
  if (img.depth !== 8) throw new Error(file + ': bit depth ' + img.depth);
  say.push(img.w + 'x' + img.h, img.type === 6 ? 'RGBA' : 'RGB');

  if (img.type === 6) {
    let minA = 255;
    for (let i = 3; i < img.pixels.length; i += 4) {
      if (img.pixels[i] < minA) minA = img.pixels[i];
    }
    if (mustBeOpaque && minA !== 255) {
      throw new Error(file + ': transparent pixels (min alpha ' + minA + ')');
    }
    say.push('min alpha ' + minA);
  } else {
    say.push('no alpha channel');
  }

  // Corners must be painted, not empty - a pre-rounded or transparent-cornered
  // icon is the classic iOS "black corners" bug.
  const corners = [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]];
  for (let i = 0; i < corners.length; i++) {
    const o = (corners[i][1] * size + corners[i][0]) * img.bpp;
    const lum = img.pixels[o] + img.pixels[o + 1] + img.pixels[o + 2];
    if (lum < 12) {
      throw new Error(file + ': corner ' + corners[i] + ' is black - corners must not be pre-rounded');
    }
  }

  if (maskable) {
    // Android's maskable safe zone is a CIRCLE of 80% diameter, not a box - a
    // mark that fits the box can still lose its corners to a round mask. Check
    // the circle, and report how much room is actually left.
    const rSafe = REF * SAFE / 2;
    let worst = rSafe;
    for (let y = 0; y < REF; y += 0.5) {
      for (let x = 0; x < REF; x += 0.5) {
        if (!inMark(x, y)) continue;
        const dx = x - REF / 2, dy = y - REF / 2;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > rSafe) {
          throw new Error(file + ': mark reaches ' + x + ',' + y +
                          ' (r=' + d.toFixed(1) + ') - outside the maskable safe circle');
        }
        if (rSafe - d < worst) worst = rSafe - d;
      }
    }
    say.push('mark inside the 80% safe circle, ' + worst.toFixed(0) + 'px spare');
  }

  const sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  console.log('  ok  ' + path.basename(file).padEnd(21) +
              String(buf.length).padStart(7) + ' B  ' + say.join(', ') +
              '  sha256:' + sha + '...');
}

/* ------------------------------------------------------------------ */

const TARGETS = [
  // file,                 size, supersample, alpha channel, opaque, maskable
  ['icon-192.png',          192, 8, true,  true,  false],
  ['icon-512.png',          512, 6, true,  true,  true],
  ['apple-touch-icon.png',  180, 8, false, true,  false]
];

const verifyOnly = process.argv.indexOf('--verify') !== -1;

checkGeometry();

for (let i = 0; i < TARGETS.length; i++) {
  const t = TARGETS[i];
  if (!verifyOnly) {
    fs.writeFileSync(path.join(OUT_DIR, t[0]), encodePng(render(t[1], t[2]), t[1], t[3]));
  }
}

console.log(verifyOnly ? 'verifying icons:' : 'wrote icons:');
for (let i = 0; i < TARGETS.length; i++) {
  const t = TARGETS[i];
  verify(path.join(OUT_DIR, t[0]), t[1], t[4], t[5]);
}

// Three FITS frames, generated in the browser.
//
// Nobody showing this app for the first time has a FITS file on their
// laptop, and the ones that exist in public are 30-200 MB each. So the
// example is synthesised: a 192x192 float image per filter, with a sky
// background, noise and a handful of stars, written as real FITS that
// astropy opens without complaint.
//
// It is about 150 KB per frame, which uploads instantly, and the three
// frames are the same star field at three different filter depths --
// so "a preview of each image" gives three jobs and "one colour
// composite from three" gives one picture with colour in it. Both
// modes have something to show, which a single frame could not do.
//
// WRITING FITS
//
// The format is older than almost everything else here and it shows,
// but it is also the reason this is forty lines rather than a library:
// a header is 80-character ASCII cards padded to a multiple of 2880
// bytes, and the data is a big-endian array padded the same way. There
// is nothing else to it for an image this simple.

import type { FileSet } from '../types';

/** FITS is defined in 2880-byte blocks. Everything is padded to one. */
const BLOCK = 2880;
const CARD = 80;
const SIZE = 192;

export const EXAMPLE_FILES = ['demo-r.fits', 'demo-g.fits', 'demo-b.fits'] as const;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, for noise that looks like detector noise. */
function gaussian(next: () => number): number {
  const u = Math.max(next(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
}

/**
 * One header card: 80 characters, space-padded.
 *
 * A string value is quoted and starts at column 11; a number is right-
 * justified to column 30. Both are what the standard says and what
 * every reader expects, and getting the column wrong is the one
 * mistake here that produces a file astropy rejects outright.
 */
function card(keyword: string, value?: string | number | boolean, comment?: string): string {
  const key = keyword.padEnd(8).slice(0, 8);
  if (value === undefined) return (key + (comment ? ` ${comment}` : '')).padEnd(CARD).slice(0, CARD);

  let rendered: string;
  if (typeof value === 'string') {
    // Single quotes inside a FITS string are doubled.
    rendered = `'${value.replace(/'/g, "''")}'`.padEnd(20);
  } else if (typeof value === 'boolean') {
    rendered = (value ? 'T' : 'F').padStart(20);
  } else {
    rendered = String(value).padStart(20);
  }
  const body = `${key}= ${rendered}${comment ? ` / ${comment}` : ''}`;
  return body.padEnd(CARD).slice(0, CARD);
}

function padToBlock(bytes: number): number {
  return Math.ceil(bytes / BLOCK) * BLOCK;
}

interface Frame {
  name: string;
  filter: string;
  /** Overall depth of this frame, before any per-star colour. */
  response: number;
  /**
   * Which way a star's colour pushes it in THIS filter: +1 red, 0
   * neutral, -1 blue.
   *
   * It has to depend on the filter as well as the star, which is the
   * thing an earlier version of this file got wrong. A single per-star
   * factor multiplying all three frames alike changes only how bright
   * the star is, not what colour it is, so the composite came out as
   * one uniform blue-white field -- a picture that proves the three
   * frames were combined and nothing else.
   */
  colourExponent: number;
  exposure: number;
}

const FRAMES: Frame[] = [
  { name: EXAMPLE_FILES[0], filter: 'R', response: 1.0, colourExponent: 1, exposure: 120 },
  { name: EXAMPLE_FILES[1], filter: 'V', response: 0.9, colourExponent: 0, exposure: 120 },
  { name: EXAMPLE_FILES[2], filter: 'B', response: 0.8, colourExponent: -1, exposure: 240 },
];

interface Star {
  x: number;
  y: number;
  flux: number;
  width: number;
  /** Above 1 is a red star, below 1 a blue one. See colourExponent. */
  colour: number;
}

/** The same star field for every frame, so a composite lines up. */
function starField(): Star[] {
  const next = rng(991);
  return Array.from({ length: 24 }, () => ({
    x: next() * SIZE,
    y: next() * SIZE,
    flux: 200 + next() * 4000,
    width: 1.4 + next() * 1.6,
    colour: 0.55 + next() * 1.25,
  }));
}

const STARS = starField();

/** The image, as float32 big-endian, which is BITPIX = -32. */
function pixels(frame: Frame): ArrayBuffer {
  const next = rng(frame.filter.charCodeAt(0) * 7919);
  const data = new DataView(new ArrayBuffer(SIZE * SIZE * 4));

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // A sky that is brighter in one corner, as a real flat-fielded
      // frame usually still is.
      let v = 480 + 60 * (x / SIZE) + 40 * (y / SIZE) + 12 * gaussian(next);
      for (const s of STARS) {
        const dx = x - s.x;
        const dy = y - s.y;
        const r2 = dx * dx + dy * dy;
        const w2 = s.width * s.width;
        if (r2 < 64 * w2) {
          const colour = Math.pow(s.colour, frame.colourExponent);
          v += s.flux * frame.response * colour * Math.exp(-r2 / (2 * w2));
        }
      }
      data.setFloat32((y * SIZE + x) * 4, v, false); // false: big-endian
    }
  }
  return data.buffer;
}

function header(frame: Frame): string {
  const cards = [
    card('SIMPLE', true, 'conforms to FITS standard'),
    card('BITPIX', -32, '32-bit IEEE floating point'),
    card('NAXIS', 2),
    card('NAXIS1', SIZE),
    card('NAXIS2', SIZE),
    card('OBJECT', 'SYNTHETIC FIELD', 'not a real observation'),
    card('FILTER', frame.filter),
    card('EXPTIME', frame.exposure, 'seconds'),
    card('DATE-OBS', '2026-01-12T03:14:00'),
    card('TELESCOP', 'HTCondor demo'),
    card('INSTRUME', 'generated in the browser'),
    card('BUNIT', 'adu'),
    card('COMMENT', undefined, 'Synthesised by the FITS previews site app.'),
    card('COMMENT', undefined, 'The pixel values are made up. Do not do science with them.'),
    card('END'),
  ].join('');
  return cards.padEnd(padToBlock(cards.length), ' ');
}

function buildFrame(frame: Frame): File {
  const head = new TextEncoder().encode(header(frame));
  const data = new Uint8Array(pixels(frame));
  const out = new Uint8Array(head.length + padToBlock(data.length));
  out.set(head, 0);
  out.set(data, head.length);
  // The tail is already zero, which is what FITS pads data with.
  return new File([out], frame.name, { type: 'application/fits' });
}

export function buildExample(): FileSet {
  return { images: FRAMES.map(buildFrame) };
}

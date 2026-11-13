import { describe, it, expect } from 'vitest';
import { EXAMPLE_FILES, buildExample } from './example';
import { looksLikeFits } from './fits';
import { isSafeFileName } from '../../lib/submit';

const BLOCK = 2880;
const SIZE = 192;

/**
 * The file's bytes.
 *
 * Through FileReader rather than file.arrayBuffer(): jsdom's File has
 * no arrayBuffer method, and it is not a body Response accepts either
 * -- that one silently stringifies to "[object File]" and the
 * assertions then fail on something that is not the bug.
 */
function bytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(file);
  });
}

function ascii(b: Uint8Array, from: number, length: number): string {
  return new TextDecoder('ascii').decode(b.subarray(from, from + length));
}

describe('the generated FITS frames', () => {
  it('produces one file per named frame, each safe to transfer', () => {
    const files = buildExample().images;
    expect(files.map((f) => f.name)).toEqual([...EXAMPLE_FILES]);
    for (const f of files) {
      expect(isSafeFileName(f.name)).toBe(true);
      // The pipeline refuses anything it does not recognise as FITS,
      // so an example it would refuse is worse than no example.
      expect(looksLikeFits(f.name)).toBe(true);
    }
  });

  it('writes a header astropy will accept', async () => {
    const b = await bytes(buildExample().images[0]);

    // Asserted by COLUMN, because that is what the standard says and
    // what a reader enforces: keyword in 1-8, '= ' in 9-10, the value
    // right-justified through column 30.
    const card = (n: number) => ascii(b, n * 80, 80);
    expect(card(0).slice(0, 8)).toBe('SIMPLE  ');
    expect(card(0).slice(8, 10)).toBe('= ');
    expect(card(0).slice(10, 30)).toBe('T'.padStart(20));

    expect(card(1).slice(0, 8)).toBe('BITPIX  ');
    expect(card(1).slice(10, 30)).toBe('-32'.padStart(20));
    expect(card(2).slice(10, 30)).toBe('2'.padStart(20));

    // The header is one unbroken run of 80-character cards with no
    // newlines in it, so END has to be found as a card rather than as
    // a line -- a /^END/m never matches and would pass only by being
    // written the other way round.
    const cards = Array.from({ length: BLOCK / 80 }, (_, i) => card(i));
    expect(cards.map((c) => c.slice(0, 8).trim())).toContain('NAXIS1');
    const end = cards.findIndex((c) => c.startsWith('END'));
    expect(end).toBeGreaterThan(0);
    expect(cards[end]).toBe('END'.padEnd(80));
    // Nothing after END but padding: a reader stops there, so a card
    // written past it is a card silently thrown away.
    for (const c of cards.slice(end + 1)) expect(c).toBe(' '.repeat(80));
  });

  it('pads the header and the data to whole 2880-byte blocks', async () => {
    const b = await bytes(buildExample().images[0]);
    // A FITS file that is not a multiple of the block size is one that
    // a strict reader rejects and a lenient one truncates -- and the
    // lenient case is the dangerous one, because it looks like it
    // worked.
    expect(b.length % BLOCK).toBe(0);
    expect(b.length).toBe(BLOCK + Math.ceil((SIZE * SIZE * 4) / BLOCK) * BLOCK);
  });

  it('writes big-endian floats, which is what BITPIX = -32 means', async () => {
    const b = await bytes(buildExample().images[0]);
    const view = new DataView(b.buffer, BLOCK);
    // The sky level is a few hundred adu. Read the other way round
    // these come out as denormals near zero, so this one comparison
    // catches a byte-order mistake that nothing else would.
    for (const pixel of [0, 100, 5000, SIZE * SIZE - 1]) {
      const v = view.getFloat32(pixel * 4, false);
      expect(v).toBeGreaterThan(100);
      expect(v).toBeLessThan(100000);
    }
  });

  it('puts the same stars in the same places in every frame', async () => {
    const [r, g, b] = buildExample().images;
    const views = await Promise.all(
      [r, g, b].map(async (f) => new DataView((await bytes(f)).buffer, BLOCK)),
    );
    const at = (v: DataView, i: number) => v.getFloat32(i * 4, false);

    // The brightest pixel in R. NOT asserted to be the brightest in
    // the other two: the stars have colours, so a blue star outshines
    // it in B. That is the whole point of a composite, and an earlier
    // version of this test asserted the opposite and would have
    // demanded a grey picture.
    let peak = 0;
    for (let i = 1; i < SIZE * SIZE; i++) if (at(views[0], i) > at(views[0], peak)) peak = i;

    for (const v of views) {
      // A star, at the same index, in every frame. A frame generated
      // with a different field -- the risk if the star list were
      // rebuilt per frame -- puts sky here instead, and a composite of
      // three different fields is three offset pictures.
      const sky = at(v, 0);
      expect(at(v, peak)).toBeGreaterThan(sky * 2);
      // ...and a local maximum, so it is the same star and not the
      // shoulder of a neighbouring one.
      expect(at(v, peak)).toBeGreaterThanOrEqual(at(v, peak + 1));
      expect(at(v, peak)).toBeGreaterThanOrEqual(at(v, peak - 1));
      expect(at(v, peak)).toBeGreaterThanOrEqual(at(v, peak + SIZE));
      expect(at(v, peak)).toBeGreaterThanOrEqual(at(v, peak - SIZE));
    }
  });

  it('gives the stars colours, so the composite is not grey', async () => {
    const [r, , b] = buildExample().images;
    const vr = new DataView((await bytes(r)).buffer, BLOCK);
    const vb = new DataView((await bytes(b)).buffer, BLOCK);
    const at = (v: DataView, i: number) => v.getFloat32(i * 4, false);

    // Every pixel scaled by one per-frame constant would make a
    // perfectly grey field: the R/B ratio would be the same wherever
    // a star is. It has to vary, or "one colour composite from three"
    // produces a picture that shows nothing a single frame does not.
    const ratios: number[] = [];
    for (let i = 0; i < SIZE * SIZE; i++) {
      if (at(vr, i) > 1500) ratios.push(at(vr, i) / at(vb, i));
    }
    expect(ratios.length).toBeGreaterThan(20);
    expect(Math.max(...ratios) / Math.min(...ratios)).toBeGreaterThan(1.5);
  });

  it('is the same bytes every time, so a demo reproduces', async () => {
    // Math.random here would mean two people looking at the same demo
    // see different numbers, and a screenshot never matches.
    expect(await bytes(buildExample().images[0])).toEqual(
      await bytes(buildExample().images[0]),
    );
  });
});

import { describe, it, expect } from 'vitest';
import { astro } from './index';
import { RUNNER_FILE } from './runner';
import { MAX_IMAGES } from './fits';

function fits(name: string, size = 1024): File {
  const f = new File([new Uint8Array(1)], name, { type: 'application/fits' });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

/** The pipeline takes a FileSet now; this one has a single slot. */
function plan(files: File[], options: typeof astro.defaults) {
  return astro.plan({ images: files }, options);
}

const each = astro.defaults;
const composite = { ...astro.defaults, mode: 'composite' as const };

describe('what the astro pipeline will submit', () => {
  it('sends the generated runner alongside the images', () => {
    const planned = plan([fits('a.fits'), fits('b.fits')], each);
    if (planned.kind !== 'job') throw new Error(`want a job, got ${planned.kind}`);
    const names = planned.uploads.map((u) => u.name);
    expect(names).toContain(RUNNER_FILE);
    expect(names).toContain('a.fits');
    expect(names).toContain('b.fits');
  });

  it('names every uploaded file in transfer_input_files', () => {
    // A file uploaded but not declared is thrown away with the
    // sandbox; a file declared but not uploaded holds the job. The
    // two lists have to agree, and nothing else checks that they do.
    const planned = plan([fits('a.fits'), fits('b.fits')], each);
    if (planned.kind !== 'job') throw new Error('want a job');
    for (const u of planned.uploads) {
      expect(planned.submitFile).toContain(u.name);
    }
  });

  it('declares the outputs it creates', () => {
    const planned = plan([fits('a.fits')], each);
    if (planned.kind !== 'job') throw new Error('want a job');
    expect(planned.submitFile).toContain('transfer_output_files');
    expect(planned.submitFile).toContain('results.json');
    expect(planned.submitFile).toContain('preview.png');
  });

  it('sets the batch name with the submit command, not an assignment', () => {
    // `JobBatchName = x` in a submit file defines a MACRO and leaves
    // the job ad without the attribute, so the queue constraint in
    // app.tsx matches nothing and the list stays empty forever.
    const planned = plan([fits('a.fits')], each);
    if (planned.kind !== 'job') throw new Error('want a job');
    expect(planned.submitFile).toMatch(/^batch_name = /m);
    expect(planned.submitFile).not.toMatch(/^JobBatchName = /m);
  });
});

describe('what it refuses, and what it says', () => {
  it('wants exactly three images for a colour composite', () => {
    const two = plan([fits('r.fits'), fits('g.fits')], composite);
    expect(two.kind).toBe('error');
    if (two.kind === 'error') expect(two.message).toContain('three');

    const three = plan([fits('r.fits'), fits('g.fits'), fits('b.fits')], composite);
    expect(three.kind).toBe('job');
  });

  it('names the file to rename rather than stating the rule', () => {
    const planned = plan([fits('my image.fits')], each);
    expect(planned.kind).toBe('error');
    // The astronomer can rename a file. They cannot act on "invalid
    // input", and they should not have to read the regex.
    if (planned.kind === 'error') expect(planned.message).toContain('my image.fits');
  });

  it('refuses something that is not FITS, saying what it expected', () => {
    const planned = plan([fits('notes.txt')], each);
    expect(planned.kind).toBe('error');
    if (planned.kind === 'error') expect(planned.message).toContain('.fits');
  });

  it('refuses more images than it will submit at once', () => {
    const many = Array.from({ length: MAX_IMAGES + 1 }, (_, i) => fits(`f${i}.fits`));
    const planned = plan(many, each);
    expect(planned.kind).toBe('error');
    if (planned.kind === 'error') expect(planned.message).toContain(String(MAX_IMAGES));
  });

  it('asks for an image rather than submitting an empty job', () => {
    expect(plan([], each).kind).toBe('error');
  });
});

describe('colour channels', () => {
  it('assigns red, green and blue in the order dropped', () => {
    // Not guessed from the file name: an observer whose filters are
    // not called r, g and b would silently get the wrong colours.
    const planned = plan([fits('f814w.fits'), fits('f606w.fits'), fits('f435w.fits')], composite);
    if (planned.kind !== 'job') throw new Error('want a job');
    const runner = planned.uploads.find((u) => u.name === RUNNER_FILE);
    expect(runner).toBeDefined();
  });
});

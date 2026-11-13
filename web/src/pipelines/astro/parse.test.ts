import { describe, it, expect } from 'vitest';
import { formatValue, headerRows, parseResults } from './parse';

// A real results.json, trimmed: this is what the runner produced when
// it was run against a synthetic multi-extension HST-shaped file.
const REAL = JSON.stringify({
  schema: 1,
  status: 'ok',
  message: '',
  mode: 'each',
  stretch: 'asinh',
  clip_low: 0.25,
  clip_high: 99.75,
  preview_max_px: 1024,
  images: [
    {
      file: 'frame.fits',
      label: 'NGC 1234 "the thing"',
      hdu: 1,
      hdu_name: 'SCI',
      header: { OBJECT: 'NGC 1234', TELESCOP: 'HST', FILTER: 'F814W', EXPTIME: 1200.0 },
      clip_low_value: 97.7,
      clip_high_value: 6653.5,
      width: 800,
      height: 600,
      pixels: 480000,
      finite_pixels: 479900,
      blank_pixels: 100,
      min: 83.3,
      max: 9121.8,
      mean: 193.7,
      std: 571.0,
      sample_pixels: 29996,
      median: 120.7,
      sigma_mad: 8.4,
    },
  ],
  preview: { file: 'preview.png', width: 200, height: 150, channels: 1, decimation: 4 },
  notes: ['The preview is every 4th pixel of a 800 x 600 image, so fine detail is not in it.'],
});

describe('parseResults', () => {
  it('reads what the job actually writes', () => {
    const r = parseResults(REAL);
    expect(r.status).toBe('ok');
    expect(r.images).toHaveLength(1);
    expect(r.images[0].label).toBe('NGC 1234 "the thing"');
    expect(r.images[0].sigma_mad).toBe(8.4);
    expect(r.preview?.width).toBe(200);
    expect(r.notes).toHaveLength(1);
  });

  // The file is DECLARED as an output and created EMPTY at the start
  // of the job, so that a failure is reported as a failure instead of
  // as a hold for a missing file. An empty results.json is therefore
  // the normal shape of a failed job, not a bug.
  it('turns an empty file into a sentence, not an exception nobody reads', () => {
    expect(() => parseResults('')).toThrow(/empty results file/i);
    expect(() => parseResults('   \n')).toThrow(/empty results file/i);
  });

  it('turns a truncated file into a sentence about the job, not about JSON', () => {
    expect(() => parseResults('{"status":"ok","ima')).toThrow(/cut short/i);
  });

  it('treats an unknown status as an error rather than as success', () => {
    expect(parseResults('{"status":"weird"}').status).toBe('error');
  });

  // The one that matters for a result that is a picture: a job that
  // failed still brings back a zero-byte preview.png, and an <img>
  // pointed at zero bytes shows a broken-image icon. Whether to draw
  // one is decided here, from results.json, never from the file.
  it('reports no preview when the job did not draw one', () => {
    expect(parseResults('{"status":"error","preview":null}').preview).toBeNull();
    expect(parseResults('{"status":"ok","preview":{"file":"preview.png"}}').preview).toBeNull();
    expect(parseResults('{"status":"ok","preview":{"width":0,"height":0}}').preview).toBeNull();
  });

  it('drops header values it cannot render rather than crashing on them', () => {
    const r = parseResults(
      '{"status":"ok","images":[{"header":{"OBJECT":"M51","JUNK":{"a":1},"EXPTIME":500}}]}',
    );
    expect(r.images[0].header).toEqual({ OBJECT: 'M51', EXPTIME: 500 });
  });
});

describe('headerRows', () => {
  it('puts the cards in the order that helps, not the order FITS stored them', () => {
    const rows = headerRows({ EXPTIME: 1200, OBJECT: 'M51', FILTER: 'F606W' });
    expect(rows.map((r) => r.key)).toEqual(['OBJECT', 'FILTER', 'EXPTIME']);
  });
});

describe('formatValue', () => {
  it('copes with both ends of an astronomical dynamic range', () => {
    expect(formatValue(undefined)).toBe('—');
    expect(formatValue(0)).toBe('0');
    expect(formatValue(120.65081)).toBe('120.65');
    expect(formatValue(9121.7666)).toBe('9121.8');
    // Calibrated surface brightness, and raw counts on a deep frame.
    expect(formatValue(3.2e-19)).toBe('3.200e-19');
    expect(formatValue(1.4e6)).toBe('1.400e+6');
  });
});

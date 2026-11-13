import { describe, it, expect } from 'vitest';
import {
  CLIPS,
  DEFAULT_OPTIONS,
  MAX_FILE_BYTES,
  MAX_IMAGES,
  UPLOAD_BUDGET_BYTES,
  clipById,
  formatBytes,
  isSafeFileName,
  isSize,
  isStretch,
  looksLikeFits,
  plan,
  planSentence,
  requestDiskKB,
  requestMemoryMB,
  type Options,
} from './fits';

const MB = 1024 * 1024;
const each: Options = { ...DEFAULT_OPTIONS, mode: 'each' };
const composite: Options = { ...DEFAULT_OPTIONS, mode: 'composite' };

function frames(n: number, bytes = 80 * MB) {
  return Array.from({ length: n }, (_, i) => ({ name: `f${i}.fits`, bytes }));
}

describe('looksLikeFits', () => {
  it('accepts the extensions FITS actually uses', () => {
    for (const ok of [
      'a.fits',
      'A.FITS',
      'hst_12345_01_wfc3_uvis_f814w.fit',
      'legacy.fts',
      'big.fits.gz',
      'rice.fits.fz',
    ]) {
      expect(looksLikeFits(ok), ok).toBe(true);
    }
  });

  it('is a warning, not a gate', () => {
    // The magic number is the real test and the job does it; this only
    // decides whether to put a note next to a file name.
    expect(looksLikeFits('notes.txt')).toBe(false);
    expect(plan(each, [{ name: 'notes.txt', bytes: 10 }]).blocker).toBeNull();
    expect(plan(each, [{ name: 'notes.txt', bytes: 10 }]).warnings.length).toBe(1);
  });
});

describe('isSafeFileName', () => {
  it('rejects paths, traversal and shell metacharacters', () => {
    for (const bad of ['../etc/passwd', 'a/b', '..', '.', '', 'a\nb', 'a,b', 'my frame.fits', '-rf.fits', 'a"b.fits', '$(x).fits']) {
      expect(isSafeFileName(bad), bad).toBe(false);
    }
  });

  it('accepts the names a telescope archive produces', () => {
    for (const ok of ['hst_09427_01_acs_wfc_f814w_drz.fits', 'NGC1234-F606W.fits.gz', 'f1.fit']) {
      expect(isSafeFileName(ok), ok).toBe(true);
    }
  });
});

describe('plan: what a submission costs', () => {
  it('is one job per image in "each" mode, and the upload is the sum', () => {
    const p = plan(each, frames(6, 100 * MB));
    expect(p.jobs).toBe(6);
    // The point of this app's shape: nothing is shared, so there is no
    // jobs x sharedInput multiplier. 6 x 100 MB uploaded is 600 MB,
    // not 3.6 GB.
    expect(p.uploadBytes).toBe(600 * MB);
    expect(p.blocker).toBeNull();
  });

  it('is ONE job in composite mode, because the job needs the frames together', () => {
    const p = plan(composite, frames(3, 100 * MB));
    expect(p.jobs).toBe(1);
    expect(p.uploadBytes).toBe(300 * MB);
    expect(p.blocker).toBeNull();
  });

  it('refuses a composite of one frame, and of four', () => {
    expect(plan(composite, frames(1)).blocker).toMatch(/at least two/i);
    expect(plan(composite, frames(4)).blocker).toMatch(/at most three|at most 3/i);
  });

  it('refuses a file too large to push through a browser, by name', () => {
    const p = plan(each, [{ name: 'huge.fits', bytes: MAX_FILE_BYTES + 1 }]);
    expect(p.blocker).toContain('huge.fits');
    // And says what to do instead, rather than only that it said no.
    expect(p.blocker).toMatch(/administrator/i);
  });

  it('refuses an empty file, which is what a half-finished download is', () => {
    expect(plan(each, [{ name: 'a.fits', bytes: 0 }]).blocker).toMatch(/empty/i);
  });

  it('names the file to rename rather than silently dropping it', () => {
    const p = plan(each, [{ name: 'my frame.fits', bytes: 10 }]);
    expect(p.blocker).toContain('my frame.fits');
  });

  it('caps the number of clusters one submission can create', () => {
    expect(plan(each, frames(MAX_IMAGES, 1024)).blocker).toBeNull();
    expect(plan(each, frames(MAX_IMAGES + 1, 1024)).blocker).toMatch(/batches/i);
  });

  it('caps the total upload', () => {
    const big = Math.ceil(UPLOAD_BUDGET_BYTES / 10) + 1;
    expect(plan(each, frames(10, big)).blocker).toMatch(/limit for one submission/i);
  });

  it('warns about a long upload before the user starts one', () => {
    const p = plan(each, frames(8, 128 * MB));
    expect(p.warnings.join(' ')).toMatch(/long upload/i);
    expect(p.warnings.join(' ')).toMatch(/1\.0 GB/);
  });

  it('nothing chosen is not an error', () => {
    const p = plan(each, []);
    expect(p.blocker).toBeNull();
    expect(p.jobs).toBe(0);
  });
});

describe('planSentence', () => {
  it('states the upload in bytes, because that is what the user pays', () => {
    const opts = each;
    const p = plan(opts, frames(4, 256 * MB));
    const s = planSentence(opts, p);
    expect(s).toContain('4 jobs');
    expect(s).toContain('1.0 GB');
    expect(s).toMatch(/upload is the slow part/i);
  });

  it('says what to do when nothing is chosen', () => {
    expect(planSentence(each, plan(each, []))).toMatch(/add fits images/i);
  });
});

describe('the choices', () => {
  it('validates what comes back from a <select>', () => {
    expect(isStretch('asinh')).toBe(true);
    expect(isStretch('; rm -rf /')).toBe(false);
    expect(isSize(1024)).toBe(true);
    expect(isSize(99999)).toBe(false);
  });

  it('falls back to the default clip rather than producing an invalid one', () => {
    expect(clipById('nonsense')).toBe(CLIPS[0]);
  });

  it('never produces a clip whose low is above its high', () => {
    for (const c of CLIPS) expect(c.low).toBeLessThan(c.high);
  });
});

describe('resource requests', () => {
  it('scale with the file but stay inside what a pool can offer', () => {
    expect(requestMemoryMB(0)).toBe(2048);
    expect(requestMemoryMB(200 * MB)).toBe(2048);
    expect(requestMemoryMB(900 * MB)).toBeGreaterThan(2048);
    expect(requestMemoryMB(100 * 1024 * MB)).toBeLessThanOrEqual(32768);
    // request_disk is in KiB, so a 100 MB file must ask for far more
    // than 100 -- the classic unit bug.
    expect(requestDiskKB(100 * MB)).toBeGreaterThan(100 * 1024);
  });
});

describe('formatBytes', () => {
  it('reads the way a person says it', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(250 * MB)).toBe('250 MB');
    expect(formatBytes(1024 * MB)).toBe('1.0 GB');
  });
});

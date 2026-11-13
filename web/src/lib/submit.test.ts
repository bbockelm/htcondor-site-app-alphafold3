import { describe, it, expect } from 'vitest';
import { adString, quote, isSafeFileName, requestDiskKB } from './submit';

// The effective value of a submit command is the LAST assignment before
// `queue`, which is what the submit processor evaluates. Asserting on
// that rather than on "the file contains the string" is the point: a
// substring check passes even when a later line overrides the value.

describe('quote', () => {
  it('neutralizes macro substitution', () => {
    // $ENV(HOME) would otherwise read the SERVER's environment.
    expect(quote('$ENV(HOME)')).toBe('$(DOLLAR)ENV(HOME)');
    expect(quote('$(Cluster)')).toBe('$(DOLLAR)(Cluster)');
  });

  it('collapses newlines so a value cannot start a new command', () => {
    expect(quote('a\nexecutable = /bin/sh')).not.toContain('\n');
  });
});

describe('isSafeFileName', () => {
  it('rejects paths and traversal', () => {
    for (const bad of ['../etc/passwd', 'a/b', '..', '.', '', 'a\nb', 'a,b']) {
      expect(isSafeFileName(bad)).toBe(false);
    }
  });

  // These all passed the older "no slashes, no newlines" rule, and
  // every one is a problem in transfer_input_files, in a multipart
  // filename, or on a shell command line.
  it('rejects names that are trouble further down the path', () => {
    for (const bad of ['my file.fa', "it's.fa", '$(x).fa', '-rf.fa', 'a"b.fa', '`id`.fa', 'a;b.fa']) {
      expect(isSafeFileName(bad), bad).toBe(false);
    }
  });

  it('accepts ordinary names', () => {
    for (const ok of ['sample.fastq.gz', 'run-01.cfg', 'IMG_0001.tif']) {
      expect(isSafeFileName(ok)).toBe(true);
    }
  });
});

describe('adString', () => {
  it('escapes what the ClassAd grammar would otherwise end the string on', () => {
    expect(adString('say "hi"')).toBe('"say \\"hi\\""');
    expect(adString('a\\b')).toBe('"a\\\\b"');
  });

  it('collapses newlines, which would end the attribute', () => {
    expect(adString('one\ntwo')).toBe('"one two"');
  });
});

describe('requestDiskKB', () => {
  it('never asks for less than the floor', () => {
    expect(requestDiskKB(0)).toBe(512 * 1024);
    expect(requestDiskKB(-1)).toBe(512 * 1024);
  });

  it('grows with the input, with room for the outputs', () => {
    const big = 4 * 1024 * 1024 * 1024;
    expect(requestDiskKB(big)).toBeGreaterThan(big / 1024);
  });
});

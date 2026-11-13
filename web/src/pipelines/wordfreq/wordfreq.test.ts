import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CSV_NAME,
  DEFAULT_OPTIONS,
  INPUT_NAME,
  OUTPUT_FILES,
  RESULTS_NAME,
  awkString,
  buildProgram,
  normalizeOptions,
  type CountOptions,
} from './wordfreq';

// These tests RUN the generated program under a real awk.
//
// That is the whole point. Asserting that the generated text contains
// "minlen = 3" proves nothing about whether awk accepts the program or
// counts correctly, and the program is the part of this app that is
// actually about the science. awk is present wherever this suite runs;
// if it ever is not, a loud failure here is the correct outcome rather
// than a skip that goes green.

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wordfreq-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the generated counter over `text` exactly as the job would. */
function count(text: string, opts: Partial<CountOptions> = {}) {
  const run = mkdtempSync(join(dir, 'run-'));
  writeFileSync(join(run, INPUT_NAME), text);
  writeFileSync(join(run, 'wordfreq.awk'), buildProgram('sample.txt', { ...DEFAULT_OPTIONS, ...opts }));
  const report = execFileSync('awk', ['-f', 'wordfreq.awk', INPUT_NAME], {
    cwd: run,
    encoding: 'utf8',
  });
  const read = (name: string) => {
    const f = join(run, name);
    return existsSync(f) ? readFileSync(f, 'utf8') : null;
  };
  return { report, csv: read(CSV_NAME), json: read(RESULTS_NAME), dir: run };
}

/** The word -> count pairs the CSV records. */
function csvCounts(csv: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of (csv ?? '').trim().split('\n').slice(1)) {
    const [word, n] = line.split(',');
    if (word) out[word] = Number(n);
  }
  return out;
}

describe('awkString', () => {
  it('escapes what would end an awk literal', () => {
    expect(awkString('a"b')).toBe('"a\\"b"');
    expect(awkString('a\\b')).toBe('"a\\\\b"');
    expect(awkString('a\nb')).toBe('"a b"');
  });
});

describe('normalizeOptions', () => {
  it('clamps values a number input can produce', () => {
    expect(normalizeOptions({ ...DEFAULT_OPTIONS, minLength: 0 }).minLength).toBe(1);
    expect(normalizeOptions({ ...DEFAULT_OPTIONS, minLength: 999 }).minLength).toBe(20);
    expect(normalizeOptions({ ...DEFAULT_OPTIONS, topN: 0 }).topN).toBe(1);
  });

  it('survives the NaN an emptied number field produces', () => {
    expect(normalizeOptions({ ...DEFAULT_OPTIONS, topN: NaN }).topN).toBe(1);
  });
});

describe('the generated counter, run under awk', () => {
  it('counts words', () => {
    const { csv } = count('apple banana apple cherry apple banana', {
      minLength: 1,
      skipCommonWords: false,
    });
    expect(csvCounts(csv)).toEqual({ apple: 3, banana: 2, cherry: 1 });
  });

  it('ranks the most frequent word first in the report', () => {
    const { report } = count('apple banana apple cherry apple banana', {
      minLength: 1,
      skipCommonWords: false,
    });
    // Everything after the column header, which ends in "share".
    const rows = report
      .slice(report.indexOf('share') + 'share'.length)
      .trim()
      .split('\n');
    expect(rows[0].trim().split(/\s+/)[0]).toBe('apple');
    expect(rows[1].trim().split(/\s+/)[0]).toBe('banana');
  });

  it('folds case when asked and keeps it when not', () => {
    const text = 'Apple apple APPLE';
    expect(csvCounts(count(text, { minLength: 1, foldCase: true, skipCommonWords: false }).csv)).toEqual({
      apple: 3,
    });
    expect(csvCounts(count(text, { minLength: 1, foldCase: false, skipCommonWords: false }).csv)).toEqual({
      Apple: 1,
      apple: 1,
      APPLE: 1,
    });
  });

  it('drops words below the minimum length', () => {
    const counts = csvCounts(count('a bb ccc dddd', { minLength: 3, skipCommonWords: false }).csv);
    expect(Object.keys(counts).sort()).toEqual(['ccc', 'dddd']);
  });

  it('drops common words only when asked', () => {
    const text = 'the cat and the hat';
    expect(csvCounts(count(text, { minLength: 1, skipCommonWords: true }).csv)).toEqual({
      cat: 1,
      hat: 1,
    });
    expect(csvCounts(count(text, { minLength: 1, skipCommonWords: false }).csv).the).toBe(2);
  });

  it('keeps apostrophes inside a word and strips them outside', () => {
    const counts = csvCounts(
      count("don't 'quoted' can't", { minLength: 1, skipCommonWords: false }).csv,
    );
    expect(counts["don't"]).toBe(1);
    expect(counts['quoted']).toBe(1);
    expect(counts["can't"]).toBe(1);
  });

  it('treats punctuation, digits and markup as separators', () => {
    const counts = csvCounts(
      count('<p>Hello, world! 42 times.</p>', { minLength: 1, skipCommonWords: false }).csv,
    );
    expect(counts).toEqual({ p: 2, hello: 1, world: 1, times: 1 });
  });

  it('shows only the top N in the report but all words in the CSV', () => {
    const text = 'aa bb cc dd ee';
    const { report, csv } = count(text, { minLength: 1, topN: 2, skipCommonWords: false });
    expect(report).toContain('Top 2:');
    expect(Object.keys(csvCounts(csv))).toHaveLength(5);
  });

  it('writes a CSV with a header even when nothing is counted', () => {
    // A missing file would be indistinguishable from a failed job, and
    // with transfer_output_files unset there is nothing to hold on.
    const { report, csv } = count('', {});
    expect(csv).toBe('word,count\n');
    expect(report).toContain('No words were counted');
  });

  it('names the file the user dropped, in the report', () => {
    const { report } = count('hello world hello', { minLength: 1 });
    expect(report).toContain('Word frequencies for sample.txt');
  });

  it('cannot be hijacked by the file name it is told to print', () => {
    const run = mkdtempSync(join(dir, 'evil-'));
    writeFileSync(join(run, INPUT_NAME), 'alpha beta alpha');
    writeFileSync(
      join(run, 'wordfreq.awk'),
      buildProgram('"; system("touch pwned"); x = "', DEFAULT_OPTIONS),
    );
    const report = execFileSync('awk', ['-f', 'wordfreq.awk', INPUT_NAME], {
      cwd: run,
      encoding: 'utf8',
    });
    expect(existsSync(join(run, 'pwned'))).toBe(false);
    expect(report).toContain('system("touch pwned")');
  });

  it('reports both the raw and the counted totals', () => {
    // They differ whenever a filter is on, and a user who sees only
    // the filtered number thinks words went missing.
    const { report } = count('the cat sat on the mat', { minLength: 1, skipCommonWords: true });
    expect(report).toContain('6 words in the file');
    expect(report).toContain('3 words counted');
  });
});

describe('the structured result', () => {
  it('is valid JSON with the counts the report shows', () => {
    const { json } = count('whale whale ship ocean ocean ocean', {
      minLength: 1,
      skipCommonWords: false,
    });
    const r = JSON.parse(json!);
    expect(r.words).toEqual([
      { word: 'ocean', count: 3, share: 50 },
      { word: 'whale', count: 2, share: 33.3333 },
      { word: 'ship', count: 1, share: 16.6667 },
    ]);
  });

  it('carries the totals and the options the job actually used', () => {
    const { json } = count('the cat sat on the mat', { minLength: 1, skipCommonWords: true });
    const r = JSON.parse(json!);
    expect(r.totalWords).toBe(6);
    expect(r.countedWords).toBe(3);
    expect(r.uniqueWords).toBe(3);
    expect(r.options).toEqual({
      minLength: 1,
      topN: 25,
      foldCase: true,
      skipCommonWords: true,
    });
  });

  it('holds only the top N, since the CSV holds the rest', () => {
    const { json, csv } = count('aa bb cc dd ee', {
      minLength: 1,
      topN: 2,
      skipCommonWords: false,
    });
    expect(JSON.parse(json!).words).toHaveLength(2);
    expect(Object.keys(csvCounts(csv))).toHaveLength(5);
  });

  it('is still valid JSON when nothing was counted', () => {
    // The failure path has to stay parseable: an empty array is a
    // result, a truncated file is a bug report.
    const { json } = count('', {});
    const r = JSON.parse(json!);
    expect(r.words).toEqual([]);
    expect(r.countedWords).toBe(0);
  });

  it('escapes a file name that would otherwise break the JSON', () => {
    const run = mkdtempSync(join(dir, 'json-'));
    writeFileSync(join(run, INPUT_NAME), 'alpha beta alpha');
    writeFileSync(
      join(run, 'wordfreq.awk'),
      buildProgram('a"b\\c.txt', { ...DEFAULT_OPTIONS, minLength: 1 }),
    );
    execFileSync('awk', ['-f', 'wordfreq.awk', INPUT_NAME], { cwd: run, encoding: 'utf8' });
    const r = JSON.parse(readFileSync(join(run, RESULTS_NAME), 'utf8'));
    expect(r.file).toBe('a"b\\c.txt');
  });

  it('cannot emit a word that would need escaping', () => {
    // The tokenizer admits only letters and apostrophes, which is WHY
    // the awk program carries no JSON escaper. If that ever stops
    // being true the JSON silently becomes invalid, so assert it
    // against input made of nothing but the dangerous characters.
    const { json } = count('he said "hi\\there" to \u0007 somebody', {
      minLength: 1,
      skipCommonWords: false,
    });
    const r = JSON.parse(json!);
    for (const w of r.words) expect(w.word).toMatch(/^[A-Za-z']+$/);
  });

  it('writes every file the submit file declares', () => {
    const { dir: run } = count('alpha beta', { minLength: 1 });
    for (const name of OUTPUT_FILES) {
      expect(existsSync(join(run, name)), `${name} was declared but not written`).toBe(true);
    }
  });
});

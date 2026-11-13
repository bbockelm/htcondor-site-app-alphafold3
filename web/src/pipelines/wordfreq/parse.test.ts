import { describe, it, expect } from 'vitest';
import { parseResults, sortWords, type WordCount } from './parse';

const good = JSON.stringify({
  file: 'moby.txt',
  totalWords: 10,
  countedWords: 6,
  uniqueWords: 3,
  options: { minLength: 3, topN: 25, foldCase: true, skipCommonWords: true },
  words: [
    { word: 'whale', count: 3, share: 50 },
    { word: 'ship', count: 2, share: 33.33 },
    { word: 'sea', count: 1, share: 16.67 },
  ],
});

describe('parseResults', () => {
  it('reads what the job wrote', () => {
    const r = parseResults(good);
    expect(r.file).toBe('moby.txt');
    expect(r.countedWords).toBe(6);
    expect(r.words).toHaveLength(3);
    expect(r.options.skipCommonWords).toBe(true);
  });

  it('explains an empty file instead of showing an empty table', () => {
    // The job creates results.json empty BEFORE doing any work, so
    // "empty" is the normal shape of a job that failed. The message
    // has to send the user to the summary, where the real error is.
    expect(() => parseResults('')).toThrow(/did not finish/);
    expect(() => parseResults('   \n')).toThrow(/did not finish/);
  });

  it('explains a truncated file rather than throwing a parser error', () => {
    expect(() => parseResults('{"words": [{"word": "a",')).toThrow(/cut short/);
  });

  it('rejects JSON of the wrong shape', () => {
    expect(() => parseResults('{"nope": 1}')).toThrow(/expected form/);
    expect(() => parseResults('[]')).toThrow(/expected form/);
  });

  it('drops rows that are not a word and a count', () => {
    const r = parseResults(
      JSON.stringify({ words: [{ word: 'ok', count: 1 }, { word: 'bad' }, null, 7] }),
    );
    expect(r.words).toEqual([{ word: 'ok', count: 1, share: 0 }]);
  });

  it('defaults the totals rather than rendering NaN', () => {
    const r = parseResults(JSON.stringify({ words: [] }));
    expect(r.totalWords).toBe(0);
    expect(r.uniqueWords).toBe(0);
    expect(r.options.minLength).toBe(0);
  });
});

describe('sortWords', () => {
  const rows: WordCount[] = [
    { word: 'pear', count: 2, share: 20 },
    { word: 'apple', count: 5, share: 50 },
    { word: 'fig', count: 2, share: 20 },
  ];

  it('sorts by count, descending by default', () => {
    expect(sortWords(rows, 'count', false).map((w) => w.word)).toEqual(['apple', 'fig', 'pear']);
  });

  it('sorts by count ascending', () => {
    expect(sortWords(rows, 'count', true).map((w) => w.word)).toEqual(['fig', 'pear', 'apple']);
  });

  it('breaks ties alphabetically in both directions', () => {
    // Otherwise the table reshuffles its ties when you click twice,
    // which reads as a bug.
    expect(sortWords(rows, 'count', false).slice(1).map((w) => w.word)).toEqual(['fig', 'pear']);
    expect(sortWords(rows, 'count', true).slice(0, 2).map((w) => w.word)).toEqual(['fig', 'pear']);
  });

  it('sorts by word', () => {
    expect(sortWords(rows, 'word', true).map((w) => w.word)).toEqual(['apple', 'fig', 'pear']);
  });

  it('does not disturb the array it was given', () => {
    const before = rows.map((w) => w.word);
    sortWords(rows, 'word', true);
    expect(rows.map((w) => w.word)).toEqual(before);
  });
});

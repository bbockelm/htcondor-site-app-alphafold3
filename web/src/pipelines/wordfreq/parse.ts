// Reading what the job wrote.
//
// results.json is produced by the awk program in wordfreq.ts, so its
// shape is this app's own contract with itself -- but it still arrives
// over the network from a file a job wrote, and a job can be killed
// mid-write. Parsing it defensively is not paranoia about the format,
// it is about the truncated file.

/** One row of the table. */
export interface WordCount {
  word: string;
  count: number;
  share: number;
}

/** results.json, as the job writes it. */
export interface Results {
  file: string;
  totalWords: number;
  countedWords: number;
  uniqueWords: number;
  options: { minLength: number; topN: number; foldCase: boolean; skipCommonWords: boolean };
  words: WordCount[];
}

/**
 * Parse results.json, or say why not in a sentence a user can act on.
 *
 * Returns the results, or throws an Error whose message is already fit
 * to display. The job declares this file and creates it empty before
 * doing any work, so "empty" is the normal shape of a job that failed
 * -- it means "look at the summary", not "the app is broken".
 */
export function parseResults(text: string): Results {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(
      'this file produced no counts — the job did not finish writing them. The summary says what went wrong.',
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    throw new Error('the results file was incomplete, which usually means the job was cut short.');
  }

  const o = raw as Partial<Results>;
  if (!o || typeof o !== 'object' || !Array.isArray(o.words)) {
    throw new Error('the results file was not in the expected form.');
  }

  const words: WordCount[] = [];
  for (const w of o.words) {
    if (!w || typeof w.word !== 'string' || typeof w.count !== 'number') continue;
    words.push({ word: w.word, count: w.count, share: typeof w.share === 'number' ? w.share : 0 });
  }

  return {
    file: typeof o.file === 'string' ? o.file : '',
    totalWords: num(o.totalWords),
    countedWords: num(o.countedWords),
    uniqueWords: num(o.uniqueWords),
    options: {
      minLength: num(o.options?.minLength),
      topN: num(o.options?.topN),
      foldCase: !!o.options?.foldCase,
      skipCommonWords: !!o.options?.skipCommonWords,
    },
    words,
  };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export type SortKey = 'count' | 'word';

/**
 * Sort the rows for display.
 *
 * Returns a new array: the parsed results are kept in the order the
 * job ranked them, so that resetting the sort does not need a refetch.
 */
export function sortWords(words: WordCount[], key: SortKey, ascending: boolean): WordCount[] {
  const dir = ascending ? 1 : -1;
  return [...words].sort((a, b) => {
    if (key === 'word') return dir * a.word.localeCompare(b.word);
    // Equal counts keep a stable, alphabetical order rather than
    // whatever the sort happened to do -- a table that reshuffles its
    // ties when you click twice looks broken.
    if (a.count !== b.count) return dir * (a.count - b.count);
    return a.word.localeCompare(b.word);
  });
}

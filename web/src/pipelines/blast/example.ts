// A reference database and some queries, for a person who has neither.
//
// The sequences are SYNTHETIC and are not biology: they are generated
// here from a fixed seed. That is deliberate. A real database small
// enough to build into a page would be a curiosity, and a real one of
// useful size is exactly the thing this pipeline exists to avoid
// pushing through a browser.
//
// What they are good for is showing the mechanism end to end. Each
// query is a slice of a database sequence with a few bases changed, so
// blastn finds a strong hit with an identity a little under 100% --
// which is what a result page should look like. One query is
// deliberately random, so the table also shows what "no match" looks
// like rather than only the happy path.

import type { FileSet } from '../types';
import type { BlastOptions } from './index';

export const EXAMPLE_DATABASE = 'demo-reference.fasta';
export const EXAMPLE_QUERIES = 'demo-queries.fasta';

const BASES = 'ACGT';

/**
 * A small deterministic generator.
 *
 * Math.random would make the example different on every click, so two
 * people looking at the same demo would see different numbers and a
 * screenshot would never reproduce. mulberry32 is four lines and fixes
 * that.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSequence(next: () => number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += BASES[Math.floor(next() * 4)];
  return s;
}

/** FASTA wants the sequence wrapped; 60 is the conventional width. */
function fasta(id: string, description: string, sequence: string): string {
  const lines: string[] = [`>${id} ${description}`];
  for (let i = 0; i < sequence.length; i += 60) {
    lines.push(sequence.slice(i, i + 60));
  }
  return lines.join('\n') + '\n';
}

/** Change roughly one base in `rate`, so the hit is strong but not exact. */
function mutate(next: () => number, sequence: string, rate: number): string {
  return Array.from(sequence, (base) =>
    next() < 1 / rate ? BASES[Math.floor(next() * 4)] : base,
  ).join('');
}

const DB_SEQUENCES = 12;
const DB_LENGTH = 900;
const QUERY_LENGTH = 320;

interface Built {
  database: string;
  queries: string;
}

/** The two FASTA files, as text. Exported so a test can read them. */
export function buildExampleText(): Built {
  const next = rng(20260112);

  const subjects = Array.from({ length: DB_SEQUENCES }, (_, i) => ({
    id: `ref_${String(i + 1).padStart(2, '0')}`,
    sequence: randomSequence(next, DB_LENGTH),
  }));

  const database = subjects
    .map((s) => fasta(s.id, `synthetic reference sequence ${s.id}`, s.sequence))
    .join('');

  // Three queries cut out of the database, and one that is not in it.
  // The last is the honest half of the demo: a result page that has
  // only ever been looked at with matching data does not show the
  // reader what an empty row means.
  const cuts = [
    { subject: subjects[2], at: 100, rate: 40 },
    { subject: subjects[6], at: 420, rate: 20 },
    { subject: subjects[9], at: 50, rate: 12 },
  ];

  const queries =
    cuts
      .map((c, i) =>
        fasta(
          `query_${i + 1}`,
          `slice of ${c.subject.id} with about 1 base in ${c.rate} changed`,
          mutate(next, c.subject.sequence.slice(c.at, c.at + QUERY_LENGTH), c.rate),
        ),
      )
      .join('') +
    fasta(
      'query_4',
      'random sequence, expected to find nothing',
      randomSequence(next, QUERY_LENGTH),
    );

  return { database, queries };
}

export function buildExample(): FileSet {
  const { database, queries } = buildExampleText();
  return {
    database: [new File([database], EXAMPLE_DATABASE, { type: 'text/plain' })],
    queries: [new File([queries], EXAMPLE_QUERIES, { type: 'text/plain' })],
  };
}

/**
 * The example is DNA against DNA, so the program has to be blastn
 * whatever was selected before the box was ticked. Everything else is
 * left alone: the e-value and hit count are the knobs worth playing
 * with while looking at the result.
 */
export const EXAMPLE_OPTIONS: Partial<BlastOptions> = { program: 'blastn' };

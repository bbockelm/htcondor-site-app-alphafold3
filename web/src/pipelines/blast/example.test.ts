import { describe, it, expect } from 'vitest';
import { EXAMPLE_DATABASE, EXAMPLE_QUERIES, buildExample, buildExampleText } from './example';
import { PASTED_FILE, blast, pastedQueryFile } from './index';
import { RUNNER_FILE } from './blast';
import { outputFiles, requestMemoryMB } from './blast';
import { isSafeFileName } from '../../lib/submit';
import { isPlanError } from '../types';

/** Sequences from a FASTA string, by id. */
function parseFasta(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let id = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('>')) {
      id = line.slice(1).split(/\s/)[0];
      out[id] = '';
    } else if (id) {
      out[id] += line.trim();
    }
  }
  return out;
}

/** Does any k-mer of `query` appear anywhere in `subjects`? */
function sharesKmer(query: string, subjects: string[], k: number): boolean {
  const pool = new Set<string>();
  for (const s of subjects) {
    for (let i = 0; i + k <= s.length; i++) pool.add(s.slice(i, i + k));
  }
  for (let i = 0; i + k <= query.length; i++) {
    if (pool.has(query.slice(i, i + k))) return true;
  }
  return false;
}

/** The file's text. jsdom's File has no .text(); FileReader works. */
function read(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    r.onload = () => resolve(r.result as string);
    r.readAsText(file);
  });
}

describe('the example database and queries', () => {
  it('names two files the pipeline will accept', () => {
    const files = buildExample();
    expect(files.database.map((f) => f.name)).toEqual([EXAMPLE_DATABASE]);
    expect(files.queries.map((f) => f.name)).toEqual([EXAMPLE_QUERIES]);
    for (const f of [...files.database, ...files.queries]) {
      expect(isSafeFileName(f.name)).toBe(true);
    }
  });

  it('writes FASTA that is actually FASTA', () => {
    const { database, queries } = buildExampleText();
    expect(database.startsWith('>')).toBe(true);
    expect(queries.startsWith('>')).toBe(true);
    // A headerless file is read by BLAST as zero sequences -- it
    // SUCCEEDS, with no hits, which is indistinguishable from a real
    // empty result. So the headers are worth asserting.
    expect(Object.keys(parseFasta(database))).toHaveLength(12);
    expect(Object.keys(parseFasta(queries))).toHaveLength(4);
    for (const seq of Object.values(parseFasta(database))) {
      expect(seq).toMatch(/^[ACGT]+$/);
    }
  });

  it('plants real matches, so the demo has something to find', () => {
    // The whole value of example data is that the result page shows a
    // table rather than "no hits". Three queries are cut from the
    // database with a few bases changed; a long exact stretch has to
    // survive that, or blastn finds nothing and the demo shows an
    // empty page.
    const { database, queries } = buildExampleText();
    const subjects = Object.values(parseFasta(database));
    const q = parseFasta(queries);
    for (const id of ['query_1', 'query_2', 'query_3']) {
      expect(sharesKmer(q[id], subjects, 24), `${id} has no stretch in the database`).toBe(true);
    }
  });

  it('includes one query that matches nothing', () => {
    // The honest half. A page only ever seen with matching data never
    // shows the reader what an empty result looks like.
    const { database, queries } = buildExampleText();
    const subjects = Object.values(parseFasta(database));
    expect(sharesKmer(parseFasta(queries).query_4, subjects, 24)).toBe(false);
  });

  it('is the same every time, so a demo reproduces', () => {
    expect(buildExampleText()).toEqual(buildExampleText());
  });
});

describe('pasted sequences', () => {
  it('is nothing when the box is empty', () => {
    expect(pastedQueryFile('')).toBeUndefined();
    expect(pastedQueryFile('   \n  ')).toBeUndefined();
  });

  it('adds the header a bare sequence is missing', async () => {
    // BLAST reads a headerless file as zero sequences and exits 0. The
    // user gets an empty result and no error at all, which is the
    // worst possible answer to "I pasted my sequence".
    const file = pastedQueryFile('ACGTACGTAC\nGTACGTACGT');
    expect(file).toBeDefined();
    const text = await read(file!);
    expect(text.startsWith('>')).toBe(true);
    expect(text).toContain('ACGTACGTAC');
  });

  it('leaves FASTA alone', async () => {
    const text = await read(pastedQueryFile('>mine descr\nACGT\n')!);
    expect(text).toBe('>mine descr\nACGT\n');
  });

  it('is searched alongside the uploaded files', () => {
    const files = buildExample();
    const planned = blast.plan(files, { ...blast.defaults, pasted: 'ACGTACGTACGTACGT' });
    if (isPlanError(planned) || planned.kind !== 'dag') throw new Error('want a dag');
    expect(planned.uploads.map((u) => u.name)).toContain(PASTED_FILE);
  });

  it('is enough on its own, with no query file at all', () => {
    const planned = blast.plan(
      { database: buildExample().database, queries: [] },
      { ...blast.defaults, pasted: '>a\nACGT' },
    );
    expect(isPlanError(planned)).toBe(false);
  });
});

describe('what each node of the workflow brings back', () => {
  const files = buildExample();
  const many = {
    database: files.database,
    queries: [
      new File(['>a\nACGT\n'], 'a.fasta', { type: 'text/plain' }),
      new File(['>b\nACGT\n'], 'b.fasta', { type: 'text/plain' }),
      new File(['>c\nACGT\n'], 'c.fasta', { type: 'text/plain' }),
    ],
  };

  function dagOf(input = many) {
    const planned = blast.plan(input, blast.defaults);
    if (isPlanError(planned) || planned.kind !== 'dag') throw new Error('want a dag');
    return planned;
  }

  it('gives every node its own output names, because they share a directory', () => {
    // A DAG's spool is ONE FLAT DIRECTORY and every node runs in it.
    // With a fixed results.json, node q1 lands on top of q0 and the
    // search silently returns one node's worth of hits.
    const subs = Object.entries(dagOf().nodeFiles).filter(([n]) => n.endsWith('.sub'));
    expect(subs).toHaveLength(3);

    const landed = new Set<string>();
    for (const [, body] of subs) {
      const declared = /^transfer_output_files = (.*)$/m.exec(body);
      expect(declared, 'a node that declares no output brings nothing back').not.toBeNull();
      for (const f of declared![1].split(',')) {
        expect(landed.has(f), `two nodes both write ${f}`).toBe(false);
        landed.add(f);
      }
      // stdout and stderr land in the same directory and collide the
      // same way unless they are named per node too.
      expect(body).toMatch(/^output = stdout-q\d+\.txt$/m);
      expect(body).toMatch(/^error = stderr-q\d+\.txt$/m);
    }
    expect(landed.size).toBe(3 * outputFiles('q0').length);
  });

  it('never uses transfer_output_remaps, which DAGMan ignores', () => {
    // It works through condor_submit and is silently dropped when
    // DAGMan submits the file itself -- which is what DAGMan does by
    // default. The attribute lands on the job ad either way, so the
    // only symptom is files coming back under their original names and
    // overwriting each other.
    for (const [, body] of Object.entries(dagOf().nodeFiles)) {
      expect(body).not.toContain('transfer_output_remaps');
    }
  });

  it('creates each output before anything can fail', () => {
    // HTCondor holds a job whose declared output is missing at the
    // end, and holds it for a transfer error that says nothing about
    // what actually went wrong.
    for (const [name, body] of Object.entries(dagOf().nodeFiles)) {
      if (!name.endsWith('.sub')) continue;
      const declared = /^transfer_output_files = (.*)$/m.exec(body)![1].split(',');
      const args = /^arguments = (.*)$/m.exec(body)![1];
      for (const f of declared) expect(args).toContain(`: > ${f}`);
    }
  });

  it('tells each node which queries are its own', () => {
    // ONE runner is spooled for the whole workflow. An earlier version
    // generated it from the FIRST node's spec, so every other node
    // searched a file it had never been given and reported it empty.
    const dag = dagOf();
    const runner = dag.nodeFiles[RUNNER_FILE];
    expect(runner).toContain('BLAST_QUERIES');
    // The one runner must not name any particular query.
    for (const q of ['a.fasta', 'b.fasta', 'c.fasta']) {
      expect(runner).not.toContain(q);
    }

    const assigned = new Set<string>();
    for (const [name, body] of Object.entries(dag.nodeFiles)) {
      if (!name.endsWith('.sub')) continue;
      const env = /^environment = "(.*)"$/m.exec(body);
      expect(env, 'a node with no environment runs the wrong queries').not.toBeNull();
      const queries = /BLAST_QUERIES=(\S*)/.exec(env![1])![1];
      expect(queries).not.toBe('');
      for (const q of queries.split(',')) {
        expect(assigned.has(q), `${q} is searched twice`).toBe(false);
        assigned.add(q);
        // ...and the node has to actually be sent the file it searches.
        expect(body).toContain(q);
      }
    }
    expect([...assigned].sort()).toEqual(['a.fasta', 'b.fasta', 'c.fasta']);
  });

  it('names a node’s outputs after the node, so the page can pair them', () => {
    const dag = dagOf();
    for (const [name, body] of Object.entries(dag.nodeFiles)) {
      if (!name.endsWith('.sub')) continue;
      const node = /BLAST_NODE=(\S+)/.exec(body)![1];
      for (const f of outputFiles(node)) expect(body).toContain(f);
    }
  });
});

describe('what a node job asks the pool for', () => {
  it('asks for exactly the floor when the database is small', () => {
    // A 2 GB slot is the commonest size there is, and a request of
    // 2049 MB does not fit in one. The job is not rejected -- it is
    // never matched, and sits idle with nothing in the log to say why.
    expect(requestMemoryMB(0)).toBe(2048);
    expect(requestMemoryMB(12 * 1024)).toBe(2048);
    expect(requestMemoryMB(500 * 1024 * 1024)).toBe(2048);
  });

  it('grows past the floor once the database is big enough to matter', () => {
    expect(requestMemoryMB(4 * 1024 * 1024 * 1024)).toBeGreaterThan(2048);
    expect(requestMemoryMB(64 * 1024 * 1024 * 1024)).toBe(16384);
  });

  it('asks for what the example data needs, and no more', () => {
    const db = buildExample().database[0];
    // The example has to run on a demo pool, which is two cores and
    // two gigabytes. If this ever exceeds the floor, "use the example
    // data" becomes a job that never starts.
    expect(requestMemoryMB(db.size)).toBe(2048);
  });
});

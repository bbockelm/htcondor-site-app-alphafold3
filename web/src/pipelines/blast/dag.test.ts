import { describe, it, expect } from 'vitest';
import { buildDagFile, buildNodeFiles, planNodes, nodeSubmitName } from './dag';
import { EXIT_NO_BLAST, RUNNER_FILE, buildRunnerScript, type JobSpec } from './blast';
import { blast } from './index';

const base: Omit<JobSpec, 'queryNames' | 'queryBytes' | 'node'> = {
  program: 'blastn',
  evalue: '1e-5',
  maxHits: 25,
  databaseLabel: 'nt.fasta.gz',
  databaseKind: 'fasta-gz',
  databaseFile: 'database.fasta.gz',
  databaseBytes: 100 * 1024 * 1024,
};

/**
 * A File of a stated size. The planner only reads `.size`, and
 * building a real multi-megabyte File per test would make these slow
 * for no added confidence.
 */
function sized(name: string, size: number): File {
  const f = new File([new Uint8Array(1)], name, { type: 'text/plain' });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

describe('planNodes', () => {
  it('puts each query on its own node by default', () => {
    const nodes = planNodes(['a.fa', 'b.fa', 'c.fa'], [1, 2, 3], base, 1);
    expect(nodes).toHaveLength(3);
    expect(nodes.map((n) => n.spec.queryNames)).toEqual([['a.fa'], ['b.fa'], ['c.fa']]);
  });

  it('groups when asked, and carries the bytes for the disk estimate', () => {
    const nodes = planNodes(['a.fa', 'b.fa', 'c.fa'], [10, 20, 30], base, 2);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].spec.queryBytes).toBe(30);
    expect(nodes[1].spec.queryBytes).toBe(30);
  });

  it('gives every node a distinct submit file name', () => {
    const nodes = planNodes(['a.fa', 'b.fa', 'c.fa'], [1, 1, 1], base, 1);
    const names = new Set(nodes.map((n) => n.submitName));
    // The spool is one flat directory: two nodes sharing a submit file
    // name would be one node silently running twice.
    expect(names.size).toBe(nodes.length);
    expect(nodes[1].submitName).toBe(nodeSubmitName(1));
  });
});

describe('the DAG file', () => {
  it('names every node job', () => {
    const nodes = planNodes(['a.fa', 'b.fa'], [1, 1], base, 1);
    const dag = buildDagFile(nodes);
    for (const n of nodes) {
      expect(dag).toContain(`JOB ${n.name} ${n.submitName}`);
    }
  });

  it('writes no edges, because there are none', () => {
    const dag = buildDagFile(planNodes(['a.fa', 'b.fa'], [1, 1], base, 1));
    // Edges that do not exist would claim an ordering the science does
    // not have, and DAGMan would honour it.
    expect(dag).not.toMatch(/^PARENT /m);
  });

  it('does not name the database: it is already in the spool', () => {
    const dag = buildDagFile(planNodes(['a.fa'], [1], base, 1));
    expect(dag).not.toContain('database.fasta.gz\nJOB');
    expect(dag).not.toMatch(/^JOB .*database/m);
  });
});

describe('node submit files', () => {
  it('declares the database by basename, so the spool copy is used', () => {
    const nodes = planNodes(['a.fa'], [1], base, 1);
    const files = buildNodeFiles(nodes);
    const sub = files[nodes[0].submitName];
    expect(sub).toContain('transfer_input_files');
    expect(sub).toContain(base.databaseFile);
    // No path: the spool is flat and DAGMan runs in it.
    expect(sub).not.toContain('/database');
  });

  it('sets no batch name per node', () => {
    // The name belongs on the manager job; per-node it would name the
    // parts rather than the search. And `JobBatchName =` in a submit
    // file sets a macro, not the attribute.
    const nodes = planNodes(['a.fa'], [1], base, 1);
    const sub = buildNodeFiles(nodes)[nodes[0].submitName];
    expect(sub).not.toContain('JobBatchName');
    expect(sub).not.toContain('batch_name');
  });
});

/** The database and the queries are separate slots now. */
function plan(database: File | null, queries: File[], options = blast.defaults) {
  return blast.plan({ database: database ? [database] : [], queries }, options);
}

describe('the plan the shell submits', () => {
  const db = sized('nt.fasta.gz', 50 * 1024 * 1024);
  const q1 = sized('reads1.fa', 1024);
  const q2 = sized('reads2.fa', 2048);

  it('uploads the database exactly once', () => {
    const planned = plan(db, [q1, q2]);
    if (planned.kind !== 'dag') throw new Error(`want a dag, got ${planned.kind}`);
    // The whole reason this pipeline is a DAG. If this ever counts two,
    // the user is pushing the database per job again.
    const dbUploads = planned.uploads.filter((u) => u.file === db);
    expect(dbUploads).toHaveLength(1);
    expect(planned.uploads).toHaveLength(3);
  });

  it('carries the runner and one submit file per query', () => {
    const planned = plan(db, [q1, q2]);
    if (planned.kind !== 'dag') throw new Error('want a dag');
    expect(planned.nodeFiles[RUNNER_FILE]).toContain('#!/bin/bash');
    expect(Object.keys(planned.nodeFiles).filter((n) => n.endsWith('.sub'))).toHaveLength(2);
  });

  it('refuses two queries with the same name', () => {
    // One flat directory. Two files called reads.fa are one file, and
    // one node would silently search the other's sequences.
    const a = sized('reads.fa', 10);
    const b = sized('reads.fa', 20);
    const planned = plan(db, [a, b]);
    expect(planned.kind).toBe('error');
    if (planned.kind === 'error') expect(planned.message).toContain('reads.fa');
  });

  it('refuses a query name that is not safe to transfer', () => {
    const planned = plan(db, [sized('$(evil).fa', 10)]);
    expect(planned.kind).toBe('error');
  });

  it('asks for a database when there is none, by name', () => {
    const planned = plan(null, [q1]);
    expect(planned.kind).toBe('error');
    if (planned.kind === 'error') expect(planned.message).toContain('database');
  });

  it('asks for queries when there are none, by name', () => {
    const planned = plan(db, []);
    expect(planned.kind).toBe('error');
    if (planned.kind === 'error') expect(planned.message).toContain('query');
  });
});


describe('retries', () => {
  it('retries a node, but not the one failure that cannot succeed', () => {
    // "No BLAST+ on the pool" returns the same answer however many
    // times it is asked. Retrying it turns a twenty-second answer into
    // a several-minute one, and the user watches the whole wait.
    const dag = buildDagFile(planNodes(['a.fa'], [1], base, 1));
    expect(dag).toMatch(/^RETRY q0 2 UNLESS-EXIT 70$/m);
  });

  it('uses the same code the runner actually exits with', () => {
    // The DAG line and the runner have to agree. If they drift, the
    // UNLESS-EXIT excuses nothing and nobody notices except as a slow
    // failure.
    const nodes = planNodes(['a.fa'], [1], base, 1);
    expect(buildDagFile(nodes)).toContain(`UNLESS-EXIT ${EXIT_NO_BLAST}`);
    // The runner exits with that code when the tool is missing.
    const runner = buildRunnerScript(nodes[0].spec);
    expect(runner).toMatch(
      new RegExp(`does not have \\$1 installed[^\n]*" ${EXIT_NO_BLAST}$`, 'm'),
    );
  });
});

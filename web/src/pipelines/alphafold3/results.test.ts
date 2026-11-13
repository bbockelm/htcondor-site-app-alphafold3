// Reading a finished workflow's sandbox.
//
// The page has a job id and nothing else -- no record of what was
// submitted, because the queue is the record and a reload loses the
// rest. So everything shown is reconstructed from the small status
// files the nodes wrote, by name.

import { describe, expect, it } from 'vitest';
import { collectRows, stateOf } from './Results';
import { dataStatusFile, inferenceStatusFile } from './af3';

function entry(name: string, body: unknown) {
  return { name, text: typeof body === 'string' ? body : JSON.stringify(body) };
}

const okData = (tag: string) => ({
  schema: 1,
  stage: 'data',
  job: tag,
  status: 'ok',
  message: '',
  exit: 0,
  bytes: 1234,
});

describe('gathering the nodes’ reports', () => {
  it('puts both stages of a job on one row', () => {
    const rows = collectRows([
      entry(dataStatusFile('Job1_a'), okData('Job1_a')),
      entry(inferenceStatusFile('Job1_a'), {
        schema: 1,
        stage: 'inference',
        job: 'Job1_a',
        status: 'ok',
        message: '',
        exit: 0,
        ranking_score: 0.87,
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].data?.status).toBe('ok');
    expect(rows[0].inference?.ranking_score).toBe(0.87);
    expect(stateOf(rows[0])).toEqual({ label: 'structure predicted', ok: true });
  });

  it('orders jobs the way they were numbered, not the way tar did', () => {
    const rows = collectRows(
      ['Job10_j', 'Job2_b', 'Job1_a'].map((t) => entry(dataStatusFile(t), okData(t))),
    );
    expect(rows.map((r) => r.tag)).toEqual(['Job1_a', 'Job2_b', 'Job10_j']);
  });

  it('ignores everything in the sandbox that is not a status file', () => {
    const rows = collectRows([
      entry('stdout-data-Job1_a.txt', 'chatter'),
      entry('Job1_a.data_pipeline.tar.gz', 'binary'),
      entry('alphafold3.dag.dagman.out', 'dagman'),
      entry('align1.sub', 'executable = /usr/bin/env'),
      entry(dataStatusFile('Job1_a'), okData('Job1_a')),
    ]);
    expect(rows.map((r) => r.tag)).toEqual(['Job1_a']);
  });

  it('keeps a job whose status file is unreadable, and says which file', () => {
    // An empty file is what a declared output looks like when the job
    // died before writing it. It is not "no result": it is a result
    // that was lost, and the page should not quietly drop the row.
    const rows = collectRows([entry(dataStatusFile('Job1_a'), '')]);
    expect(rows[0].unreadable).toBe(dataStatusFile('Job1_a'));
    expect(stateOf(rows[0])).toEqual({ label: 'did not run', ok: false });
  });

  it('reports a failed alignment stage as the alignment stage’s failure', () => {
    const rows = collectRows([
      entry(dataStatusFile('Job1_a'), {
        schema: 1,
        stage: 'data',
        job: 'Job1_a',
        status: 'error',
        message: 'AlphaFold3 is not available on the machine that ran this job',
        exit: 70,
      }),
    ]);
    expect(stateOf(rows[0])).toEqual({ label: 'alignments failed', ok: false });
  });

  it('says alignments are done when there was no structure stage', () => {
    // Running without model weights is a real way to use this, not a
    // half-finished run, and it should not read as a failure.
    const rows = collectRows([entry(dataStatusFile('Job1_a'), okData('Job1_a'))]);
    expect(stateOf(rows[0])).toEqual({ label: 'alignments done', ok: true });
  });

  it('is empty when the workflow reported nothing at all', () => {
    expect(collectRows([entry('alphafold3.dag.dagman.out', 'nothing ran')])).toEqual([]);
  });
});

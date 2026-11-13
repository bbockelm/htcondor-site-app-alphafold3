// Planning a whole run: what gets submitted, and what gets refused.
//
// The test worth reading is "every file a node asks for is in the
// workflow". A DAG's spool is written once and nothing can be added to
// it afterwards, so a node that names a file nobody supplied does not
// fail at submission -- it fails an hour later, on an execute node,
// with a missing input. The server's own DAG analyser makes the same
// check and answers with a warning; this one answers with a failing
// test.

import { describe, expect, it } from 'vitest';
import { isPlanError, type DagPlan, type FileSet } from '../types';
import { alphafold3, collectJobs, weightsProblem } from './index';
import { buildExampleCsv } from './example';
import { DATA_RUNNER, INFERENCE_RUNNER, dataTarball, inferenceTarball } from './af3';

const WEIGHTS = '/staging/b/bbockelm/alphafold3/af3.bin.zst';

function manifest(text: string): FileSet {
  return { manifest: [new File([text], 'manifest.csv', { type: 'text/csv' })] };
}

async function planOf(files: FileSet, options: Partial<typeof alphafold3.defaults> = {}) {
  const planned = await alphafold3.plan(files, { ...alphafold3.defaults, ...options });
  if (isPlanError(planned)) throw new Error(`refused: ${planned.message}`);
  return planned as DagPlan;
}

async function refusalOf(files: FileSet, options: Partial<typeof alphafold3.defaults> = {}) {
  const planned = await alphafold3.plan(files, { ...alphafold3.defaults, ...options });
  if (!isPlanError(planned)) throw new Error('expected a refusal');
  return planned.message;
}

const SIMPLE = 'job_name,mol1_type,mol1_chain,mol1_seq\nalpha,protein,A,ACDEFGHIKL\nbeta,protein,A,MNPQRSTVWY\n';

describe('a planned run', () => {
  it('is a DAG, with nothing to upload', () => {
    // Everything this workflow needs is generated here, and the two
    // big things -- the reference databases and the model weights --
    // are read where they already are. The user's uplink carries
    // kilobytes.
    return planOf(manifest(SIMPLE), { weights: WEIGHTS }).then((p) => {
      expect(p.kind).toBe('dag');
      expect(p.uploads).toEqual([]);
      expect(p.batchName.startsWith(alphafold3.batchPrefix)).toBe(true);
    });
  });

  it('carries one fold_input.json per job, and one runner per stage', async () => {
    const p = await planOf(manifest(SIMPLE), { weights: WEIGHTS });
    expect(Object.keys(p.nodeFiles).sort()).toEqual([
      'Job1_alpha.fold_input.json',
      'Job2_beta.fold_input.json',
      DATA_RUNNER,
      INFERENCE_RUNNER,
      'align1.sub',
      'align2.sub',
      'fold1.sub',
      'fold2.sub',
    ].sort());
  });

  it('ships no inference runner when there are no weights', async () => {
    const p = await planOf(manifest(SIMPLE));
    expect(Object.keys(p.nodeFiles)).not.toContain(INFERENCE_RUNNER);
  });

  it('every file a node asks for is in the workflow, or produced by another node', async () => {
    const p = await planOf(manifest(SIMPLE), { weights: WEIGHTS });
    const supplied = new Set(Object.keys(p.nodeFiles));
    for (const u of p.uploads) supplied.add(u.name);
    const produced = new Set<string>();
    for (const [name, body] of Object.entries(p.nodeFiles)) {
      if (!name.endsWith('.sub')) continue;
      for (const f of value(body, 'transfer_output_files').split(',')) produced.add(f.trim());
    }
    for (const [name, body] of Object.entries(p.nodeFiles)) {
      if (!name.endsWith('.sub')) continue;
      for (const raw of value(body, 'transfer_input_files').split(',')) {
        const f = raw.trim();
        // A URL or an absolute path is not ours to stage: the execute
        // node fetches it, or the access point reads it from its own
        // disk when DAGMan submits the node.
        if (f.includes('://') || f.startsWith('/')) continue;
        expect(supplied.has(f) || produced.has(f), `${name} wants ${f}`).toBe(true);
      }
    }
    // ...and the file that crosses the edge really is a produced one.
    expect(produced.has(dataTarball('Job1_alpha'))).toBe(true);
    expect(produced.has(inferenceTarball('Job1_alpha'))).toBe(true);
  });

  it('writes the sequences into the file, never into the submit file', async () => {
    const p = await planOf(manifest(SIMPLE), { weights: WEIGHTS });
    expect(p.nodeFiles['Job1_alpha.fold_input.json']).toContain('"ACDEFGHIKL"');
    for (const [name, body] of Object.entries(p.nodeFiles)) {
      if (name.endsWith('.sub')) expect(body).not.toContain('ACDEFGHIKL');
    }
  });

  it('folds a pasted sequence alongside the manifest', async () => {
    const p = await planOf(manifest(SIMPLE), { pasted: '>extra\nQQQQQQ' });
    expect(Object.keys(p.nodeFiles)).toContain('Job3_extra.fold_input.json');
  });

  it('runs from the box alone', async () => {
    const p = await planOf({ manifest: [] }, { pasted: 'ACDEFGHIKL' });
    expect(Object.keys(p.nodeFiles)).toContain('Job1_pasted_sequence.fold_input.json');
  });
});

describe('what it refuses, and what it says', () => {
  it('asks for sequences when there are none', async () => {
    expect(await refusalOf({ manifest: [] })).toContain('paste one sequence');
  });

  it('repeats the manifest’s own complaints', async () => {
    const message = await refusalOf(manifest('job_name,mol1_type,mol1_chain,mol1_seq\nx,protein,A,ACD3F\n'));
    expect(message).toContain('residue letter');
  });

  it('refuses a weights location that is not one', async () => {
    for (const bad of [
      'af3.bin.zst',
      '/staging/$(Cluster)/af3.bin.zst',
      '/staging/a,b',
      // A directory, not a file: with a trailing slash HTCondor
      // transfers the contents and the job never sees the name it was
      // told to look for.
      '/staging/b/bbockelm/alphafold3/',
    ]) {
      expect(await refusalOf(manifest(SIMPLE), { weights: bad }), bad).toContain(
        'model weights location',
      );
    }
    expect(weightsProblem('/staging/b/weights%20v2')).toContain('file name');
    expect(weightsProblem('')).toBeUndefined();
  });

  it('refuses a complex no GPU here could hold', async () => {
    const huge = `job_name,mol1_type,mol1_chain,mol1_seq\nenormous,protein,A,${'A'.repeat(9000)}\n`;
    expect(await refusalOf(manifest(huge))).toContain('facilitator');
  });

  it('refuses a second job with the same name', async () => {
    const twice = 'job_name,mol1_type,mol1_chain,mol1_seq\nalpha,protein,A,ACDE\nalpha,protein,A,ACDE\n';
    expect(await refusalOf(manifest(twice))).toContain('already a job');
  });

  it('gives every job a name of its own even when two rows agree', () => {
    // The manifest and the box are read separately and numbered in one
    // sequence, so the same name in both is two different jobs rather
    // than one overwriting the other in the flat directory.
    const { jobs, problems } = collectJobs(SIMPLE, '>alpha\nQQQQ');
    expect(problems).toEqual([]);
    expect(jobs.map((j) => j.tag)).toEqual(['Job1_alpha', 'Job2_beta', 'Job3_alpha']);
    expect(new Set(jobs.map((j) => j.tag)).size).toBe(jobs.length);
  });

  it('refuses a manifest that is not a manifest', async () => {
    const big = new File(['x'.repeat(5 * 1024 * 1024)], 'huge.csv');
    expect(await refusalOf({ manifest: [big] })).toContain('too large');
  });
});

describe('the example data', () => {
  it('plans, and is the alignment stage only', async () => {
    const p = await planOf(alphafold3.example!.build());
    expect(Object.keys(p.nodeFiles)).toContain('Job1_ubiquitin.fold_input.json');
    expect(Object.keys(p.nodeFiles)).toContain('Job2_ubiquitin_with_ATP.fold_input.json');
    expect(p.dagFile).not.toContain('PARENT');
  });

  it('becomes a two-stage workflow as soon as there are weights', async () => {
    const p = await planOf(alphafold3.example!.build(), { weights: WEIGHTS });
    expect(p.dagFile).toContain('PARENT align1 CHILD fold1');
  });

  it('is a manifest the parser accepts', () => {
    const { jobs, problems } = collectJobs(buildExampleCsv(), '');
    expect(problems).toEqual([]);
    expect(jobs.map((j) => j.molecules.length)).toEqual([1, 2]);
  });
});

/** The value of one submit command. */
function value(submit: string, key: string): string {
  const line = submit.split('\n').find((l) => l.toLowerCase().startsWith(`${key} =`));
  return line ? line.slice(line.indexOf('=') + 1).trim() : '';
}

// The oracle test: does this app write the same fold_input.json as the
// tutorial's own script?
//
// The files under __fixtures__/upstream/ were not written by hand and
// are not an expectation of what the code does. They are the actual
// output of running scripts/generate-job-directories.py from
// osg-htc/tutorial-OSPool-AF3 over __fixtures__/manifest.csv:
//
//   python3 -I generate-job-directories.py \
//     --manifest manifest.csv --output_dir out
//
// AlphaFold3 reads this file. A difference between the tutorial's
// output and this app's is a difference in the science -- a chain
// written as a string where it should be a list, a ligand in the wrong
// shape, a token count that asks for the wrong GPU -- and none of
// those would fail loudly. They would come back as a structure of
// something slightly other than what was asked for.
//
// Regenerate the fixtures (not casually) by re-running the upstream
// script over the same manifest.

import { describe, expect, it } from 'vitest';
import manifestCsv from './__fixtures__/manifest.csv?raw';
import inferenceJobs from './__fixtures__/upstream/inference_jobs.txt?raw';
import job1 from './__fixtures__/upstream/Job1_solo_protein.json?raw';
import job2 from './__fixtures__/upstream/Job2_protein_rna.json?raw';
import job3 from './__fixtures__/upstream/Job3_tetramer.json?raw';
import job4 from './__fixtures__/upstream/Job4_with_smiles.json?raw';
import job5 from './__fixtures__/upstream/Job5_with_ccd.json?raw';
import job6 from './__fixtures__/upstream/Job6_big_protein.json?raw';
import job7 from './__fixtures__/upstream/Job7_big_tetramer.json?raw';
import { jobsFromCsv } from './manifest';
import {
  MIN_VRAM_GB,
  chainIds,
  countTokens,
  estimateVramGB,
  foldInputJson,
  moleculeBlock,
  requestedVramGB,
  seedList,
} from './foldinput';

const UPSTREAM: Record<string, string> = {
  Job1_solo_protein: job1,
  Job2_protein_rna: job2,
  Job3_tetramer: job3,
  Job4_with_smiles: job4,
  Job5_with_ccd: job5,
  Job6_big_protein: job6,
  // 195 residues over four chains: 780 tokens, which is the one
  // fixture whose GPU request moves if either the per-chain
  // multiplication or the constants in the estimate are disturbed.
  Job7_big_tetramer: job7,
};

const parsed = jobsFromCsv(manifestCsv);

describe('fold_input.json, against the tutorial script that wrote it', () => {
  it('reads every row of the manifest the upstream script read', () => {
    expect(parsed.problems).toEqual([]);
    expect(parsed.jobs.map((j) => j.tag)).toEqual(Object.keys(UPSTREAM));
  });

  it.each(Object.keys(UPSTREAM))('writes %s byte for byte as upstream does', (tag) => {
    const job = parsed.jobs.find((j) => j.tag === tag)!;
    // One seed is the upstream default (--seed 1).
    expect(foldInputJson(job, seedList(1))).toBe(UPSTREAM[tag]);
  });

  it('asks for the same GPU memory as upstream computed', () => {
    // list_of_af3_inference_jobs.txt is `<job dir>,<GB>` per line, and
    // the GB column is what the submit file puts in
    // gpus_minimum_memory. Getting this wrong is not an error: it is a
    // job that matches a GPU too small for it and dies hours later, or
    // one that never matches at all.
    const expected = inferenceJobs
      .trim()
      .split('\n')
      .map((line) => line.split(','));
    expect(expected.length).toBe(parsed.jobs.length);
    for (const [tag, gb] of expected) {
      const job = parsed.jobs.find((j) => j.tag === tag)!;
      expect(`${tag}:${requestedVramGB(countTokens(job.molecules))}`).toBe(`${tag}:${Number(gb)}`);
    }
  });

  it('covers both sides of the GPU memory floor', () => {
    // A fixture where every job lands on the floor would pass against a
    // requestedVramGB that ignored tokens entirely.
    const gb = parsed.jobs.map((j) => requestedVramGB(countTokens(j.molecules)));
    expect(gb.some((g) => g === MIN_VRAM_GB)).toBe(true);
    expect(gb.some((g) => g > MIN_VRAM_GB)).toBe(true);
  });
});

describe('the pieces the oracle depends on', () => {
  it('writes one chain as a string and several as a list', () => {
    // Not cosmetic: AlphaFold3 reads `id` both ways, and the token
    // count multiplies by the number of chains. A four-chain complex
    // written as the string "A|B|C|D" would be one chain of a sequence
    // nothing can fold.
    expect(chainIds('A')).toBe('A');
    expect(chainIds('A|B|C|D')).toEqual(['A', 'B', 'C', 'D']);
    expect(chainIds(' A | B ')).toEqual(['A', 'B']);
  });

  it('counts a multi-chain sequence once per chain', () => {
    const one = countTokens([{ type: 'protein', chain: 'A', sequence: 'ACDEFGHIKL' }]);
    const four = countTokens([{ type: 'protein', chain: 'A|B|C|D', sequence: 'ACDEFGHIKL' }]);
    expect(one).toBe(10);
    expect(four).toBe(40);
  });

  it('counts ligands as nothing, the way upstream does', () => {
    expect(countTokens([{ type: 'smiles', chain: 'K', sequence: 'CC(=O)O' }])).toBe(0);
    expect(countTokens([{ type: 'ccdCodes', chain: 'G|H', sequence: 'ATP|ADP' }])).toBe(0);
  });

  it('puts a ligand under `ligand`, not under its own type', () => {
    expect(moleculeBlock({ type: 'smiles', chain: 'K', sequence: 'CC(=O)O' })).toEqual({
      ligand: { id: 'K', smiles: 'CC(=O)O' },
    });
    expect(moleculeBlock({ type: 'ccdCodes', chain: 'G|H', sequence: 'ATP | ADP' })).toEqual({
      ligand: { id: ['G', 'H'], ccdCodes: ['ATP', 'ADP'] },
    });
  });

  it('keeps the floor reachable', () => {
    // The template's AGENTS.md calls out a dead max(): one whose first
    // argument can never be chosen. This one is chosen for anything
    // small, which is most of what people try first.
    expect(estimateVramGB(76)).toBe(0);
    expect(requestedVramGB(76)).toBe(MIN_VRAM_GB);
    expect(requestedVramGB(0)).toBe(MIN_VRAM_GB);
    // ...and not chosen once the job is big enough to need more.
    expect(requestedVramGB(3000)).toBeGreaterThan(MIN_VRAM_GB);
    // A number, not the formula restated: an expectation computed the
    // same way as the thing it checks agrees with any change to it.
    expect(requestedVramGB(3000)).toBe(50);
    expect(requestedVramGB(780)).toBe(10);
  });

  it('rounds the estimate UP, never to the nearest', () => {
    // 798 tokens estimates 10.2 GB. Rounded to nearest that is 10, and
    // a job given 10 GB when it wanted 10.2 does not run slowly: it
    // runs out of GPU memory, hours in, having waited for the GPU.
    // Upstream uses math.ceil and so does this.
    expect(estimateVramGB(798)).toBeCloseTo(10.202, 3);
    expect(requestedVramGB(798)).toBe(11);
  });

  it('turns a count of predictions into the seeds upstream uses', () => {
    expect(seedList(1)).toEqual([1]);
    expect(seedList(3)).toEqual([1, 2, 3]);
    expect(seedList(0)).toEqual([1]);
    expect(seedList(99)).toEqual([1, 2, 3, 4, 5]);
  });

  it('puts the seeds it was given into the file', () => {
    const job = parsed.jobs[0];
    expect(foldInputJson(job, seedList(3))).toContain('"modelSeeds": [\n    1,\n    2,\n    3\n  ]');
  });
});

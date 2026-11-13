import { describe, expect, it } from 'vitest';
import { EXIT_NO_AF3, type RunSpec } from './af3';
import { buildDagFile, buildNodeFiles, dataNodeName, inferenceNodeName, planNodes } from './dag';
import { NONE } from './site';

const JOBS = [
  { index: 1, tag: 'Job1_alpha', tokens: 100 },
  { index: 2, tag: 'Job2_beta', tokens: 2000 },
];

function dag(weights: string): string {
  const spec: RunSpec = { site: NONE, weights };
  return buildDagFile(JOBS, planNodes(spec, JOBS));
}

describe('the workflow graph', () => {
  const withWeights = dag('/staging/me/af3.bin.zst');

  it('is two nodes per job: alignments, then the structure', () => {
    expect(withWeights).toContain(`JOB ${dataNodeName(1)} align1.sub`);
    expect(withWeights).toContain(`JOB ${inferenceNodeName(1)} fold1.sub`);
    expect(withWeights).toContain(`JOB ${dataNodeName(2)} align2.sub`);
    expect(withWeights).toContain(`JOB ${inferenceNodeName(2)} fold2.sub`);
  });

  it('makes each structure wait for its OWN alignments and no one else’s', () => {
    // This is the edge the whole app is shaped around: the file that
    // crosses it is written into the workflow's directory by the
    // parent and read from there by the child. Two proteins have
    // nothing to do with each other, so there is no edge between
    // them -- writing one would serialise the run for no reason.
    const edges = withWeights.split('\n').filter((l) => l.startsWith('PARENT'));
    expect(edges).toEqual(['PARENT align1 CHILD fold1', 'PARENT align2 CHILD fold2']);
  });

  it('retries, except the failure that cannot be retried', () => {
    // An evicted job deserves another go. "This machine has no
    // AlphaFold3 on it" returns the same answer however many times it
    // is asked, and UNLESS-EXIT takes exactly one code, which is why
    // the runners spend one on precisely that case.
    for (const node of ['align1', 'fold1', 'align2', 'fold2']) {
      expect(withWeights).toContain(`RETRY ${node} 2 UNLESS-EXIT ${EXIT_NO_AF3}`);
    }
  });

  it('is the alignment stage alone when there are no model weights', () => {
    const alignOnly = dag('');
    expect(alignOnly).toContain('JOB align1 align1.sub');
    expect(alignOnly).not.toContain('fold1');
    expect(alignOnly).not.toContain('PARENT');
  });

  it('names nodes from the job index, not from the user’s job name', () => {
    // A DAG node name is a different grammar from a file name, and the
    // index is the part that is certainly a word.
    const odd = [{ index: 1, tag: 'Job1_a.b-c', tokens: 10 }];
    const text = buildDagFile(odd, planNodes({ site: NONE, weights: 'x' }, odd));
    expect(text).toContain('JOB align1 align1.sub');
    expect(text).not.toContain('Job1_a.b-c');
  });
});

describe('the node submit files', () => {
  const spec: RunSpec = { site: NONE, weights: '/staging/me/af3.bin.zst' };
  const files = buildNodeFiles(JOBS, planNodes(spec, JOBS));

  it('is one file per node, under the name the DAG uses', () => {
    expect(Object.keys(files).sort()).toEqual([
      'align1.sub',
      'align2.sub',
      'fold1.sub',
      'fold2.sub',
    ]);
  });

  it('gives each node its own job, not the first one’s', () => {
    expect(files['align2.sub']).toContain('AF3_TAG=Job2_beta');
    expect(files['align2.sub']).not.toContain('Job1_alpha');
  });

  it('sizes each structure job from its own molecule', () => {
    // 100 tokens lands on the floor; 2000 does not. One value shared
    // between the two would be wrong for both.
    expect(files['fold1.sub']).toContain('gpus_minimum_memory = 7 GB');
    expect(files['fold2.sub']).toContain('gpus_minimum_memory = 32 GB');
  });

  it('writes no inference submit file when there are no weights', () => {
    const alignOnly = buildNodeFiles(JOBS, planNodes({ site: NONE, weights: '' }, JOBS));
    expect(Object.keys(alignOnly).sort()).toEqual(['align1.sub', 'align2.sub']);
  });
});

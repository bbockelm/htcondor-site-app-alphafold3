import { describe, it, expect } from 'vitest';
import { PIPELINES, ownJobsConstraint, pipelineForJob } from './index';
import { isPlanError } from './types';

/**
 * The batch name a pipeline actually produces, taken from a real plan
 * of its own example data rather than from a constant.
 *
 * Reading it off the plan is the point. The bug these tests exist for
 * was that two pipelines stamped the time into their batch names while
 * the shell matched on the pipeline id, so a constant in a test would
 * have agreed with the shell and the queue would still have been
 * empty.
 */
function batchNameOf(pipeline: (typeof PIPELINES)[number]): string {
  const ex = pipeline.example;
  if (!ex) throw new Error(`${pipeline.id} has no example to plan`);
  const planned = pipeline.plan(ex.build(), { ...pipeline.defaults, ...ex.options });
  if (isPlanError(planned)) {
    throw new Error(`${pipeline.id} refused its own example: ${planned.message}`);
  }
  return planned.batchName;
}

describe('finding this app’s own jobs again', () => {
  it.each(PIPELINES.map((p) => [p.id, p] as const))(
    'resolves a %s job back to its pipeline from the batch name it really submits',
    (_id, pipeline) => {
      expect(pipelineForJob(batchNameOf(pipeline))).toBe(pipeline);
    },
  );

  it('matches on a prefix, not the whole name', () => {
    // Two of the three pipelines append a timestamp so one run can be
    // told from another. Equality against the pipeline id matched
    // neither, and their jobs never appeared in "Your runs" -- with no
    // error anywhere, because an empty list is a valid answer.
    const stamped = PIPELINES.filter((p) => batchNameOf(p) !== p.batchPrefix);
    expect(stamped.length).toBeGreaterThan(0);
    for (const p of stamped) {
      expect(batchNameOf(p)).not.toBe(p.id);
      expect(pipelineForJob(batchNameOf(p))).toBe(p);
    }
  });

  it('claims no job it did not submit', () => {
    expect(pipelineForJob('someone-elses-run')).toBeUndefined();
    expect(pipelineForJob(undefined)).toBeUndefined();
    expect(pipelineForJob(42)).toBeUndefined();
    expect(pipelineForJob('')).toBeUndefined();
  });

  it('builds a constraint whose prefix lengths match the prefixes', () => {
    // substr(JobBatchName, 0, N) == "prefix" is only a prefix test
    // while N is the prefix's length. A stale N silently matches
    // nothing, which looks exactly like having no jobs.
    const constraint = ownJobsConstraint();
    for (const p of PIPELINES) {
      expect(constraint).toContain(
        `substr(JobBatchName, 0, ${p.batchPrefix.length}) == "${p.batchPrefix}"`,
      );
    }
    expect(constraint.split('||')).toHaveLength(PIPELINES.length);
  });

  it('gives every pipeline a prefix no other pipeline’s name starts with', () => {
    // Overlapping prefixes would attribute one pipeline's jobs to
    // another, and the shell would render the wrong results view under
    // a finished job.
    for (const a of PIPELINES) {
      for (const b of PIPELINES) {
        if (a === b) continue;
        expect(batchNameOf(a).startsWith(b.batchPrefix)).toBe(false);
      }
    }
  });
});

describe('every pipeline is wired up', () => {
  it.each(PIPELINES.map((p) => [p.id, p] as const))(
    '%s declares slots, a prefix and a results view',
    (_id, p) => {
      expect(p.inputs.length).toBeGreaterThan(0);
      expect(new Set(p.inputs.map((s) => s.id)).size).toBe(p.inputs.length);
      expect(p.batchPrefix).not.toBe('');
      expect(typeof p.Results).toBe('function');
    },
  );

  it.each(PIPELINES.map((p) => [p.id, p] as const))(
    '%s plans its own example data without complaint',
    (_id, p) => {
      const ex = p.example;
      expect(ex, `${p.id} ships no example data`).toBeDefined();
      const files = ex!.build();
      // Every declared slot the example fills must be a slot that
      // exists: a typo here is example data that silently lands
      // nowhere and a planner that then says "choose a file".
      for (const slot of Object.keys(files)) {
        expect(p.inputs.map((s) => s.id)).toContain(slot);
      }
      const planned = p.plan(files, { ...p.defaults, ...ex!.options });
      expect(isPlanError(planned) ? planned.message : '').toBe('');
    },
  );
});

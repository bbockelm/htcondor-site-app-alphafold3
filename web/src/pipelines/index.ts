// The pipelines this app offers.
//
// One: AlphaFold3. The template this repository came from shipped
// three worked examples (a word count, FITS previews, a BLAST search)
// and they have been deleted, which is what the template tells you to
// do -- their lessons are quoted where they apply in
// pipelines/alphafold3/.
//
// Adding another is adding a directory and a line below. Nothing on
// the server knows which pipelines exist, so the queue keeps whatever
// is already running either way.

import type { Pipeline } from './types';
import { alphafold3 } from './alphafold3';

/**
 * A pipeline whose options type is its own business.
 *
 * Each pipeline parameterises Pipeline<O> with whatever it keeps, and
 * the shell holds that value without looking inside.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPipeline = Pipeline<any>;

export const PIPELINES: AnyPipeline[] = [alphafold3];

export function pipelineById(id: string): AnyPipeline | undefined {
  return PIPELINES.find((p) => p.id === id);
}

/**
 * Which pipeline produced a job, from its batch name.
 *
 * A PREFIX match. The batch name has the time stamped into it so one
 * run can be told from another, so the name on the job is
 * `alphafold3-20260112031400` and not `alphafold3`. An earlier version
 * of this shell compared the whole name against the pipeline id; it
 * matched nothing, and the jobs never appeared in the list at all.
 */
export function pipelineForJob(batchName: unknown): AnyPipeline | undefined {
  const name = typeof batchName === 'string' ? batchName : '';
  return PIPELINES.find((p) => name.startsWith(p.batchPrefix));
}

/**
 * A queue constraint matching every job this app submitted.
 *
 * `substr` rather than `regexp`: the prefix contains a dash, which is
 * harmless in a regex, but the next person to add a pipeline will use
 * a dot or a plus and find that it silently matches more than they
 * meant. A prefix comparison cannot do that.
 */
export function ownJobsConstraint(): string {
  return PIPELINES.map(
    (p) => `substr(JobBatchName, 0, ${p.batchPrefix.length}) == "${p.batchPrefix}"`,
  ).join(' || ');
}

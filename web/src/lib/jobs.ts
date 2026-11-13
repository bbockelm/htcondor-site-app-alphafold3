// Putting the queue in an order.
//
// `GET /jobs` promises no order. It is a ClassAd query against the
// schedd, and the schedd hands back whatever its own structures hand
// back -- which is not sorted, and is not even the SAME from one call
// to the next. The app polls every five seconds, so an unsorted list
// is a list whose rows swap places under the user's cursor while they
// are reading it. That is what a site reported: "sometimes jobs bounce
// to a different order".
//
// So the order is decided here and not by the server. Newest run
// first, because the thing somebody just submitted is the thing they
// are waiting for, and it must not be below a week of history.
//
// The comparison is a TOTAL order on the fields it uses: no two
// distinct jobs compare equal, so the result does not depend on the
// order the server happened to send. A comparator that left ties
// (sorting on QDate alone, say) would still shuffle procs within a
// cluster, because Array.prototype.sort's stability preserves an input
// order that is itself arbitrary.

import type { Job } from './api';

/** `QDate` as a number. A job without one sorts oldest. */
function queuedAt(j: Job): number {
  return typeof j.QDate === 'number' && Number.isFinite(j.QDate) ? j.QDate : 0;
}

/**
 * The queue, newest run first.
 *
 * `QDate` is when the job was queued, which is the one timestamp the
 * projection in api.ts already asks for. Ties -- every proc of one
 * cluster shares a QDate, and two submissions in the same second are
 * ordinary -- break on the cluster (newest first) and then on the proc
 * (in the order they were queued, which is the order the user gave
 * their files in).
 *
 * Returns a new array; the input is not touched.
 */
export function sortJobs(jobs: Job[]): Job[] {
  return [...jobs].sort(
    (a, b) =>
      queuedAt(b) - queuedAt(a) || b.ClusterId - a.ClusterId || a.ProcId - b.ProcId,
  );
}

/**
 * How far a workflow has got, for the one row that represents it.
 *
 * "Your runs" lists one row per submission, so a DAG appears as its
 * manager job and its nodes do not appear at all -- see
 * ownJobsConstraint. That is the right list, and on its own it is a
 * row that says "Running" for an hour with nothing to show whether
 * forty searches are finished or none are. DAGMan already counts, on
 * the manager job; this reads its counters.
 *
 * Returns null for anything that is not a workflow, which is every
 * job that was submitted straight to the queue.
 */
export function dagProgress(job: Job): string | null {
  const total = job.DAG_NodesTotal;
  if (typeof total !== 'number' || total <= 0) return null;
  const done = typeof job.DAG_NodesDone === 'number' ? job.DAG_NodesDone : 0;
  const failed = typeof job.DAG_NodesFailed === 'number' ? job.DAG_NodesFailed : 0;
  const steps = `${done} of ${total} ${total === 1 ? 'step' : 'steps'} done`;
  // Failures are named here rather than left to the results view: a
  // workflow that keeps running after a node fails is still "Running",
  // and the count is the only sign on this page that something went
  // wrong while it did.
  return failed > 0 ? `${steps}, ${failed} failed` : steps;
}

import { describe, it, expect, vi, afterEach } from 'vitest';
import { sortJobs, dagProgress, ageOf, isActive } from './jobs';
import { api, JobStatus, JOB_ATTRS, type Job } from './api';

/**
 * A queue in a deliberately wrong order.
 *
 * Shuffled on purpose, and shuffled DIFFERENTLY from the answer: the
 * bug being pinned is that the app rendered whatever order the server
 * sent, and a fixture that happens to arrive sorted would pass against
 * no sorting at all.
 */
function queue(): Job[] {
  return [
    { ClusterId: 7, ProcId: 1, JobStatus: 1, QDate: 1000 },
    { ClusterId: 9, ProcId: 0, JobStatus: 2, QDate: 3000 },
    { ClusterId: 7, ProcId: 0, JobStatus: 1, QDate: 1000 },
    { ClusterId: 8, ProcId: 0, JobStatus: 4, QDate: 2000 },
    { ClusterId: 7, ProcId: 2, JobStatus: 1, QDate: 1000 },
  ];
}

function ids(jobs: Job[]): string[] {
  return jobs.map((j) => `${j.ClusterId}.${j.ProcId}`);
}

describe('the order the job list is drawn in', () => {
  it('puts the newest run first', () => {
    expect(ids(sortJobs(queue()))).toEqual(['9.0', '8.0', '7.0', '7.1', '7.2']);
  });

  it('gives the same order whatever order the server sent', () => {
    // The schedd promises no order and does not have a stable one, so
    // this is the whole bug: the list polled every five seconds and
    // rows swapped places while the user read them.
    const answer = ids(sortJobs(queue()));
    const shuffles = [
      [4, 2, 0, 3, 1],
      [1, 0, 4, 2, 3],
      [3, 4, 1, 0, 2],
      [0, 1, 2, 3, 4],
      [4, 3, 2, 1, 0],
    ];
    for (const order of shuffles) {
      const shuffled = order.map((i) => queue()[i]);
      expect(ids(sortJobs(shuffled))).toEqual(answer);
    }
  });

  it('keeps one cluster’s procs in the order they were queued', () => {
    // Every proc of a cluster shares a QDate, so sorting on QDate
    // alone leaves them tied -- and a tie is resolved by the input
    // order, which is exactly the arbitrary thing being removed.
    const sorted = sortJobs(queue());
    expect(ids(sorted).slice(2)).toEqual(['7.0', '7.1', '7.2']);
  });

  it('sorts a job with no QDate last rather than dropping it', () => {
    const sorted = sortJobs([
      { ClusterId: 1, ProcId: 0, JobStatus: 1 },
      { ClusterId: 2, ProcId: 0, JobStatus: 1, QDate: 5 },
    ]);
    expect(ids(sorted)).toEqual(['2.0', '1.0']);
  });

  it('does not reorder the array it was given', () => {
    const original = queue();
    sortJobs(original);
    expect(ids(original)).toEqual(ids(queue()));
  });
});

describe('api.jobs', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sorts what the server returned, so no caller has to remember to', () => {
    // At the edge rather than in the component: a second page reading
    // the queue would otherwise get the raw order back.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ jobs: queue() }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      ),
    );
    return api.jobs().then((jobs) => {
      expect(ids(jobs)).toEqual(['9.0', '8.0', '7.0', '7.1', '7.2']);
    });
  });
});

describe('what a workflow row says about itself', () => {
  /** A manager job as DAGMan publishes it. */
  function dag(counts: Partial<Job>): Job {
    return { ClusterId: 5, ProcId: 0, JobStatus: 2, QDate: 1000, ...counts };
  }

  it('counts the finished nodes, because the nodes have no rows of their own', () => {
    expect(dagProgress(dag({ DAG_NodesTotal: 12, DAG_NodesDone: 3 }))).toBe(
      '3 of 12 steps done',
    );
  });

  it('names failures: a DAG keeps running after one, and still reads "Running"', () => {
    expect(
      dagProgress(dag({ DAG_NodesTotal: 12, DAG_NodesDone: 3, DAG_NodesFailed: 1 })),
    ).toBe('3 of 12 steps done, 1 failed');
  });

  it('treats a missing count as none done rather than as NaN', () => {
    // DAGMan publishes these as it goes; the manager job exists before
    // it has written any of them.
    expect(dagProgress(dag({ DAG_NodesTotal: 4 }))).toBe('0 of 4 steps done');
  });

  it('is null for an ordinary job, which is every job that is not a DAG', () => {
    expect(dagProgress(dag({}))).toBeNull();
    expect(dagProgress(dag({ DAG_NodesTotal: 0 }))).toBeNull();
  });

  it('asks for the counters it reads', () => {
    // A projection that does not name them returns undefined for all
    // four, which renders as no progress at all rather than failing.
    for (const a of ['DAG_NodesTotal', 'DAG_NodesDone', 'DAG_NodesFailed']) {
      expect(JOB_ATTRS as readonly string[]).toContain(a);
    }
  });
});

describe('how old a run is', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  const at = (iso: string): Job => ({
    ClusterId: 1,
    ProcId: 0,
    JobStatus: 2,
    QDate: Math.floor(Date.parse(iso) / 1000),
  });

  it('reads QDate as SECONDS, which is what the schedd stores', () => {
    // Treating it as milliseconds dates every job to January 1970 and
    // every row reads "20331d ago" -- which is the kind of wrong that
    // looks like a backend problem.
    expect(ageOf(at('2026-11-13T11:30:00Z'), now)).toBe('30m ago');
  });

  it('says it in the words the console uses', () => {
    expect(ageOf(at('2026-11-13T11:59:57Z'), now)).toBe('just now');
    expect(ageOf(at('2026-11-13T11:59:15Z'), now)).toBe('45s ago');
    expect(ageOf(at('2026-11-13T09:00:00Z'), now)).toBe('3h ago');
    expect(ageOf(at('2026-11-11T12:00:00Z'), now)).toBe('2d ago');
  });

  it('never counts backwards when a clock disagrees', () => {
    // The schedd's clock and the browser's are two clocks. A job
    // queued "in the future" is a skew, not a negative age.
    expect(ageOf(at('2026-11-13T12:00:30Z'), now)).toBe('just now');
  });

  it('says nothing at all when there is no QDate', () => {
    expect(ageOf({ ClusterId: 1, ProcId: 0, JobStatus: 2 }, now)).toBe('');
    expect(ageOf({ ClusterId: 1, ProcId: 0, JobStatus: 2, QDate: 0 }, now)).toBe('');
  });
});

describe('which jobs are still doing something', () => {
  const withStatus = (s: number): Job => ({ ClusterId: 1, ProcId: 0, JobStatus: s });

  it('counts transferring as busy, because its output is still moving', () => {
    // Removing a job mid-transfer throws away the results it is in the
    // middle of bringing back.
    expect(isActive(withStatus(JobStatus.Transferring))).toBe(true);
    expect(isActive(withStatus(JobStatus.Idle))).toBe(true);
    expect(isActive(withStatus(JobStatus.Running))).toBe(true);
  });

  it('counts finished, held and removed as done', () => {
    expect(isActive(withStatus(JobStatus.Completed))).toBe(false);
    expect(isActive(withStatus(JobStatus.Held))).toBe(false);
    expect(isActive(withStatus(JobStatus.Removed))).toBe(false);
  });
});

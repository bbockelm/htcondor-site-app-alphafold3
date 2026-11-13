import { describe, it, expect, vi, afterEach } from 'vitest';
import { sortJobs } from './jobs';
import { api, type Job } from './api';

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

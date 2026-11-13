// What a BLAST search found, across every node of the workflow.
//
// The job in the list is the DAG MANAGER, not a search. It has no hits
// of its own; what it has is the output sandbox every node wrote into,
// so this reads that sandbox and picks out the results files by name.
// lib/tar.ts explains why it is read as an archive rather than file by
// file, and why the two tidier-looking alternatives do not work.
//
// Each node's results file is written by the runner on EVERY path,
// including every failure, so a node that could not search explains
// itself here rather than appearing as an empty table.

import { useEffect, useState } from 'react';
import { ApiError, api, type Job } from '../../lib/api';
import { entryText, readTar } from '../../lib/tar';
import { RESULTS_PREFIX } from './blast';

interface Hit {
  query_file: string;
  query: string;
  subject: string;
  identity: number;
  length: number;
  evalue: string;
  bits: number;
}

interface NodeResult {
  status: string;
  message: string;
  program: string;
  database: string;
  evalue: string;
  total_hits: number;
  queries: { file: string; status: string; hits: number }[];
  top_hits: Hit[];
  top_hits_truncated: boolean;
}

/** One node's results file, once we have tried to read it. */
interface Loaded {
  /** The file it came out of, e.g. results-q0.json. */
  file: string;
  result?: NodeResult;
  /** Why this file had no usable result. Not the same as "no hits". */
  problem?: string;
}

/** How many rows the merged table shows before it is cut off. */
const SHOWN = 100;

/** The node name a results file belongs to, for its hits file. */
function hitsFileFor(resultsFile: string): string {
  return resultsFile.replace(/^results-/, 'hits-').replace(/\.json$/, '.tsv');
}

export function Results({ job }: { job: Job }) {
  const id = `${job.ClusterId}.${job.ProcId}`;
  const [nodes, setNodes] = useState<Loaded[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setNodes(null);
    setError(null);

    void (async () => {
      let found: Loaded[];
      try {
        const entries = readTar(await api.outputArchive(id));
        found = entries
          .filter((e) => e.name.startsWith(RESULTS_PREFIX) && e.name.endsWith('.json'))
          // Sorted by name, so q0 comes before q1 and the order on the
          // page is the order the queries were given in.
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
          .map((e) => {
            const text = entryText(e);
            if (!text.trim()) {
              return { file: e.name, problem: 'this part of the search produced an empty file' };
            }
            try {
              return { file: e.name, result: JSON.parse(text) as NodeResult };
            } catch (err) {
              return { file: e.name, problem: err instanceof Error ? err.message : String(err) };
            }
          });
      } catch (e) {
        if (live) setError(describe(e));
        return;
      }
      if (live) setNodes(found);
    })();

    return () => {
      live = false;
    };
  }, [id]);

  if (error) {
    return (
      <p className="notice error" role="alert" data-testid="blast-results-error">
        The results for this search could not be read: {error}. The files are still available from
        the download link above.
      </p>
    );
  }
  if (!nodes) return <p className="meta">Reading results…</p>;

  if (nodes.length === 0) {
    // A workflow that produced no results file at all. DAGMan's own
    // logs came back and they are where the reason is, so say that
    // rather than drawing an empty table.
    return (
      <p className="notice error" role="alert" data-testid="blast-no-results">
        This search finished without producing any results. That usually means the workflow could
        not start its jobs; the files from the download link above include DAGMan’s log, which says
        why.
      </p>
    );
  }

  const done = nodes.filter((n) => n.result);
  const first = done[0]?.result;
  const totalHits = done.reduce((n, x) => n + (x.result?.total_hits ?? 0), 0);
  // Best first, across every node. The runner sorted within a node;
  // merging them means sorting again, and the value is a string in the
  // JSON because BLAST writes e-values like 3e-180.
  const hits = done
    .flatMap((n) => n.result?.top_hits ?? [])
    .sort((a, b) => Number(a.evalue) - Number(b.evalue));
  const shown = hits.slice(0, SHOWN);

  return (
    <div data-testid="blast-results">
      <p>
        {first?.program ?? 'blast'} against {first?.database ?? 'the database'}
        {first?.evalue ? `, E ≤ ${first.evalue}` : ''}: <strong>{totalHits}</strong> hits across{' '}
        {nodes.length} {nodes.length === 1 ? 'search' : 'searches'}.
      </p>

      {/* Each node's own words. For a failure this is the whole
          explanation, so it goes above the table rather than under it. */}
      {done
        .filter((n) => n.result && n.result.status !== 'ok')
        .map((n) => (
          <p className="notice error" role="alert" key={n.file} data-testid="blast-node-problem">
            {queryNames(n) || n.file}: {n.result?.message}
          </p>
        ))}
      {nodes
        .filter((n) => !n.result)
        .map((n) => (
          <p className="notice error" role="alert" key={n.file}>
            No result from {n.file}: {n.problem}
          </p>
        ))}

      {shown.length > 0 ? (
        <table className="table" data-testid="blast-hits">
          <thead>
            <tr>
              <th scope="col">Query</th>
              <th scope="col">Subject</th>
              <th scope="col" className="num">
                Identity
              </th>
              <th scope="col" className="num">
                Length
              </th>
              <th scope="col" className="num">
                E
              </th>
              <th scope="col" className="num">
                Bits
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((h, i) => (
              <tr key={`${h.query_file}-${h.query}-${h.subject}-${i}`}>
                <td title={h.query_file}>{h.query}</td>
                <td>{h.subject}</td>
                <td className="num">{h.identity.toFixed(1)}%</td>
                <td className="num">{h.length}</td>
                <td className="num">{h.evalue}</td>
                <td className="num">{h.bits}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        done.length > 0 &&
        done.every((n) => n.result?.status === 'ok') && (
          <p className="meta" data-testid="blast-no-hits">
            No sequence matched at this threshold. Loosening “Report matches” and running again is
            the usual next step.
          </p>
        )
      )}

      {hits.length > shown.length && (
        <p className="meta">
          Showing the {SHOWN} strongest of {hits.length}. Every hit is in the files below.
        </p>
      )}

      {done.length > 0 && (
        <p className="meta">
          Full tables:{' '}
          {done.map((n, i) => (
            <span key={n.file}>
              {i > 0 ? ', ' : ''}
              <a href={api.fileUrl(id, hitsFileFor(n.file))}>{queryNames(n) || n.file}</a>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

/** What this node searched, in the user's own file names. */
function queryNames(n: Loaded): string {
  return (n.result?.queries ?? []).map((q) => q.file).join(', ');
}

function describe(e: unknown): string {
  if (e instanceof ApiError && e.status === 404) {
    return 'the job’s files are no longer on the access point';
  }
  return e instanceof Error ? e.message : String(e);
}

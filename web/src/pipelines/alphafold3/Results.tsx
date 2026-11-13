// What the workflow predicted, per job, across both stages.
//
// The job in the list is the DAG MANAGER: it folds nothing itself. Its
// output sandbox is the directory every node wrote into, so this reads
// that sandbox and picks out the small status files each node writes.
// lib/tar.ts says why it is read as one archive rather than file by
// file, and why the two tidier-looking alternatives do not work.
//
// Each node writes its status file on EVERY path, including every
// failure, so a job that could not run explains itself here instead of
// appearing as an empty row. A job whose structure stage is simply
// absent did not get there -- which is normal when no weights were
// given, and a consequence of the failure above it when they were.

import { useEffect, useState } from 'react';
import { ApiError, api, type Job } from '../../lib/api';
import { entryText, readTar } from '../../lib/tar';
import {
  DATA_STATUS_PREFIX,
  INFERENCE_STATUS_PREFIX,
  dataTarball,
  inferenceTarball,
  tagOfStatusFile,
} from './af3';

/** One node's status file. Written by the runners in af3.ts. */
interface NodeStatus {
  schema: number;
  stage: 'data' | 'inference';
  job: string;
  status: 'ok' | 'error' | string;
  message: string;
  exit: number;
  log?: string;
  bytes?: number;
  ranking_score?: number;
  ptm?: number;
  iptm?: number;
}

interface JobRow {
  tag: string;
  data?: NodeStatus;
  inference?: NodeStatus;
  /** A status file that could not be read at all. */
  unreadable?: string;
}

function parse(text: string): NodeStatus | undefined {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as NodeStatus;
  } catch {
    return undefined;
  }
}

/** Group the sandbox's status files by the job they belong to. */
export function collectRows(entries: { name: string; text: string }[]): JobRow[] {
  const byTag = new Map<string, JobRow>();
  const row = (tag: string): JobRow => {
    let r = byTag.get(tag);
    if (!r) {
      r = { tag };
      byTag.set(tag, r);
    }
    return r;
  };

  for (const e of entries) {
    const isData = e.name.startsWith(DATA_STATUS_PREFIX);
    const isInfer = e.name.startsWith(INFERENCE_STATUS_PREFIX);
    if ((!isData && !isInfer) || !e.name.endsWith('.json')) continue;
    const tag = tagOfStatusFile(e.name);
    if (!tag) continue;
    const parsed = parse(e.text);
    const r = row(tag);
    if (!parsed) {
      r.unreadable = e.name;
      continue;
    }
    if (isData) r.data = parsed;
    else r.inference = parsed;
  }

  return [...byTag.values()].sort((a, b) =>
    a.tag.localeCompare(b.tag, undefined, { numeric: true }),
  );
}

/** What to say about a job, in one phrase. */
export function stateOf(r: JobRow): { label: string; ok: boolean } {
  if (r.inference?.status === 'ok') return { label: 'structure predicted', ok: true };
  if (r.inference && r.inference.status !== 'ok') return { label: 'prediction failed', ok: false };
  if (r.data?.status === 'ok') return { label: 'alignments done', ok: true };
  if (r.data && r.data.status !== 'ok') return { label: 'alignments failed', ok: false };
  return { label: 'did not run', ok: false };
}

function score(n: number | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(3) : '—';
}

export function Results({ job }: { job: Job }) {
  const id = `${job.ClusterId}.${job.ProcId}`;
  const [rows, setRows] = useState<JobRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRows(null);
    setError(null);

    void (async () => {
      try {
        const entries = readTar(await api.outputArchive(id)).map((e) => ({
          name: e.name,
          text: entryText(e),
        }));
        if (live) setRows(collectRows(entries));
      } catch (e) {
        if (live) setError(describe(e));
      }
    })();

    return () => {
      live = false;
    };
  }, [id]);

  if (error) {
    return (
      <p className="notice error" role="alert" data-testid="af3-results-error">
        The results for this run could not be read: {error}. The files are still available from
        the download link above.
      </p>
    );
  }
  if (!rows) return <p className="meta">Reading results…</p>;

  if (rows.length === 0) {
    return (
      <p className="notice error" role="alert" data-testid="af3-no-results">
        This run finished without any job reporting on itself. That usually means the workflow
        could not start its jobs at all; the files from the download link above include DAGMan’s
        log, which says why.
      </p>
    );
  }

  const folded = rows.filter((r) => r.inference?.status === 'ok').length;
  const aligned = rows.filter((r) => r.data?.status === 'ok').length;
  const anyStructures = rows.some((r) => r.inference);

  return (
    <div data-testid="af3-results">
      <p data-testid="af3-summary">
        {rows.length} {rows.length === 1 ? 'structure' : 'structures'}: <strong>{aligned}</strong>{' '}
        with alignments
        {anyStructures ? (
          <>
            , <strong>{folded}</strong> predicted
          </>
        ) : (
          ' (no structure prediction in this run — no model weights were given)'
        )}
        .
      </p>

      {/* Each failure in the node's own words, above the table: for a
          job that did not run this IS the result. */}
      {rows.map((r) => {
        const bad = r.inference?.status !== 'ok' ? (r.inference ?? r.data) : undefined;
        if (!bad || bad.status === 'ok') return null;
        return (
          <p className="notice error" role="alert" key={r.tag} data-testid="af3-job-problem">
            {r.tag}: {bad.message || `the ${bad.stage} stage failed (exit ${bad.exit}).`}
          </p>
        );
      })}
      {rows
        .filter((r) => r.unreadable)
        .map((r) => (
          <p className="notice error" role="alert" key={`${r.tag}-unreadable`}>
            {r.tag}: {r.unreadable} could not be read.
          </p>
        ))}

      <table className="table" data-testid="af3-table">
        <thead>
          <tr>
            <th scope="col">Job</th>
            <th scope="col">State</th>
            <th scope="col" className="num">
              Ranking
            </th>
            <th scope="col" className="num">
              pTM
            </th>
            <th scope="col" className="num">
              ipTM
            </th>
            <th scope="col">Files</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const state = stateOf(r);
            return (
              <tr key={r.tag}>
                <td>{r.tag}</td>
                <td>{state.label}</td>
                <td className="num">{score(r.inference?.ranking_score)}</td>
                <td className="num">{score(r.inference?.ptm)}</td>
                <td className="num">{score(r.inference?.iptm)}</td>
                <td>
                  {r.inference?.status === 'ok' && (
                    <a href={api.fileUrl(id, inferenceTarball(r.tag))}>structure</a>
                  )}
                  {r.inference?.status === 'ok' && r.data?.status === 'ok' && ', '}
                  {r.data?.status === 'ok' && (
                    <a href={api.fileUrl(id, dataTarball(r.tag))}>alignments</a>
                  )}
                  {/* A link is offered only for a file a node said it
                      wrote. Every declared output exists even when the
                      job failed -- empty -- so deciding from the status
                      file rather than from the file is the difference
                      between a download and a zero-byte surprise. */}
                  {r.inference?.status !== 'ok' && r.data?.status !== 'ok' && '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="meta">
        Each structure arrives as a tar.gz of AlphaFold3’s own output: the ranked mmCIF models,
        the confidence files and the summary metrics. Open the models in PyMOL, ChimeraX or
        another viewer.
      </p>
    </div>
  );
}

function describe(e: unknown): string {
  if (e instanceof ApiError && e.status === 404) {
    return 'the run’s files are no longer on the access point';
  }
  return e instanceof Error ? e.message : String(e);
}

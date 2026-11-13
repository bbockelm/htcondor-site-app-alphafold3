// BLAST: a shared database and many queries, as a DAG.
//
// Read pipelines/blast/dag.ts for the part worth copying. This file is
// the controls, the validation, and turning what the user gave us into
// a workflow.
//
// TWO PICKERS, NOT ONE
//
// An earlier version took the database and the queries in a single
// dropzone and decided which was which by taking the largest file. A
// database does dwarf a read file, so it was right nearly always --
// and nearly always is the worst a guess can be, because the times it
// was wrong surfaced as an hour of compute spent searching a query
// file against a read. The slots below say which is which, and the
// pipeline no longer has to be clever.

import { isSafeFileName } from '../../lib/submit';
import type {
  ControlsProps,
  FileSet,
  Pipeline,
  PlanResult,
  ResultsProps,
  Upload,
} from '../types';
import {
  BATCH_PREFIX,
  EVALUES,
  MAX_DATABASE_BYTES,
  MAX_HITS,
  PROGRAMS,
  QUERIES_PER_NODE,
  RUNNER_FILE,
  batchNameFor,
  buildRunnerScript,
  databaseFileName,
  databaseKind,
  programById,
  type ProgramId,
} from './blast';
import { DAG_NAME, buildDagFile, buildNodeFiles, planNodes } from './dag';
import { Results as BlastResults } from './Results';
import { EXAMPLE_OPTIONS, buildExample } from './example';

/** What a pasted sequence is called once it becomes a file. */
export const PASTED_FILE = 'pasted-queries.fasta';

export interface BlastOptions {
  program: ProgramId;
  evalue: string;
  maxHits: number;
  /**
   * Sequences typed or pasted into the box, rather than uploaded.
   *
   * This is how most people arrive: with a sequence on the clipboard
   * out of a paper or a sequencer report, not a .fasta on disk. It
   * becomes one more query file at plan time, so nothing downstream --
   * the DAG, the nodes, the results -- has to know the difference.
   */
  pasted: string;
}

const DEFAULTS: BlastOptions = {
  program: 'blastn',
  evalue: '1e-5',
  maxHits: 25,
  pasted: '',
};

function Controls({ options, onChange, busy }: ControlsProps<BlastOptions>) {
  return (
    <fieldset disabled={busy}>
      <label>
        Search
        <select
          value={options.program}
          onChange={(e) => onChange({ ...options, program: e.target.value as ProgramId })}
          data-testid="blast-program"
        >
          {PROGRAMS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Report matches
        <select
          value={options.evalue}
          onChange={(e) => onChange({ ...options, evalue: e.target.value })}
          data-testid="blast-evalue"
        >
          {EVALUES.map((e) => (
            <option key={e.value} value={e.value}>
              {e.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Hits per sequence
        <select
          value={options.maxHits}
          onChange={(e) => onChange({ ...options, maxHits: Number(e.target.value) })}
          data-testid="blast-maxhits"
        >
          {MAX_HITS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Or paste sequences</span>
        <textarea
          rows={6}
          value={options.pasted}
          placeholder={'>my_sequence\nACGTACGTACGTACGT...'}
          onChange={(e) => onChange({ ...options, pasted: e.target.value })}
          data-testid="blast-pasted"
        />
      </label>
      <p className="meta">
        Searched alongside any query files. FASTA, or bare sequence — a missing <code>&gt;</code>{' '}
        header is added for you.
      </p>
    </fieldset>
  );
}

/**
 * Pasted text as a FASTA file, or undefined if the box was empty.
 *
 * Bare sequence gets a header, because a person with one sequence on
 * the clipboard has the sequence and not the `>` line, and BLAST reads
 * a headerless file as zero sequences -- succeeding, with no hits and
 * no complaint, which is indistinguishable from a real empty result.
 */
export function pastedQueryFile(text: string): File | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const body = trimmed.startsWith('>') ? trimmed : `>pasted_query\n${trimmed}`;
  return new File([`${body}\n`], PASTED_FILE, { type: 'text/plain' });
}

function plan(files: FileSet, options: BlastOptions): PlanResult {
  const database = (files.database ?? [])[0];
  const pasted = pastedQueryFile(options.pasted);
  const queries = [...(files.queries ?? []), ...(pasted ? [pasted] : [])];

  if (!database) {
    return {
      kind: 'error',
      message: 'Choose a reference database to search against.',
    };
  }
  if (queries.length === 0) {
    return {
      kind: 'error',
      message: 'Add at least one query file, or paste a sequence into the box.',
    };
  }
  if (database.size > MAX_DATABASE_BYTES) {
    return {
      kind: 'error',
      message:
        `“${database.name}” is larger than this form will push (${Math.round(MAX_DATABASE_BYTES / 1024 ** 3)} GB). ` +
        'A database that size belongs on the access point, staged by a facilitator.',
    };
  }

  const unsafe = queries.filter((f) => !isSafeFileName(f.name));
  if (unsafe.length) {
    return {
      kind: 'error',
      message: `Rename ${unsafe.map((f) => `“${f.name}”`).join(', ')}: letters, digits, dot, dash and underscore only.`,
    };
  }
  // The spool is one flat directory, so two queries cannot share a
  // name. Caught here rather than at run time, where it is one node
  // silently searching the other's file.
  const seen = new Set<string>();
  for (const q of queries) {
    if (seen.has(q.name)) {
      return {
        kind: 'error',
        message: `Two query files are called “${q.name}”. The workflow's directory is flat, so each needs its own name.`,
      };
    }
    seen.add(q.name);
  }

  const dbFile = databaseFileName(database.name);
  const nodes = planNodes(
    queries.map((f) => f.name),
    queries.map((f) => f.size),
    {
      program: options.program,
      evalue: options.evalue,
      maxHits: options.maxHits,
      databaseLabel: database.name,
      databaseKind: databaseKind(database.name),
      databaseFile: dbFile,
      databaseBytes: database.size,
    },
    QUERIES_PER_NODE,
  );

  return {
    kind: 'dag',
    batchName: batchNameFor(options.program),
    dagFile: buildDagFile(nodes),
    nodeFiles: {
      ...buildNodeFiles(nodes),
      // The runner is text, so it rides as a form value rather than a
      // file part. Same spool either way.
      // ONE runner for the whole workflow. Everything that differs
      // between nodes reaches it through each node's `environment`,
      // never through this text -- see buildRunnerScript.
      [RUNNER_FILE]: buildRunnerScript(nodes[0].spec),
    },
    // Uploaded ONCE, with the workflow. Every node reads it from the
    // spool by this name.
    uploads: [
      { name: dbFile, file: database },
      ...queries.map((f): Upload => ({ name: f.name, file: f })),
    ],
  };
}

function Results({ job }: ResultsProps) {
  return <BlastResults job={job} />;
}

export const blast: Pipeline<BlastOptions> = {
  id: 'blast',
  name: 'BLAST search',
  summary:
    'Search many query files against one database. The database is uploaded once, not once per job.',
  batchPrefix: BATCH_PREFIX,
  inputs: [
    {
      id: 'database',
      label: 'Reference database',
      hint: 'One file: a FASTA file, or a .tar.gz of a prepared BLAST database. Uploaded once and shared by every job.',
      accept: '.fa,.fasta,.fna,.faa,.gz,.tar,.tgz,.tar.gz',
      multiple: false,
    },
    {
      id: 'queries',
      label: 'Query sequences',
      hint: 'The sequences to look for. One job per file — or paste them into the box below instead.',
      accept: '.fa,.fasta,.fna,.faa,.txt',
      multiple: true,
    },
  ],
  defaults: DEFAULTS,
  example: {
    label: 'Use an example database and queries instead',
    note: 'A small synthetic DNA database and four queries — three cut from it, one that matches nothing.',
    build: buildExample,
    options: EXAMPLE_OPTIONS,
  },
  Controls,
  plan,
  Results,
};

export { DAG_NAME, programById };

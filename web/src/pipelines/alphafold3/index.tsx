// AlphaFold3: sequences in, predicted structures out.
//
// Read af3.ts for the part worth copying -- the two stages and what
// the flat spool does to them -- and dag.ts for the edge between them.
// This file is the controls, the refusals, and turning what the user
// gave us into a workflow.
//
// ONE SLOT, AND A BOX. The manifest is a spreadsheet of jobs: a name
// and up to several molecules each, which is how anybody doing this at
// scale already has their work written down. The box underneath takes
// a single pasted sequence, because that is how most people arrive the
// first time, and it becomes one more job before anything downstream
// can tell the difference.

import { useState } from 'react';
import type {
  ControlsProps,
  FileSet,
  Pipeline,
  PlanResult,
  ResultsProps,
} from '../types';
import {
  BATCH_PREFIX,
  DATA_RUNNER,
  INFERENCE_RUNNER,
  batchNameFor,
  buildDataRunner,
  buildInferenceRunner,
  foldInputFile,
  isSafeReference,
  referenceBasename,
  type RunSpec,
} from './af3';
import { buildDagFile, buildNodeFiles, planNodes } from './dag';
import {
  SEED_CHOICES,
  VRAM_WARN_GB,
  countTokens,
  foldInputJson,
  requestedVramGB,
  seedList,
} from './foldinput';
import {
  MAX_JOBS,
  MAX_MANIFEST_BYTES,
  jobsFromCsv,
  jobsFromFasta,
  type ParsedJob,
} from './manifest';
import { Results as AlphaFold3Results } from './Results';
import { EXAMPLE_OPTIONS, buildExample } from './example';
import { SITE, isConfigured } from './site';
import { isSafeFileName } from '../../lib/submit';

export interface AlphaFold3Options {
  /**
   * Where the model weights are, as this access point can reach them:
   * a path on the access point, or a URL.
   *
   * NOT a file to upload. They are gigabytes, and a browser is the
   * wrong way to move them even once. They are also licensed from
   * Google DeepMind and cannot be shipped with this app, so this is
   * the one thing every user has to bring.
   *
   * Empty means the alignment stage only.
   */
  weights: string;
  /** How many predictions per job. One per seed. */
  seeds: number;
  /** A sequence pasted rather than written into the manifest. */
  pasted: string;
}

const DEFAULTS: AlphaFold3Options = {
  weights: SITE.weightsDefault,
  seeds: 1,
  pasted: '',
};

function Controls({ options, onChange, busy }: ControlsProps<AlphaFold3Options>) {
  const [showHelp, setShowHelp] = useState(false);
  return (
    <fieldset disabled={busy}>
      {!isConfigured() && (
        <p className="notice error" role="alert" data-testid="af3-unconfigured">
          This app has not been pointed at an AlphaFold3 installation yet, so jobs will report
          that the machine they landed on cannot run it. Whoever deploys the app sets that in
          its site settings; everything else on this page works.
        </p>
      )}

      <label>
        <span>AlphaFold3 model weights</span>
        <input
          type="text"
          value={options.weights}
          placeholder="/staging/you/alphafold3/af3.bin.zst"
          onChange={(e) => onChange({ ...options, weights: e.target.value })}
          data-testid="af3-weights"
        />
      </label>
      <p className="meta">
        Where the weights already are on this access point — a path, or a URL its jobs can
        fetch. They are not uploaded here: they are several gigabytes, and they are licensed
        from Google DeepMind, who release them to named researchers on request (see the
        AlphaFold3 repository, docs/installation.md). <strong>Leave this empty</strong> to run
        only the alignment stage, which needs no weights and is the slow half.
      </p>

      <label>
        <span>Predictions per job</span>
        <select
          value={options.seeds}
          onChange={(e) => onChange({ ...options, seeds: Number(e.target.value) })}
          data-testid="af3-seeds"
        >
          {SEED_CHOICES.map((n) => (
            <option key={n} value={n}>
              {n === 1 ? 'one' : `${n} (different random seeds)`}
            </option>
          ))}
        </select>
      </label>

      <label>
        <span>Or paste one sequence</span>
        <textarea
          rows={5}
          value={options.pasted}
          placeholder={'>my_protein\nMQIFVKTLTGKTITLEVEPSDTIENVKAKIQDKEG...'}
          onChange={(e) => onChange({ ...options, pasted: e.target.value })}
          data-testid="af3-pasted"
        />
      </label>
      <p className="meta">
        Folded alongside anything in the manifest, as a protein with one chain. RNA, DNA,
        ligands and multi-chain complexes need the manifest.
      </p>

      <p className="meta">
        <button type="button" className="secondary" onClick={() => setShowHelp(!showHelp)}>
          {showHelp ? 'Hide the manifest format' : 'What goes in the manifest?'}
        </button>
      </p>
      {showHelp && (
        <div className="meta" data-testid="af3-manifest-help">
          <p>
            One row per structure, one column group per molecule in it. The first line names
            the columns:
          </p>
          <pre>
            job_name,mol1_type,mol1_chain,mol1_seq,mol2_type,mol2_chain,mol2_seq{'\n'}
            my_protein,protein,A,MQIFVKTLTG…{'\n'}
            with_rna,protein,A,MQIFVKTLTG…,rna,B,GUCUUCAAAACUAGGUCG
          </pre>
          <p>
            A molecule’s type is <code>protein</code>, <code>rna</code>, <code>dna</code>,{' '}
            <code>smiles</code> (a ligand written as SMILES) or <code>ccdCodes</code> (a ligand
            written as CCD codes such as <code>ATP</code>). For a complex of several identical
            chains, separate the chain letters with <code>|</code>, as in <code>A|B|C|D</code>.
            Add mol3_, mol4_ … columns for more molecules.
          </p>
        </div>
      )}
    </fieldset>
  );
}

/**
 * The text of a file the user chose.
 *
 * FileReader rather than `file.text()`, which is newer and tidier and
 * is not implemented by jsdom -- so the tidier version would be a path
 * no unit test could take. One code path, exercised everywhere.
 */
export function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error(`${file.name} could not be read`));
    reader.readAsText(file);
  });
}

/** What the user asked for, once both sources of jobs are merged. */
export interface Planned {
  jobs: ParsedJob[];
  problems: string[];
}

/** Jobs from the manifest, then jobs from the box, numbered in order. */
export function collectJobs(manifestText: string | null, pasted: string): Planned {
  const fromFile = manifestText === null ? { jobs: [], problems: [] } : jobsFromCsv(manifestText);
  const fromBox = jobsFromFasta(pasted, fromFile.jobs.length + 1);
  const problems = [...fromFile.problems, ...fromBox.problems];
  const jobs = [...fromFile.jobs, ...fromBox.jobs];

  // A guard, not a check the user can trip: every file this workflow
  // writes is named after the job's TAG, and tags are numbered in one
  // sequence across both sources, so they are unique by construction.
  // If that ever stops being true, two jobs write over each other in
  // the workflow's one flat directory and the second result is simply
  // missing -- silently, which is why the invariant is worth a line.
  const seen = new Set<string>();
  for (const j of jobs) {
    const key = j.tag.toLowerCase();
    if (seen.has(key)) {
      problems.push(`Two jobs would both be called “${j.tag}”. Rename one of them.`);
    }
    seen.add(key);
  }
  return { jobs, problems };
}

/**
 * Why the weights box cannot be used as written.
 *
 * Everything the job is told to fetch goes into a submit command and
 * then onto a command line, so this is an allow-list: a location is
 * either a URL or an absolute path, and it ends in a file name.
 */
export function weightsProblem(weights: string): string | undefined {
  if (weights === '') return undefined;
  if (!isSafeReference(weights)) {
    return (
      'The model weights location should be a path on this access point, such as ' +
      '/staging/you/alphafold3/af3.bin.zst, or a URL its jobs can fetch.'
    );
  }
  if (!isSafeFileName(referenceBasename(weights))) {
    return `“${weights}” does not end in a file name the job can be given.`;
  }
  return undefined;
}

async function plan(files: FileSet, options: AlphaFold3Options): Promise<PlanResult> {
  const manifest = (files.manifest ?? [])[0];
  if (manifest && manifest.size > MAX_MANIFEST_BYTES) {
    return {
      kind: 'error',
      message: `“${manifest.name}” is too large to be a manifest. It should be a spreadsheet of sequences, a few kilobytes per job.`,
    };
  }

  const bad = weightsProblem(options.weights.trim());
  if (bad) return { kind: 'error', message: bad };
  const weights = options.weights.trim();

  const { jobs, problems } = collectJobs(manifest ? await readText(manifest) : null, options.pasted);

  if (problems.length) {
    return { kind: 'error', message: problems.slice(0, 5).join(' ') };
  }
  if (jobs.length === 0) {
    return {
      kind: 'error',
      message:
        'Add a manifest of sequences, or paste one sequence into the box, and this will fold it.',
    };
  }
  if (jobs.length > MAX_JOBS) {
    return {
      kind: 'error',
      message: `That is ${jobs.length} structures. This form runs at most ${MAX_JOBS} at a time.`,
    };
  }

  const seeds = seedList(options.seeds);
  const sized = jobs.map((j) => ({ ...j, tokens: countTokens(j.molecules) }));

  const huge = sized.filter((j) => requestedVramGB(j.tokens) > VRAM_WARN_GB);
  if (huge.length) {
    return {
      kind: 'error',
      message:
        `${huge.map((j) => `“${j.name}”`).join(', ')} would need more GPU memory than any ` +
        'machine here is likely to have. Complexes this large are worth a conversation with a ' +
        'facilitator before they are queued.',
    };
  }

  const spec: RunSpec = { site: SITE, weights };
  const nodes = planNodes(spec, sized);

  const nodeFiles: Record<string, string> = {
    ...buildNodeFiles(sized, nodes),
    // ONE runner for every node of its stage. What differs between
    // nodes travels in each submit file's `environment`.
    [DATA_RUNNER]: buildDataRunner(spec),
  };
  if (weights) nodeFiles[INFERENCE_RUNNER] = buildInferenceRunner(spec);
  for (const j of sized) {
    nodeFiles[foldInputFile(j.tag)] = foldInputJson(j, seeds);
  }

  return {
    kind: 'dag',
    batchName: batchNameFor(),
    dagFile: buildDagFile(sized, nodes),
    nodeFiles,
    // Nothing is uploaded: every file this workflow needs was
    // generated above, and the two big ones -- the databases and the
    // model weights -- are read where they already are.
    uploads: [],
  };
}

function Results({ job }: ResultsProps) {
  return <AlphaFold3Results job={job} />;
}

export const alphafold3: Pipeline<AlphaFold3Options> = {
  id: 'alphafold3',
  name: 'AlphaFold3 structure prediction',
  summary:
    'Alignments on CPUs, then structures on GPUs — one workflow per batch of sequences. The model weights stay where you staged them.',
  // The app has one pipeline, so no selector is drawn and this is what
  // stands in its place. It is the only thing a first-time user reads
  // before deciding what to upload, so it has to answer the questions
  // they actually have -- above all that the weights are theirs to
  // supply and that a run without them is still useful.
  description: {
    what:
      'Predicts the three-dimensional structure of each protein, nucleic acid and ligand complex you list. ' +
      'Each one becomes two jobs: a search for related sequences on ordinary CPUs, then the structure itself on a GPU.',
    needs:
      'A CSV manifest — one row per structure, naming it and its molecules — or a single sequence pasted into the box. ' +
      'For the structure stage you also give the location, on this access point, of your own AlphaFold3 model weights: ' +
      'they are licensed from Google DeepMind and cannot be distributed with this app. Leave that empty and the ' +
      'alignments still run, which is a useful result on its own and the slow half of the work.',
    gives:
      'Per structure: the predicted models, and the confidence scores to judge them by — the ranking score, pTM, and ' +
      'ipTM where there is more than one chain. The alignments come back too, so a later run can reuse them.',
    cost:
      'The alignment stage is the long one: tens of minutes to hours per sequence against a large reference database. ' +
      'The structure stage is minutes on one GPU, sized by how long the sequence is.',
  },
  batchPrefix: BATCH_PREFIX,
  inputs: [
    {
      id: 'manifest',
      label: 'Sequences to fold',
      hint: 'A CSV manifest: one row per structure, with a name and its molecules. Or paste a single sequence into the box below.',
      accept: '.csv,.txt',
      multiple: false,
    },
  ],
  defaults: DEFAULTS,
  example: {
    label: 'Use an example manifest instead',
    note:
      'Human ubiquitin on its own, and the same protein with an ATP ligand. With the weights box empty this runs the alignment stage only, which is the half that needs no licence.',
    build: buildExample,
    options: EXAMPLE_OPTIONS,
  },
  Controls,
  plan,
  Results,
};

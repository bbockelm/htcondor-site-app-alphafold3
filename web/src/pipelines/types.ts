// What a pipeline has to provide, and what the app shell does for it.
//
// The shell owns everything that is the same whatever science you are
// running: who you are, the file pickers, the submit-then-upload-then-
// poll sequence, the job list, the error handling. A pipeline owns the
// five things that are genuinely its own -- what files it takes, what
// controls it offers, what submit file it produces, how its results
// should be read, and what to run when the user has no data of their
// own.
//
// Three are implemented here, in pipelines/. They are worked examples,
// not a framework: a lab building their own deletes the two they do
// not want and edits the third. Nothing on the server knows this
// interface exists.

import type { JSX } from 'react';
import type { Job } from '../lib/api';

/** One file to upload into a job's sandbox, under a chosen name. */
export interface Upload {
  /** The name the job will see. Keep these fixed; see submit.ts. */
  name: string;
  file: File;
}

/**
 * One labelled place to put files.
 *
 * A pipeline declares its slots and the shell draws a picker for each.
 * The point is BLAST: a reference database and a pile of queries are
 * different things, and an earlier version of this app took them in
 * one pile and guessed which was which by size. The guess was usually
 * right, which is the worst property a guess can have -- when it was
 * wrong, the user found out an hour later in the results.
 *
 * Most pipelines want exactly one slot. Declaring it is still worth
 * the line, because the slot is where `inputLabel` and `accept` now
 * live and they belong next to each other.
 */
export interface InputSlot {
  /** Stable key. Used for the FileSet and for test ids. */
  id: string;
  /** The heading over this picker. */
  label: string;
  /** One line under it, saying what belongs here. */
  hint: string;
  /** `accept` for the file input, e.g. '.fits,.fit'. */
  accept?: string;
  /** Whether more than one file in THIS slot is meaningful. */
  multiple: boolean;
}

/**
 * What the user put in each slot, keyed by slot id.
 *
 * Always has an entry for every declared slot, possibly empty, so a
 * planner can read `files.queries` without a guard.
 */
export type FileSet = Record<string, File[]>;

/** Every file in a FileSet, in slot order. For sizing and counting. */
export function allFiles(files: FileSet, slots: InputSlot[]): File[] {
  return slots.flatMap((s) => files[s.id] ?? []);
}

/** An empty FileSet with one entry per slot. */
export function emptyFileSet(slots: InputSlot[]): FileSet {
  return Object.fromEntries(slots.map((s) => [s.id, []]));
}

/** A plain one-job submission. */
export interface JobPlan {
  kind: 'job';
  submitFile: string;
  uploads: Upload[];
  /** Shown in the job list, and how the app finds its own jobs again. */
  batchName: string;
}

/**
 * A DAG submission: the shared inputs are spooled ONCE and the node
 * jobs are submitted by DAGMan from that sandbox.
 *
 * This is the answer to "every job needs the same 2 GB database". A
 * plain `queue N` uploads it per proc; a DAG uploads it once. See
 * AGENTS.md, which explains why, and pipelines/blast, which does it.
 */
export interface DagPlan {
  kind: 'dag';
  /** The .dag file. */
  dagFile: string;
  /** Submit files for the nodes, by file name. */
  nodeFiles: Record<string, string>;
  /** Spooled once, with the DAG. */
  uploads: Upload[];
  batchName: string;
}

export type Plan = JobPlan | DagPlan;

/** Why a pipeline will not run with what it was given. */
export interface PlanError {
  kind: 'error';
  /** Said to the user. Name the thing to change, not the rule broken. */
  message: string;
}

export type PlanResult = Plan | PlanError;

export function isPlanError(r: PlanResult): r is PlanError {
  return r.kind === 'error';
}

/**
 * A planner's answer, when that planner is a synchronous one.
 *
 * `Pipeline.plan` may return a promise, so its type is a union and a
 * caller has to deal with both. A pipeline that plans synchronously --
 * all three here -- has tests that would otherwise become async for no
 * reason at all. This narrows the union and says out loud which kind
 * of planner is under test, throwing if that ever changes rather than
 * quietly asserting against a pending promise.
 */
export function assertSync(r: PlanResult | Promise<PlanResult>): PlanResult {
  if (r instanceof Promise) {
    throw new Error('this planner answered with a promise; await it instead');
  }
  return r;
}

/**
 * Data to run with when the user has none of their own.
 *
 * Every pipeline here ships one, and the shell offers it as a checkbox
 * above the pickers. The reason is narrow and worth stating: a person
 * shown this app for the first time does not have a BLAST database or
 * a pile of FITS frames to hand, so without this there is nothing they
 * can do but read the form. The files are BUILT, in the browser, from
 * the code in each pipeline's example.ts -- they are not assets in the
 * bundle, so they cost the download nothing.
 *
 * `options` is merged over the pipeline's defaults when the box is
 * ticked, because example data usually only makes sense with the
 * settings it was built for.
 */
export interface Example<O> {
  /** What the checkbox says. One line, in the user's terms. */
  label: string;
  /** A sentence under it: what the data is and what will happen. */
  note: string;
  /** Built on demand, not at import time. */
  build: () => FileSet;
  options?: Partial<O>;
}

/** Props the shell hands a pipeline's controls. */
export interface ControlsProps<O> {
  options: O;
  onChange: (next: O) => void;
  /** True while a submission is in flight; disable inputs. */
  busy: boolean;
}

/** Props the shell hands a pipeline's results view. */
export interface ResultsProps {
  job: Job;
}

/**
 * The inline documentation shown above the pickers.
 *
 * A one-line `summary` is enough to tell three pipelines apart in a
 * drop-down. It is not enough to open an app that does exactly one
 * thing: there is no picker there, and a first-time user arrives at a
 * form with no idea what it wants or what it will give back. So a
 * pipeline says that here, in the user's own terms, and the shell
 * renders it in the space a one-entry picker would have wasted.
 *
 * Keep each field to a sentence or three. This is the only place the
 * app explains itself, and nobody reads a wall of text above a form.
 */
export interface PipelineDescription {
  /** What this computes, and why somebody would want it. */
  what: string;
  /** What the user has to bring. Name the file kinds they will have. */
  needs: string;
  /** What comes back, and what they can do with it afterwards. */
  gives: string;
  /** What a run costs: how long, how much uploaded, how many jobs. */
  cost?: string;
}

/**
 * A pipeline. `O` is whatever that pipeline keeps in its own options;
 * the shell holds it without looking inside.
 */
export interface Pipeline<O = unknown> {
  id: string;
  name: string;
  /** One line, shown under the picker. */
  summary: string;
  /**
   * The longer version, shown above the pickers whether or not there
   * is a picker. An app with ONE pipeline renders no selector at all,
   * and this is what stands in its place.
   */
  description?: PipelineDescription;
  /**
   * What every batch name from this pipeline starts with.
   *
   * This is how the app finds its own jobs again: the queue is the
   * record, and there is no local database. It must be a PREFIX match,
   * not equality, because two of the three pipelines stamp the time
   * into the name so one run can be told from another -- and an
   * earlier version of this shell compared the whole name against the
   * pipeline id, so those two pipelines' jobs never appeared in the
   * list at all. Nothing errored; the list was just always short.
   */
  batchPrefix: string;
  /** Where files go. One slot unless the inputs are different things. */
  inputs: InputSlot[];
  defaults: O;
  /** Something to run when the user has no data of their own. */
  example?: Example<O>;
  Controls: (p: ControlsProps<O>) => JSX.Element;
  /**
   * Turn the chosen files and options into a submission.
   *
   * May be async, and in this app it is. A pipeline that generates the
   * job's program from the user's data -- rather than shipping a
   * program that reads it at run time -- has to READ that data, and
   * reading a File in a browser is a promise. The shell awaits this,
   * so a synchronous planner still works unchanged.
   */
  plan: (files: FileSet, options: O) => PlanResult | Promise<PlanResult>;
  /** Read this pipeline's output. Rendered under a finished job. */
  Results: (p: ResultsProps) => JSX.Element;
}

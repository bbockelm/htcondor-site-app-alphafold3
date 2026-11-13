// Typed client for the HTCondor HTTP API.
//
// Three rules, all of which this file already follows for you:
//
//   1. Every request sends `credentials: 'include'`. The app is served
//      from the same origin as the API, so the browser already holds a
//      session cookie; there is no token to manage and no Authorization
//      header to build.
//   2. A 401 means the session expired. Go to /login. Do not try to
//      refresh anything.
//   3. Errors come back as JSON with a `message` or `error` field.
//      Surface that text -- it is written to be read.
//
// Before adding an endpoint here, check /openapi.json on a running
// server. The API is larger than this file; it is not larger than you
// think in the particular way you are about to assume.

import { redirectToLogin, type Identity } from './htcondor';
import { sortJobs } from './jobs';

const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body && !(init.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...init.headers,
    },
  });

  if (res.status === 401) {
    redirectToLogin();
    throw new ApiError(401, 'Session expired');
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      detail = body.message ?? body.error ?? detail;
    } catch {
      /* not JSON; statusText is the best we have */
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * The attributes this app reads off a job.
 *
 * This list is the contract with the server: anything not named here
 * comes back undefined, whatever the job actually holds. Keep it in
 * step with what the components read -- a field added to the UI but
 * not to this list fails quietly and looks like a backend bug.
 */
export const JOB_ATTRS = [
  'ClusterId',
  'ProcId',
  'JobStatus',
  'Owner',
  'Cmd',
  'JobBatchName',
  'QDate',
  'ExitCode',
  'HoldReason',
  // Needed to tell 'spooling your input' (16) apart from a real
  // problem. Without it every just-submitted job reads as failed.
  'HoldReasonCode',
] as const satisfies readonly string[];

/** A job as the API returns it: a ClassAd, so the fields are loose. */
export interface Job {
  ClusterId: number;
  ProcId: number;
  JobStatus: number;
  Owner?: string;
  Cmd?: string;
  JobBatchName?: string;
  QDate?: number;
  HoldReason?: string;
  HoldReasonCode?: number;
  ExitCode?: number;
  [attr: string]: unknown;
}

export interface SubmitResult {
  cluster_id: number;
  job_ids: string[];
}

/** A file the user dropped, paired with the name the job will see. */
export interface InputFile {
  name: string;
  file: File;
  /** Mode 0755 instead of 0644. One per submission at most. */
  executable?: boolean;
}

/**
 * A GET whose body is text, not JSON -- job output, a result file.
 *
 * Separate from `request` because the error path differs: a failure
 * still answers JSON, so the detail has to be dug out of a body this
 * function is otherwise not parsing.
 */
async function requestText(path: string): Promise<string> {
  const res = await fetch(`${BASE}${path}`, { credentials: 'include' });
  if (res.status === 401) {
    redirectToLogin();
    throw new ApiError(401, 'Session expired');
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      detail = body.message ?? body.error ?? detail;
    } catch {
      /* not JSON; statusText is the best we have */
    }
    throw new ApiError(res.status, detail);
  }
  return res.text();
}

export const api = {
  /** Who is logged in. Resolves the session cookie only. */
  me: () => request<Identity>('/auth/me'),

  /**
   * Submit a job.
   *
   * `submitFile` is the text of an HTCondor submit file, ending in a
   * `queue` line. Site-wide policy (a required log location, an
   * accounting group) is applied by the server; you do not need to know
   * what this access point requires.
   */
  submit: (submitFile: string) =>
    request<SubmitResult>('/jobs', {
      method: 'POST',
      body: JSON.stringify({ submit_file: submitFile }),
    }),

  /**
   * Upload input files for a job that has already been submitted.
   *
   * Submit first, upload second. The server submits with input
   * spooling on, so the job is HELD -- HoldReasonCode 16,
   * SpoolingInput -- from the moment it is created until this upload
   * lands. That is normal and is not a failure; see jobStatusLabel,
   * which must say so in words or the user reads their brand-new job
   * as broken.
   *
   * There is no `hold` option on submit. JobSubmitRequest has exactly
   * one field, `submit_file`. (An earlier version of this comment
   * described a `hold = true` parameter that does not exist -- the
   * precise mistake AGENTS.md warns about, shipped in the client it
   * tells you to extend.)
   */
  uploadInputs: async (jobId: string, files: InputFile[]): Promise<void> => {
    const form = new FormData();
    for (const f of files) {
      form.append(f.executable ? 'executable' : 'input', f.file, f.name);
    }
    await request<void>(`/jobs/${encodeURIComponent(jobId)}/input/multipart`, {
      method: 'POST',
      body: form,
    });
  },

  /**
   * The caller's jobs. `constraint` is a ClassAd expression.
   *
   * ALWAYS sends an explicit projection. `GET /jobs` has a default
   * one -- ClusterId, ProcId, Owner, JobStatus, Cmd, Args -- and
   * returns nothing else, so a field you did not ask for arrives
   * `undefined` rather than missing. That is not a loud failure: it
   * renders. A finished job whose ExitCode was never requested reads
   * "Failed (exit undefined)", which is the opposite of the truth.
   *
   * Add an attribute here before you read it anywhere else.
   *
   * `limit` also has a default (50) and truncates silently.
   *
   * SORTED HERE, newest run first. The route promises no order and
   * does not have a stable one, so a list rendered in arrival order
   * reshuffles itself every time the app polls -- which it does every
   * five seconds, under the user's cursor. Sorting at the edge means
   * no caller can forget; lib/jobs.ts says what the order is.
   */
  jobs: (constraint?: string, attrs: readonly string[] = JOB_ATTRS, limit = 200) => {
    const q = new URLSearchParams({ projection: attrs.join(','), limit: String(limit) });
    if (constraint) q.set('constraint', constraint);
    return request<{ jobs: Job[] }>(`/jobs?${q}`).then((r) => sortJobs(r.jobs ?? []));
  },

  job: (jobId: string) => request<Job>(`/jobs/${encodeURIComponent(jobId)}`),

  /**
   * Stop a running or queued job by holding it.
   *
   * NOT `DELETE /jobs/{id}`: that route exists in the API but is
   * documented "NOT YET IMPLEMENTED" and answers 501. A button wired
   * to it cannot work, however reasonable it looks.
   *
   * Holding is not removing, so say "stop", not "cancel" -- a held
   * job is still in the queue and can be released. Calling it
   * "cancelled" in the interface would be the kind of lie AGENTS.md
   * tells you not to tell.
   */
  hold: (jobId: string, reason = 'Stopped from the web interface') =>
    request<void>(`/jobs/${encodeURIComponent(jobId)}/hold`, {
      // The reason comes back as HoldReason, so the interface can tell
      // a job the user stopped apart from one the pool held. Without
      // it both read the same, and "say what happened" becomes
      // impossible for the one case you caused yourself.
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  /** Release a held job so it can run again. */
  release: (jobId: string) =>
    request<void>(`/jobs/${encodeURIComponent(jobId)}/release`, { method: 'POST' }),

  /**
   * Submit a DAG workflow, with everything it needs, in ONE request.
   *
   * Not submit-then-upload like a plain job, and this is not a style
   * choice. A workflow's spool is written once -- the transfer
   * completing is what releases the hold, and the schedd refuses a
   * second spool for the same job -- so a sandbox that is not complete
   * at submit time never will be. Worse, the manager job's
   * transfer_input_files is computed from the DAG at submit time, and a
   * file not in that list is SKIPPED rather than rejected: a two-step
   * upload would be accepted and silently dropped.
   *
   * Sent as multipart because that is the only shape a large binary
   * shared input can arrive in. This is what makes "upload the 2 GB
   * database once, not once per job" possible at all.
   */
  submitDag: async (req: {
    dag: string;
    files?: Record<string, string>;
    uploads?: { name: string; file: File }[];
    dagName?: string;
    batchName?: string;
    maxJobs?: number;
  }): Promise<{ job_id: string; cluster_id: number; input_files: string[] }> => {
    const form = new FormData();
    form.set('dag', req.dag);
    if (req.dagName) form.set('dag_name', req.dagName);
    if (req.batchName) form.set('batch_name', req.batchName);
    if (req.maxJobs) form.set('max_jobs', String(req.maxJobs));
    // Text files the DAG references -- node submit files, scripts.
    for (const [name, body] of Object.entries(req.files ?? {})) {
      form.append(name, new Blob([body], { type: 'text/plain' }), name);
    }
    // Binary or large files, streamed rather than stringified.
    for (const u of req.uploads ?? []) {
      form.append(u.name, u.file, u.name);
    }
    const res = await fetch(`${BASE}/jobs/dag`, {
      method: 'POST',
      credentials: 'include',
      // No Content-Type: the browser sets it, with the boundary.
      body: form,
    });
    if (res.status === 401) {
      redirectToLogin();
      throw new ApiError(401, 'Session expired');
    }
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = (await res.json()) as { message?: string; error?: string };
        detail = body.message ?? body.error ?? detail;
      } catch {
        /* not JSON; statusText is the best we have */
      }
      throw new ApiError(res.status, detail);
    }
    return (await res.json()) as { job_id: string; cluster_id: number; input_files: string[] };
  },

  /** The job's standard output, as text. This is the readable report. */
  stdout: (jobId: string) => requestText(`/jobs/${encodeURIComponent(jobId)}/stdout`),

  /** The job's standard error, as text. Only read when something failed. */
  stderr: (jobId: string) => requestText(`/jobs/${encodeURIComponent(jobId)}/stderr`),

  /** One named file from the job's output sandbox, as text. */
  jobFile: (jobId: string, name: string) =>
    requestText(`/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(name)}`),

  /** URL for one named file from the job's sandbox. Use as an href. */
  fileUrl: (jobId: string, name: string) =>
    `${BASE}/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(name)}`,

  /** URL for the job's output sandbox as a tar. Use as an href. */
  outputUrl: (jobId: string) => `${BASE}/jobs/${encodeURIComponent(jobId)}/output`,

  /**
   * The job's output sandbox, as the bytes of an uncompressed tar.
   *
   * Everything the job PRODUCED, and nothing it was given: an uploaded
   * input is not in here. That is what makes it the right way to read
   * a workflow whose output file names were decided at submit time --
   * see lib/tar.ts, and pipelines/blast, which is why it exists.
   */
  outputArchive: async (jobId: string): Promise<Uint8Array> => {
    const res = await fetch(api.outputUrl(jobId), { credentials: 'include' });
    if (res.status === 401) {
      redirectToLogin();
      throw new ApiError(401, 'Session expired');
    }
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = (await res.json()) as { message?: string; error?: string };
        detail = body.message ?? body.error ?? detail;
      } catch {
        /* not JSON; statusText is the best we have */
      }
      throw new ApiError(res.status, detail);
    }
    return new Uint8Array(await res.arrayBuffer());
  },

  /**
   * Site submit templates, if this access point defines any. A template
   * is a submit-file body plus the column names it expects.
   *
   * Entirely optional: an app that builds its own submit files never
   * needs to call this.
   */
  templates: () =>
    request<{ templates: { id: string; name: string; description?: string; columns?: string[] }[] }>(
      '/templates',
    ).then((r) => r.templates ?? []),
};

/**
 * The hold codes worth telling apart.
 *
 * SpoolingInput is not a failure: the server submits with spooling
 * on, so every job is held under this code between submit and the
 * input upload. UploadFileError is what you get when a declared
 * output file was missing at the end -- see AGENTS.md.
 */
export const HoldReasonCode = {
  UploadFileError: 13,
  SpoolingInput: 16,
} as const;

/** JobStatus codes, which the API returns as bare integers. */
export const JobStatus = {
  Idle: 1,
  Running: 2,
  Removed: 3,
  Completed: 4,
  Held: 5,
  Transferring: 6,
} as const;

/**
 * A label for a job's state, in words the user can act on.
 *
 * Status 1 with no start time usually means the input upload has not
 * finished, which users read as "stuck" unless told otherwise. Being
 * specific here costs one line and saves a support email.
 */
export function jobStatusLabel(job: Job): string {
  switch (job.JobStatus) {
    case JobStatus.Idle:
      return job.QDate && Date.now() / 1000 - job.QDate < 30 ? 'Starting' : 'Waiting for a slot';
    case JobStatus.Running:
      return 'Running';
    case JobStatus.Removed:
      return 'Cancelled';
    case JobStatus.Completed:
      return job.ExitCode === 0 ? 'Finished' : `Failed (exit ${job.ExitCode})`;
    case JobStatus.Held:
      // Code 16 is SpoolingInput: the job is held because the server
      // is waiting for the input upload that always follows submit.
      // It is the state EVERY job passes through, and calling it
      // "Stopped" tells the user their new job failed.
      if (job.HoldReasonCode === HoldReasonCode.SpoolingInput) {
        return 'Uploading your files';
      }
      return job.HoldReason ? `Stopped: ${job.HoldReason}` : 'Stopped';
    case JobStatus.Transferring:
      return 'Copying results back';
    default:
      return 'Unknown';
  }
}

// The app shell: everything that is the same whatever you are running.
//
// Who you are, the file pickers, the submit-then-upload-then-poll
// sequence, the job list, the errors. What is actually being computed
// lives in pipelines/, behind the small interface in pipelines/types.ts.
//
// Three pipelines ship as worked examples. A lab building their own
// deletes the two they do not want and edits the third; nothing on the
// server knows which exist.
//
// Two shapes here are worth keeping whatever you build:
//
//   run()        submit, then upload, then poll. The ordering is not
//                obvious and getting it wrong looks like a job that
//                hangs.
//
//   the results  a finished job is not a tarball. The pipeline knows
//                what its own output means, so the shell renders
//                pipeline.Results under the job and leaves the
//                download link for the people who want the files.

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, HoldReasonCode, JobStatus, jobStatusLabel, type Job } from './lib/api';
import { PIPELINES, ownJobsConstraint, pipelineById, pipelineForJob } from './pipelines';
import { emptyFileSet, isPlanError, type FileSet } from './pipelines/types';
import { app, type Identity } from './lib/htcondor';
import { Dropzone } from './components/Dropzone';
import { PipelineChooser } from './components/PipelineChooser';
import { formatSize } from './lib/format';

export function App() {
  const [me, setMe] = useState<Identity | null>(null);
  const [pipelineId, setPipelineId] = useState(PIPELINES[0].id);
  const [files, setFiles] = useState<FileSet>(() => emptyFileSet(PIPELINES[0].inputs));
  // Each pipeline keeps its own options; the shell holds them without
  // looking inside, and resets them when the pipeline changes.
  const [options, setOptions] = useState<unknown>(PIPELINES[0].defaults);
  // The example data, built once when the box is ticked rather than on
  // every render: building it is real work (the FITS frames are a few
  // hundred kilobytes of generated pixels) and the files must be the
  // same objects from one render to the next or the list flickers.
  const [example, setExample] = useState<FileSet | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    api.me().then(setMe).catch(() => setMe({ authenticated: false }));
  }, []);

  // Only this app's jobs. The queue is the record -- there is no local
  // database to drift out of sync with it.
  const refresh = useCallback(async () => {
    try {
      setJobs(await api.jobs(ownJobsConstraint()));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const pipeline = pipelineById(pipelineId) ?? PIPELINES[0];
  const usingExample = example !== null;
  const chosen = usingExample ? example : files;

  function choosePipeline(id: string) {
    const next = pipelineById(id);
    if (!next) return;
    setPipelineId(id);
    // Not carried across: one pipeline's options mean nothing to
    // another, and a stale value here would be submitted silently.
    setOptions(next.defaults);
    setFiles(emptyFileSet(next.inputs));
    setExample(null);
    setError(null);
  }

  function toggleExample(on: boolean) {
    const ex = pipeline.example;
    if (!on || !ex) {
      setExample(null);
      return;
    }
    setExample(ex.build());
    // Example data usually only makes sense with the settings it was
    // built for -- the BLAST example is DNA, so the program has to be
    // blastn whatever was selected a moment ago.
    if (ex.options) setOptions({ ...(options as object), ...ex.options });
    setError(null);
  }

  function setSlot(slotId: string, next: File[]) {
    setFiles((f) => ({ ...f, [slotId]: next }));
  }

  async function run() {
    setBusy(true);
    setError(null);
    setSubmitted(null);
    try {
      // The pipeline decides what to submit. It may refuse -- a file
      // it cannot use, a name it cannot safely transfer -- and its
      // message is written for the person who dropped the file.
      //
      // AWAITED: a planner that generates the job's inputs from the
      // user's data has to read that data, and reading a File is a
      // promise. A synchronous planner is unaffected.
      const planned = await pipeline.plan(chosen, options);
      if (isPlanError(planned)) {
        setError(planned.message);
        return;
      }

      // 1. Submit. The server applies this site's submit policy, so we
      //    do not set a log location or an accounting group.
      //
      //    A DAG goes to a different endpoint: its shared inputs are
      //    spooled ONCE and DAGMan submits the nodes from that
      //    sandbox. That is the answer to "every job needs the same
      //    2 GB database"; see pipelines/blast.
      let jobId: string;
      if (planned.kind === 'dag') {
        // Everything in one call. A workflow's spool is written once,
        // so a second upload afterwards would not be rejected -- it
        // would be accepted and silently dropped.
        const res = await api.submitDag({
          dag: planned.dagFile,
          files: planned.nodeFiles,
          uploads: planned.uploads,
          batchName: planned.batchName,
        });
        jobId = res.job_id;
      } else {
        jobId = (await api.submit(planned.submitFile)).job_ids[0];
        // 2. Upload, AFTER submitting: the files belong to a job that
        //    exists. Until this finishes the job sits in "transferring
        //    input" and looks, to a user, like nothing is happening.
        if (planned.uploads.length) {
          await api.uploadInputs(jobId, planned.uploads);
        }
      }

      setSubmitted(jobId);
      setFiles(emptyFileSet(pipeline.inputs));
      setExample(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>{app.name}</h1>
      <p className="lede">
        {me?.authenticated ? `Signed in as ${me.username}.` : 'Loading…'}
      </p>

      {error && (
        <div className="notice error" role="alert" data-testid="error">
          {error}
        </div>
      )}
      {submitted && (
        <div className="notice success" role="status" data-testid="submitted">
          Submitted job {submitted}. It will appear below.
        </div>
      )}

      {/* WHAT TO RUN COMES FIRST. Each slot's label, hint and `accept`
          belong to the pipeline, so asking for files above this was
          asking people to choose their data before they had said what
          they were doing -- and labelling the pickers for whichever
          pipeline happened to be selected by default. */}
      <PipelineChooser
        pipelines={PIPELINES}
        value={pipeline.id}
        onChange={choosePipeline}
        busy={busy}
      />

      <fieldset>
        <legend>Input files</legend>

        {pipeline.example && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={usingExample}
              disabled={busy}
              onChange={(e) => toggleExample(e.target.checked)}
              data-testid="use-example"
            />
            {pipeline.example.label}
          </label>
        )}
        {usingExample && pipeline.example && (
          <p className="meta" data-testid="example-note">
            {pipeline.example.note}
          </p>
        )}

        {pipeline.inputs.map((slot) => {
          // A single-slot pipeline keeps the plain test ids, so the
          // e2e suite does not have to know which pipeline it is
          // driving. With several slots they are qualified by slot.
          const suffix = pipeline.inputs.length === 1 ? '' : `-${slot.id}`;
          const picked = chosen[slot.id] ?? [];
          return (
            <div className="slot" key={slot.id}>
              <h3>{slot.label}</h3>
              <p className="meta">{slot.hint}</p>
              {usingExample ? (
                // The example's files, shown but not editable. Letting
                // them be removed one at a time would leave a half-
                // example that fails validation for reasons the user
                // did not cause.
                <ul className="files" data-testid={`example-files${suffix}`}>
                  {picked.length === 0 ? (
                    <li className="meta">Nothing in this slot.</li>
                  ) : (
                    picked.map((f) => (
                      <li key={f.name}>
                        <span className="name">{f.name}</span>
                        <span className="size">{formatSize(f.size)}</span>
                      </li>
                    ))
                  )}
                </ul>
              ) : (
                <Dropzone
                  files={picked}
                  onChange={(next) => setSlot(slot.id, next)}
                  disabled={busy}
                  accept={slot.accept}
                  multiple={slot.multiple}
                  inputTestId={`file-input${suffix}`}
                  listTestId={`file-list${suffix}`}
                />
              )}
            </div>
          );
        })}
      </fieldset>

      <fieldset>
        <legend>Settings</legend>
        {/* Whatever this pipeline asks for. The shell does not know
            what these mean; it hands them back on submit. */}
        <pipeline.Controls options={options} onChange={setOptions} busy={busy} />
      </fieldset>

      <button type="button" onClick={() => void run()} disabled={busy} data-testid="submit">
        {busy ? 'Submitting…' : 'Run pipeline'}
      </button>

      <h2>Your runs</h2>
      {jobs.length === 0 ? (
        <p className="meta">Nothing running yet.</p>
      ) : (
        <ul className="jobs" data-testid="job-list">
          {jobs.map((j) => {
            const id = `${j.ClusterId}.${j.ProcId}`;
            const source = pipelineForJob(j.JobBatchName);
            const finished = j.JobStatus === JobStatus.Completed;
            const showing = open === id;
            return (
              <li key={id}>
                <div className="job">
                  <span className="name">
                    {String(j.JobBatchName ?? 'run')} <span className="meta">#{id}</span>
                  </span>
                  <span className="meta">{jobStatusLabel(j)}</span>
                  {finished && source && (
                    <button
                      type="button"
                      className="secondary"
                      aria-expanded={showing}
                      onClick={() => setOpen(showing ? null : id)}
                      data-testid={`results-toggle-${id}`}
                    >
                      {showing ? 'Hide results' : 'Show results'}
                    </button>
                  )}
                  {finished && (
                    // Still here, and still worth having: the page
                    // renders what the result MEANS, and some people
                    // want the bytes.
                    <a href={api.outputUrl(id)}>Download files</a>
                  )}
                  {(j.JobStatus === JobStatus.Idle || j.JobStatus === JobStatus.Running) && (
                    // "Stop", not "Cancel": this holds the job, which
                    // leaves it in the queue where it can be released.
                    // DELETE /jobs/{id} answers 501, so a Cancel button
                    // would be a control that cannot work.
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void api.hold(id).then(refresh)}
                    >
                      Stop
                    </button>
                  )}
                  {j.JobStatus === JobStatus.Held &&
                    j.HoldReasonCode !== HoldReasonCode.SpoolingInput && (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => void api.release(id).then(refresh)}
                      >
                        Try again
                      </button>
                    )}
                </div>
                {showing && source && (
                  <div className="results" data-testid={`results-${id}`}>
                    <source.Results job={j} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}


# Working on this app

This is a **site app** for an HTCondor access point: a static web app served by the access point's API server, to a named group of users, from a zip bundle an operator drops in place.

Read this before writing code. Most of what follows is not guessable from the source.

**How to use this file.** The rules below are mostly scar tissue — each one is a mistake somebody already made, with the reason it was not obvious. When you hit a problem this file does not name, the shape of an answer is usually one of:

- **Ask the server before you guess.** Read `openapi.json` at the repo root *first*, before `api.ts` — the client here is a convenience wrapper over a much larger API, and the routes it does not wrap are the ones you will need. More than one app has shipped a worse design because its author never looked.
- **Go and read the pipelines.** Three worked examples live in `web/src/pipelines/`, behind the picker in the running app:

  - `wordfreq` — start here. One file in, one job, a sortable table from the job's `results.json`, and an awk program generated in the browser so no user text reaches the submit file.
  - `astro` — binary results. A rendered PNG comes back and the page shows it by URL rather than reading its bytes.
  - `blast` — **the DAG trick**: one large shared input, uploaded once instead of once per job.

  `web/src/pipelines/types.ts` is the whole interface, and it is short. Read it before designing anything.

If you solve something this file does not cover, add it here. The next person is in your position with less time.

## The API

The app talks to the HTCondor HTTP API at `/api/v1/*` on its own origin.

**Do not invent endpoints.** The API is larger than `web/src/lib/api.ts` and not larger in the way you are about to assume. Check `openapi.json` in this repository before adding a call — it is a copy of the spec the server serves at `/openapi.json`, committed here so you can read it without a running server. A plausible-looking REST route that does not exist is the single most common failure in this codebase.

**A job you created but never fed cannot be cleaned up.** `POST /jobs` succeeds, then your input upload fails — a dropped connection part-way through a large file. The job now sits held under `SpoolingInput` forever: `hold` is a no-op on an already-held job, `DELETE` answers 501, and **no call your app can make will clear it**. This is not a rare case if your inputs are large; it is the likely failure. Plan for it: upload promptly after submitting, and when the upload fails tell the user plainly which job id was stranded and that an administrator must `condor_rm` it. Saying nothing leaves them with a job they cannot explain or remove.

**Some documented routes are not implemented.** Read each description, not just the path: `DELETE /jobs/{id}` and `PATCH /jobs/{id}` are both in the spec and both answer `501`, and the words "NOT YET IMPLEMENTED" are the only warning. To stop a job, hold it (`POST /jobs/{id}/hold`); call it "stop", not "cancel", because a held job is still in the queue and can be released.

The endpoints this app uses are wrapped in `web/src/lib/api.ts`. Add to that file rather than calling `fetch` from a component.

**Authentication is already done.** The app is served same-origin, so the browser holds the session cookie the user got when they logged in. Every request sends `credentials: 'include'` and that is the whole story. There is no token to store, no refresh, no Authorization header, no login form to build. A 401 means the session expired; `api.ts` redirects to `/login` for you.

**Ask for every job attribute you read.** `GET /jobs` has a default projection — `ClusterId, ProcId, Owner, JobStatus, Cmd, Args` — and returns nothing else. A field you did not request arrives `undefined`, and that does not fail loudly, it *renders*: a finished job whose `ExitCode` was never asked for displays as "Failed (exit undefined)". `JOB_ATTRS` in `api.ts` is the list; add to it before you read a new attribute anywhere. `limit` likewise defaults to 50 and truncates in silence.

**Have the job write JSON, not just prose.** A page handed `{"rows": [...]}` can draw a table, sort it, show the top ten. A page handed a block of text can only put it in a `<pre>` and hope. The job is the only thing that knows the shape of its own results, so emit them structured there — one `printf` — and keep the human-readable text as well.

**Create every declared output file at the START of the job.** HTCondor *holds* a job whose declared output file is missing when it finishes, so a job that writes `results.json` only on success is held on every failure — and held for a transfer error, which says nothing about what actually went wrong. `: > results.json` before any real work costs nothing and lets failures report themselves. `buildSubmitFile` does this from `OUTPUT_FILES`, and a test fails if it stops.

The specifics, from the HTCondor source rather than from memory:

- **The hold is `HoldReasonCode = 13`** (`UploadFileError`), and the reason text is the transfer error, e.g. `Error from slot1@node: error reading from /path/results.json: ...`. It names a file-transfer problem, never the thing your job actually got wrong.
- **One missing file loses the whole set.** The upload returns on the first file it cannot read, so the other declared outputs do not come back either. Pre-create *all* of them, which is why `OUTPUT_FILES` is one list feeding both the declaration and the `: >` lines.
- **`when_to_transfer_output = ON_EXIT` still transfers after a non-zero exit.** The starter transfers whenever the job ran to completion on its own; it skips transfer only when the job was told to exit (evicted or removed). So pre-creating the files genuinely protects the failure path — if it did not, this rule would buy nothing where it matters most.

**Getting one file back — including a picture.** `GET /api/v1/jobs/{id}/files/{filename}` serves a single file from the job's sandbox. That is how a result that is an *image* reaches the page: point an `<img src>` straight at it. Three things that bite:

- **Do not fetch it into a `blob:` URL.** The obvious shape — `fetch` → `Blob` → `URL.createObjectURL` → `<img>` — is blocked by the server's `Content-Security-Policy: default-src 'self'`, because `blob:` is not `'self'`. Nothing throws. The image is simply absent, *and it works perfectly in `make dev`*, which has no CSP. This is the worst kind of failure this platform produces: correct locally, silently broken when deployed.
- **A pre-created output file is a zero-byte file when the job fails.** The rule above says create every declared output at the start, which is right — but an `<img>` pointed at zero bytes renders a broken-image icon, and users read that as "this app is broken" rather than "this job failed". Decide whether a picture exists from your `results.json`, never from whether the file exists.
- Treat a 404 as routine rather than an error: the sandbox is not there before the job finishes, and does not stay forever.

**Keep the structured file small enough to render.** It is what the *page* draws, not an archive. If your results can run to thousands of rows, put the top N in the JSON and the full set in a CSV the user downloads — a browser handed 600 KB of JSON to turn into a table will show it, slowly, and nobody thanks you. The example emits two fields, so it never meets this question; yours will.

**A large shared input is uploaded once per job. There is no shared stage.** If nothing is shared between your jobs — each task has its own inputs and no common reference — this section is moot and the cost is simply the sum of what the user picked. Show them that number anyway. If there *is* a shared input, this is the decision that determines whether your app costs a gigabyte or a hundred, so make it deliberately.

The API offers exactly two ways to get a file to a job: `POST /jobs`, which takes a submit file and nothing else, and `POST /jobs/{id}/input/multipart`, which uploads into **one job's** sandbox — the path is a `cluster.proc`, not a cluster. Nothing stores a file once and hands back a name many jobs can use. So a reference input — a BLAST database, a genome, an atlas, model weights — travels once for every job that needs it, out of the user's uplink and into the access point's spool.

What follows from that:

- **Make the job count a budget, not just a parallelism choice.** `jobs × databaseSize` is what the user uploads. Cap the fan-out by the size of the shared input, and refuse sizes that would be absurd.
- **Tell the user the number before they commit to it.** "Your database (480 MB) is sent once per job, so this uploads 1.9 GB" is the cost of the design, and they are the one paying it.
- **`queue N` does not rescue you.** The submit file is one text shared by every proc, but uploads are per `cluster.proc`, so one `transfer_input_files` line cannot name a different per-task input for each proc. A fan-out app submits one cluster per task group. Reach for `queue N` only when every proc genuinely wants the same inputs.
- **A DAG uploads the shared input once.** This is the trick worth knowing. A DAG is submitted as a single job whose spooled sandbox holds everything the workflow needs — the `.dag` file, the per-node submit files, and the shared input. That sandbox goes up **once**. DAGMan then runs on the access point, in that directory, and submits the node jobs itself; each node names the shared file by its basename and it is already there. The user's uplink carries it one time instead of N, and the access point keeps one copy rather than N. The access point still sends it on to each execute node, but that leg is inside the facility and not the one the user waits on.

  Two constraints that shape the design: the spool is **one flat directory**, so every file is referenced by basename and two inputs cannot share a name; and **nothing can be added after submission**, so everything the workflow will ever need goes up in that one upload.

  **`POST /api/v1/jobs/dag` submits one**, and it takes everything in a single multipart request: the `.dag`, the node submit files, and the shared input together. That is not a convenience — a workflow's spool is written once, and a file missing from the manager job's `transfer_input_files` is *skipped* at spool time rather than rejected, so a submit-then-upload shape would be accepted and silently drop your database. `api.submitDag` in `web/src/lib/api.ts` does this; `web/src/pipelines/blast` is a worked example.

- **Getting a DAG's results back is its own problem, and two tidy-looking answers do not work.** Every node runs in the *same* directory, so a node writing a fixed `results.json` overwrites its neighbours: silently, with no error and no hold, visible only as a results page missing most of the search. Give each node its own output names — and have the job *write* them. `transfer_output_remaps` looks like the right tool and is a trap: it is honoured when the submit file goes through `condor_submit` and **ignored when DAGMan submits the same file itself**, which is what DAGMan does by default. The attribute lands on the job ad either way, so there is nothing to see.

  Then the page has to find those names again after a reload, when it has a job id and nothing else. Spooling a manifest alongside the workflow does not work either: `GET /api/v1/jobs/{id}/output` returns what the job **produced**, and a file uploaded as an input is not in it — the request answers 404 and a perfectly good search reports as unreadable. Read the output sandbox instead and pick the results out by name. It is one request, it contains only outputs (so it stays small however large the shared input was), and a node that never ran is simply absent. `web/src/lib/tar.ts` and `web/src/pipelines/blast/Results.tsx` do this.

- **`RETRY` the failures worth retrying, and excuse the ones that are not.** An evicted job deserves another go; "this pool has no BLAST+ installed" returns the same answer however many times it is asked. `RETRY node 2 UNLESS-EXIT <code>` is the difference between a twenty-second answer and a several-minute one, with the user watching the whole wait. That means the runner needs a distinct exit code for "this node cannot do the job at all", and the DAG and the runner have to agree on it.

- **A URL in `transfer_input_files` would fix this** — the execute node fetches it, once per node rather than once per job, and a site cache can dedupe it entirely. The submit file is passed through verbatim, so you *can* emit one. But nothing here tells you whether this pool's execute nodes have a working transfer plugin for your scheme, and there is no API that reports it. A control that either works or holds every job with a transfer error, with no way to check first, is worse than the upload. **Ask your access point's operator**, and only then.

**Submit, then upload — and the job is HELD until you do.** The server submits with input spooling on, so between `POST /jobs` and the upload every job sits held under `HoldReasonCode 16` (`SpoolingInput`). That is normal. If your interface renders Held as "stopped" or "failed", it says so about every job the moment the user submits it, which is the first thing they will ever see. `jobStatusLabel` names this case, and `HoldReasonCode` is in `JOB_ATTRS` so it can. `POST /api/v1/jobs` creates the job; `POST /api/v1/jobs/{id}/input/multipart` sends its input files afterwards. Between the two the job sits in a transferring-input state that users read as "stuck". Do not reorder these, and do surface that state as something other than silence.

**Do not set site policy in the submit file.** The server applies this access point's own defaults and overrides — a required log location, an accounting group, a concurrency limit — to everything this app submits. Writing them here is at best redundant and at worst fights the operator.

## Platform constraints

These are properties of the server, not preferences. Violating one produces a page that works in `make dev` and breaks when deployed.

- **`Content-Security-Policy: default-src 'self'`.** No CDN scripts, no Google Fonts, no external images, no `eval`. Vendor everything into `web/src/`. A dependency that injects a remote script at runtime will not work.
- **Build with a relative base.** `base: './'` in `web/vite.config.ts`. Never hardcode `/site/<id>/`: the app's id is the bundle's file name, which the operator chooses and may change to stage a new version.
- **Read `window.__HTCONDOR_APP__.base` for routing**, via `web/src/lib/htcondor.ts`. Do not infer the mount point from `location.pathname` — it is wrong exactly when the user reloads on a sub-route.
- **`app.yaml` must not contain a `groups` key.** Who may see this app is the operator's decision, made in the access point's configuration (`HTTP_API_SITE_APP_<ID>_GROUPS`). A bundle that names groups is refused outright, because the app's author has no idea which groups exist at a given site and their natural placeholder is "everyone".
- **Nothing in this repository is secret.** The bundle is static files served to every member of its groups. An API key, a password or a token committed here is disclosed to all of them. If the app needs a credential, it belongs in the job, obtained through the credential endpoints — not in the bundle.

## Who uses this

Domain experts who are not computing experts. They are not adversaries and they are not fools; they simply did not come here to learn about batch systems.

- Prefer one obvious control over three flexible ones. If a knob has a right answer for this lab, set it in code and do not show it.
- **Never surface a raw submit file, a ClassAd expression, a `HoldReasonCode` or a bare exit status.** Translate. `jobStatusLabel` in `api.ts` is the pattern: say what happened in words, and prefer being specific about the common case over being accurate about all of them.
- An error message must say what to do next. "Submission failed" is not an error message. The API's own messages are written to be read by the person who hit them — surface them rather than replacing them with your own.
- Jobs wait. A queued job is normal, not broken, and the interface should say which it is without being asked.

## The loop

```
make check    # lint, typecheck, unit tests, build — run before claiming anything works
make e2e      # real server in Docker; run for anything touching submission
make bundle   # the deliverable: dist/<app>.zip plus its sha256
```

`make check` is what CI runs first, so a failure here is a failure there.

Changes to `web/src/lib/submit.ts` or to any pipeline's submit builder always need `make e2e`. The unit tests check the submit file's text; only a real schedd tells you whether it is a submit file it will accept.

**Do not add a dependency without saying why in the commit message.** Every one of them ships to users inside the bundle and has to satisfy the CSP.

## Shape of the repository

```
app.yaml              name and description. No groups, no id.
Makefile              make help
web/src/lib/htcondor.ts   where am I, who is looking (platform integration)
web/src/lib/api.ts        typed API client — extend this, don't bypass it
web/src/pipelines/        THIS is your science: one directory per pipeline
web/src/lib/submit.ts     escaping, naming, sizing — shared by all of them
web/src/app.tsx           the shell: identity, pickers, submit, job list, results
e2e/                      playwright against a real server
scripts/e2e.sh            starts the server, deploys the bundle, runs the suite
```

`web/src/pipelines/<name>/` is what is actually about this lab's work; `web/src/lib/submit.ts` is the shared half every pipeline builds on, and a mistake there is a security bug rather than a job that does not start. The quoting helpers in it are not decoration: `$` in a submit file is a macro substitution, and `$ENV(...)` reads the *server's* environment, so a file name a user typed must be escaped before it goes anywhere near a submit command.

// The two stages, as submit files and as the scripts that run in them.
//
// AlphaFold3 is a two-stage workflow and that shape is the whole
// reason this app is a DAG:
//
//   alignments (CPU)   searches ~650 GB of reference databases and
//                      writes <job>.data_pipeline.tar.gz
//   structure  (GPU)   reads that tarball and the model weights, and
//                      writes <job>.inference_pipeline.tar.gz
//
// The second needs the first, per job, which is a PARENT/CHILD edge --
// and the file that crosses the edge is produced into the workflow's
// own flat spool directory, where the child finds it by name. Nothing
// is uploaded between the stages and nothing is downloaded in between.
//
// FOUR THINGS HERE ARE NOT OBVIOUS, all of them about that flat spool:
//
//  1. THE TARBALL'S NAME IS LOAD-BEARING. The wrapper writes a fixed
//     `data_pipeline.tar.gz`, and the inference wrapper looks for
//     `*.data_pipeline.tar.gz` -- which that name does NOT match, since
//     the glob needs a dot before it. Both tutorials bridge the gap
//     with `transfer_output_remaps`, which works under condor_submit
//     and is IGNORED when DAGMan submits the file itself. So the data
//     runner renames the file, in the job, and the remap is not used.
//     (Without the rename the inference stage reports "no input" after
//     waiting for a GPU.)
//
//  2. Every node runs in the SAME directory, so two jobs writing
//     `data_pipeline.tar.gz` would overwrite each other silently.
//     Every name below carries the job's tag.
//
//  3. ONE runner script is spooled for the whole workflow. Everything
//     that differs between jobs reaches it through `environment`.
//     Generating it from one job's values would make every other job
//     fold that job's molecule and report it under its own name.
//
//  4. `on_exit_hold = (ExitCode != 0)` is in both tutorials' submit
//     files and is deliberately NOT here. Under DAGMan a held node is
//     not a failed node: the workflow waits for it for ever, and the
//     user is left watching a DAG that will never finish. Failing is
//     what lets RETRY, UNLESS-EXIT and the results page do their jobs.

import { adString, quote } from '../../lib/submit';
import { requestedVramGB } from './foldinput';
import type { SiteConfig } from './site';

/** What every batch name from this pipeline starts with. */
export const BATCH_PREFIX = 'alphafold3-';

/**
 * The runner's exit code for "this machine cannot run AlphaFold3".
 *
 * No container, or no wrapper script. It is the same answer however
 * many times it is asked, so the DAG excuses it from RETRY: without
 * that, a misconfigured site costs three attempts and several minutes
 * per node to arrive at the message it had in the first ten seconds.
 */
export const EXIT_NO_AF3 = 70;

/** Its input was missing or empty. Retrying cannot conjure it. */
export const EXIT_NO_INPUT = 65;

export const DATA_RUNNER = 'af3_data.sh';
export const INFERENCE_RUNNER = 'af3_infer.sh';

/** The wrapper scripts, by the names both tutorials give them. */
export const DATA_TOOL = 'data_pipeline.sh';
export const INFERENCE_TOOL = 'inference_pipeline.sh';

export function foldInputFile(tag: string): string {
  return `${tag}.fold_input.json`;
}
/** Note the dot: `<tag>.data_pipeline.tar.gz` is what the inference
 *  wrapper's `*.data_pipeline.tar.gz` glob looks for. */
export function dataTarball(tag: string): string {
  return `${tag}.data_pipeline.tar.gz`;
}
export function inferenceTarball(tag: string): string {
  return `${tag}.inference_pipeline.tar.gz`;
}
export const DATA_STATUS_PREFIX = 'data-';
export const INFERENCE_STATUS_PREFIX = 'infer-';
export function dataStatusFile(tag: string): string {
  return `${DATA_STATUS_PREFIX}${tag}.json`;
}
export function inferenceStatusFile(tag: string): string {
  return `${INFERENCE_STATUS_PREFIX}${tag}.json`;
}
/** The tag a status file belongs to, or '' if it is not one. */
export function tagOfStatusFile(name: string): string {
  const m = /^(?:data|infer)-(.+)\.json$/.exec(name);
  return m ? m[1] : '';
}

/**
 * Somewhere a job can be told to fetch a file from: a URL, or an
 * absolute path on the access point.
 *
 * An absolute path works here and would not work for an ordinary job
 * submitted through this API, which is worth knowing. The API server
 * does not share a filesystem with the access point, so a plain job's
 * inputs have to be uploaded into its spool. A DAG's node jobs are
 * submitted by DAGMan, ON the access point, so their input files are
 * read from the access point's own disk -- which is how a 3 GB model
 * weights file reaches a GPU without going through a browser.
 *
 * An allow-list. Everything rejected here either ends a submit command
 * (a newline), starts a macro expansion (`$`), separates one file from
 * the next (`,`), or is shell punctuation that has no business in a
 * path.
 */
const REFERENCE_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/[^\s"'`$,;|&<>\\]+|\/[^\s"'`$,;|&<>\\]+)$/;

export function isSafeReference(ref: string): boolean {
  // A trailing slash is not a file: in transfer_input_files it asks
  // for a DIRECTORY's contents, which arrives as something other than
  // the one file the job was told to expect.
  return (
    ref.length > 0 && ref.length <= 1024 && !ref.endsWith('/') && REFERENCE_RE.test(ref)
  );
}

/** The file name a reference ends in, e.g. `af3.bin.zst`. */
export function referenceBasename(ref: string): string {
  const path = ref.replace(/[?#].*$/, '');
  const parts = path.split('/').filter((p) => p !== '');
  return parts.length ? parts[parts.length - 1] : '';
}

/** One file from a staging base, e.g. `<base>/data_pipeline.sh`. */
export function toolReference(base: string, tool: string): string {
  return base === '' ? '' : `${base.replace(/\/+$/, '')}/${tool}`;
}

// --------------------------------------------------------------- runners

/**
 * What a whole RUN needs. Deliberately holds nothing about any one
 * job: the runners below are generated from this and shipped once for
 * the entire workflow, and the only thing that varies between nodes --
 * the job's tag -- arrives in `environment`.
 */
export interface RunSpec {
  site: SiteConfig;
  /** '' when the user is only running the alignment stage. */
  weights: string;
}

/** Shell-quote. Single quotes, with the usual escape dance. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The part of both runners that is the same, including the writing of
 *  the status file -- which happens on EVERY path, so a job that could
 *  not start still explains itself on the results page. */
function runnerPreamble(stage: 'data' | 'inference', tool: string, statusPrefix: string): string {
  return `#!/bin/bash
# Generated by the AlphaFold3 site app. Edit the app, not this file.
#
# ONE copy of this script is spooled for the whole workflow. The job it
# is running is in AF3_TAG and nowhere else.
set -u

TAG="\${AF3_TAG:-}"
if [ -z "$TAG" ]; then
  echo "AF3_TAG is not set; the submit file and this script disagree." >&2
  exit ${EXIT_NO_INPUT}
fi
STAGE=${shQuote(stage)}
TOOL=${shQuote(tool)}
STATUS="${statusPrefix}$TAG.json"
RUNDIR="run.$TAG"
LOG="log-$STAGE-$TAG.txt"
: > "$LOG"

# Control characters out, backslash and quote escaped: this text goes
# into JSON the results page parses.
esc() {
  printf '%s' "$1" | tr '\\n\\t' '  ' | tr -d '\\000-\\037' | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g'
}

# The last of the log, for a message that says what actually happened
# rather than only that something did.
logtail() {
  tail -c 800 "$LOG" 2>/dev/null | tr '\\n\\t' '  ' | tr -d '\\000-\\037' | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g'
}

# $1 status, $2 message, $3 exit code, $4 optional extra JSON fields
finish() {
  printf '{"schema":1,"stage":"%s","job":"%s","status":"%s","message":"%s","exit":%d,"log":"%s"%s}\\n' \\
    "$(esc "$STAGE")" "$(esc "$TAG")" "$(esc "$1")" "$(esc "$2")" "$3" "$(logtail)" "\${4:-}" \\
    > "$STATUS"
  exit "$3"
}

# Where the wrapper script is. It may have been staged with the
# workflow, be on PATH inside the container, or be in one of the places
# the published containers put it. If it is in none of them, saying so
# is the only useful thing this job can do -- and saying it once,
# because no number of retries will change the answer.
find_tool() {
  if [ -s "./$TOOL" ]; then printf '%s' "./$TOOL"; return 0; fi
  p=$(command -v "$TOOL" 2>/dev/null) && [ -n "$p" ] && { printf '%s' "$p"; return 0; }
  for d in /opt/alphafold3 /usr/local/bin /opt/af3 /alphafold3; do
    if [ -s "$d/$TOOL" ]; then printf '%s' "$d/$TOOL"; return 0; fi
  done
  return 1
}

WRAPPER=$(find_tool) || finish error \\
  "AlphaFold3 is not available on the machine that ran this job: it has no $TOOL. Stage the AlphaFold3 wrapper scripts where this access point's jobs can read them and set toolsBase in the app's site settings, or ask your administrator which container to use." \\
  ${EXIT_NO_AF3}

# Absolute from here on. The wrapper is run from a directory of its
# own, and "./data_pipeline.sh" -- which is where it is found when the
# site stages it with the workflow -- does not exist from in there.
case "$WRAPPER" in
  /*) ;;
  *) WRAPPER="$PWD/\${WRAPPER#./}" ;;
esac
`;
}

export function buildDataRunner(spec: RunSpec): string {
  const workers = Math.max(1, Math.min(spec.site.msaWorkers, spec.site.dataCpus));
  return `${runnerPreamble('data', DATA_TOOL, DATA_STATUS_PREFIX)}
INPUT="$TAG.fold_input.json"
OUT="$TAG.data_pipeline.tar.gz"

if [ ! -s "$INPUT" ]; then
  finish error "This job's sequence file did not arrive. Submitting the run again is the fix; if it keeps happening, say so to your administrator." ${EXIT_NO_INPUT}
fi

# The wrapper moves EVERY *.json in its directory into AlphaFold3's
# input directory, so it is given a directory of its own holding one
# file. In the workflow's own directory it would have swept up every
# other job's sequences and this job's results file with them.
rm -rf "$RUNDIR"
mkdir -p "$RUNDIR" || finish error "Could not create a working directory. The machine that ran this job may be out of disk." 1
cp "$INPUT" "$RUNDIR/fold_input.json" || finish error "Could not read this job's sequence file." ${EXIT_NO_INPUT}

# --msa_cpus_per_worker 1 and scale with workers: that is what both
# tutorials recommend, and the product must not exceed request_cpus.
( cd "$RUNDIR" && bash "$WRAPPER" --work_dir_ext "$TAG" --msa_cpus_per_worker 1 --msa_workers ${workers} ) >> "$LOG" 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then
  finish error "The alignment stage failed. AlphaFold3 said: $(logtail)" "$rc"
fi

# THE RENAME. The wrapper writes data_pipeline.tar.gz; the inference
# stage globs for *.data_pipeline.tar.gz, which that name does not
# match. transfer_output_remaps would do this under condor_submit and
# does nothing at all under DAGMan.
produced=$(ls -1 "$RUNDIR"/*data_pipeline.tar.gz 2>/dev/null | head -n 1)
if [ -z "$produced" ] || [ ! -s "$produced" ]; then
  finish error "The alignment stage finished but produced no alignments. The log ends: $(logtail)" 1
fi
mv "$produced" "$OUT" || finish error "Could not keep the alignments this job produced." 1
rm -rf "$RUNDIR"

size=$(wc -c < "$OUT" | tr -d ' ')
finish ok "" 0 ",\\"bytes\\":$size"
`;
}

export function buildInferenceRunner(spec: RunSpec): string {
  const weightsFile = referenceBasename(spec.weights);
  return `${runnerPreamble('inference', INFERENCE_TOOL, INFERENCE_STATUS_PREFIX)}
IN="$TAG.data_pipeline.tar.gz"
OUT="$TAG.inference_pipeline.tar.gz"
WEIGHTS=${shQuote(weightsFile)}

if [ ! -s "$IN" ]; then
  finish error "The alignments from the first stage did not arrive, so there is nothing to fold." ${EXIT_NO_INPUT}
fi
if [ ! -s "$WEIGHTS" ]; then
  finish error "The AlphaFold3 model weights ($WEIGHTS) did not arrive with this job. They are licensed from Google DeepMind and are not part of this app: check the location given in the form, and that the file is readable where it is staged." ${EXIT_NO_INPUT}
fi

rm -rf "$RUNDIR"
mkdir -p "$RUNDIR" || finish error "Could not create a working directory. The machine that ran this job may be out of disk." 1
cp "$IN" "$RUNDIR/" || finish error "Could not read this job's alignments." ${EXIT_NO_INPUT}
cp "$WEIGHTS" "$RUNDIR/" || finish error "Could not read the model weights." ${EXIT_NO_INPUT}

( cd "$RUNDIR" && bash "$WRAPPER" --model_param_file "$WEIGHTS" --work_dir_ext "$TAG" ) >> "$LOG" 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then
  finish error "The structure prediction failed. AlphaFold3 said: $(logtail)" "$rc"
fi

produced=$(ls -1 "$RUNDIR"/*inference_pipeline.tar.gz 2>/dev/null | head -n 1)
if [ -z "$produced" ] || [ ! -s "$produced" ]; then
  finish error "The structure prediction finished but produced no structures. The log ends: $(logtail)" 1
fi
mv "$produced" "$OUT" || finish error "Could not keep the structures this job produced." 1
rm -rf "$RUNDIR"

# The confidence numbers, out of the archive, so the page can show a
# result instead of a download link. Every step of this is allowed to
# fail: a missing number is omitted, never guessed.
rank=""
ptm=""
iptm=""
conf=$(tar tzf "$OUT" 2>/dev/null | grep 'summary_confidences.json$' | head -n 1)
if [ -n "$conf" ]; then
  if tar xzf "$OUT" -O "$conf" > confidences.json 2>/dev/null; then
    num() { sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*\\(-\\{0,1\\}[0-9][0-9.eE+-]*\\).*/\\1/p' confidences.json | head -n 1; }
    rank=$(num ranking_score)
    ptm=$(num ptm)
    iptm=$(num iptm)
  fi
  rm -f confidences.json
fi
extra=""
[ -n "$rank" ] && extra="$extra,\\"ranking_score\\":$rank"
[ -n "$ptm" ] && extra="$extra,\\"ptm\\":$ptm"
[ -n "$iptm" ] && extra="$extra,\\"iptm\\":$iptm"
size=$(wc -c < "$OUT" | tr -d ' ')
extra="$extra,\\"bytes\\":$size"

finish ok "" 0 "$extra"
`;
}

// ---------------------------------------------------------- submit files

/** One node job: which stage, which job, and what it needs. */
export interface NodeSpec {
  tag: string;
  /** Tokens in this job, for the GPU memory request. */
  tokens: number;
}

function attributeLines(attrs: Record<string, string>): string[] {
  return Object.entries(attrs).map(([k, v]) => `+${k} = ${quote(v)}`);
}

function commandLines(cmds: Record<string, string>): string[] {
  return Object.entries(cmds).map(([k, v]) => `${k} = ${quote(v)}`);
}

/**
 * The lines both stages share.
 *
 * `: >` on every declared output before anything else runs: HTCondor
 * HOLDS a job whose declared output is missing when it ends, and holds
 * it for a file-transfer error that says nothing about what went
 * wrong. Done here, in `arguments`, rather than inside the runner, so
 * that even a runner that cannot start fails as itself.
 */
function common(runner: string, outputs: string[], tag: string, stage: string): string[] {
  const prepare = outputs.map((f) => `: > ${f}`).join('; ');
  return [
    `executable = /usr/bin/env`,
    `transfer_executable = false`,
    `arguments = "bash -c '${prepare}; exec bash ${runner}'"`,
    ``,
    // The only thing that differs between the nodes sharing this
    // runner. Tags are checked against isSafeFileName upstream of
    // here, so there is nothing in one to quote.
    `environment = ${adString(`AF3_TAG=${tag}`)}`,
    ``,
    `should_transfer_files = YES`,
    `when_to_transfer_output = ON_EXIT`,
    `output = stdout-${stage}-${tag}.txt`,
    `error = stderr-${stage}-${tag}.txt`,
  ];
}

export function buildDataSubmit(spec: RunSpec, node: NodeSpec): string {
  const site = spec.site;
  const outputs = [dataTarball(node.tag), dataStatusFile(node.tag)];
  const inputs = [DATA_RUNNER, foldInputFile(node.tag)];
  const tool = toolReference(site.toolsBase, DATA_TOOL);
  if (tool !== '') inputs.push(tool);

  return [
    `# AlphaFold3, stage 1 of 2: alignments. CPU only.`,
    ...(site.containerImage ? [`container_image = ${quote(site.containerImage)}`] : []),
    ...common(DATA_RUNNER, outputs, node.tag, 'data'),
    ``,
    `transfer_input_files = ${inputs.map(quote).join(',')}`,
    `transfer_output_files = ${outputs.join(',')}`,
    ``,
    `request_cpus = ${site.dataCpus}`,
    `request_memory = ${quote(site.dataMemory)}`,
    `request_disk = ${quote(site.dataDisk)}`,
    ...(site.dataRequirements ? [`requirements = ${quote(site.dataRequirements)}`] : []),
    ``,
    // The tutorials ask for this by name: "We use this condition for
    // internal logic and reporting, please do not remove."
    `+is_alphafold3 = true`,
    ...attributeLines(site.dataAttributes),
    ``,
    `queue 1`,
    ``,
  ].join('\n');
}

export function buildInferenceSubmit(spec: RunSpec, node: NodeSpec): string {
  const site = spec.site;
  const outputs = [inferenceTarball(node.tag), inferenceStatusFile(node.tag)];
  const inputs = [INFERENCE_RUNNER, dataTarball(node.tag), spec.weights];
  const tool = toolReference(site.toolsBase, INFERENCE_TOOL);
  if (tool !== '') inputs.push(tool);

  return [
    `# AlphaFold3, stage 2 of 2: structure prediction. One GPU.`,
    `#`,
    `# The alignments arrive from this job's parent, which wrote them`,
    `# into the workflow's directory under the name below.`,
    ...(site.containerImage ? [`container_image = ${quote(site.containerImage)}`] : []),
    ...common(INFERENCE_RUNNER, outputs, node.tag, 'infer'),
    ``,
    `transfer_input_files = ${inputs.map(quote).join(',')}`,
    `transfer_output_files = ${outputs.join(',')}`,
    ``,
    `request_cpus = 1`,
    `request_gpus = 1`,
    `request_memory = ${quote(site.inferenceMemory)}`,
    `request_disk = ${quote(site.inferenceDisk)}`,
    // From this job's token count. The units are written out: a bare
    // number here is megabytes, so `32` would ask for 32 MB of GPU
    // memory and match the first card it saw.
    `gpus_minimum_memory = ${requestedVramGB(node.tokens)} GB`,
    ``,
    `+is_alphafold3 = true`,
    ...attributeLines(site.inferenceAttributes),
    ...commandLines(site.inferenceCommands),
    ``,
    `queue 1`,
    ``,
  ].join('\n');
}

/** A batch name that groups one run's jobs. Safe by construction. */
export function batchNameFor(when = new Date()): string {
  const stamp = when.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${BATCH_PREFIX}${stamp}`;
}

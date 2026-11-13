// BLAST: one shared database, many query files.
//
// This is the pipeline that exists to show the DAG trick, so read it
// for that even if you will never run BLAST.
//
// The obvious shape -- one job per query file, each declaring the
// database in transfer_input_files -- uploads the database once per
// job. An earlier version of this example did exactly that, and had to
// cap a search at 40 jobs and chunk the queries to stay inside a 4 GB
// upload budget. The limit was the user's uplink, not the pool.
//
// A DAG removes it. The workflow is submitted as ONE job whose spooled
// sandbox holds the .dag, the node submit files, the runner and the
// database. That goes up once. DAGMan then runs on the access point,
// in that directory, and submits the node jobs itself; each node names
// the database by basename and it is already there. The access point
// still sends it on to each execute node, but that leg is inside the
// facility and not the one the user waits on.
//
// Two constraints shape everything below. The spool is one FLAT
// directory, so every file is referenced by basename and two inputs
// cannot share a name. And nothing can be added after submission, so
// everything the workflow will ever need goes up in that one request.

import { adString, isSafeFileName, quote } from '../../lib/submit';

// ---------------------------------------------------------------- BLAST

export type ProgramId = 'blastn' | 'blastp' | 'blastx' | 'tblastn';

export interface Program {
  id: ProgramId;
  /** What the biologist is choosing, in their words. */
  label: string;
  /** What makeblastdb needs when the database arrives as FASTA. */
  dbType: 'nucl' | 'prot';
}

export const PROGRAMS: readonly Program[] = [
  { id: 'blastn', label: 'DNA sequences against a DNA database (blastn)', dbType: 'nucl' },
  { id: 'blastp', label: 'Protein sequences against a protein database (blastp)', dbType: 'prot' },
  { id: 'blastx', label: 'DNA sequences against a protein database (blastx)', dbType: 'prot' },
  { id: 'tblastn', label: 'Protein sequences against a DNA database (tblastn)', dbType: 'nucl' },
];

export function programById(id: string): Program {
  return PROGRAMS.find((p) => p.id === id) ?? PROGRAMS[0];
}

/**
 * E-value choices, loosest last. A free-text box here invites `1e-5 ;
 * rm -rf` and, far more often, a typo that silently returns nothing.
 */
export const EVALUES = [
  { value: '1e-50', label: 'Only near-identical matches (1e-50)' },
  { value: '1e-20', label: 'Strong matches (1e-20)' },
  { value: '1e-5', label: 'Good matches (1e-5) — usual choice' },
  { value: '0.01', label: 'Weak matches too (0.01)' },
  { value: '10', label: 'Everything, including noise (10)' },
] as const;

export const MAX_HITS = [5, 25, 100, 500] as const;

export function isValidEvalue(v: string): boolean {
  return EVALUES.some((e) => e.value === v);
}

export function isValidMaxHits(n: number): boolean {
  return (MAX_HITS as readonly number[]).includes(n);
}

/** How the database arrived, decided in the browser so the job does not
 *  have to sniff it. */
export type DatabaseKind = 'blastdb-archive' | 'fasta-gz' | 'fasta';

const ARCHIVE_SUFFIXES = ['.tar.gz', '.tgz', '.tar.bz2', '.tbz', '.tar'];

export function databaseKind(originalName: string): DatabaseKind {
  const n = originalName.toLowerCase();
  if (ARCHIVE_SUFFIXES.some((s) => n.endsWith(s))) return 'blastdb-archive';
  if (n.endsWith('.gz')) return 'fasta-gz';
  return 'fasta';
}

/**
 * The name the database has inside the sandbox.
 *
 * Deliberately NOT the name the user gave it. The sandbox name is
 * chosen here so it can never collide with a query file, never need
 * quoting, and never carry a surprise through the submit file. The
 * user's own name is still reported back in results.json.
 */
export function databaseFileName(originalName: string): string {
  switch (databaseKind(originalName)) {
    case 'blastdb-archive':
      return originalName.toLowerCase().endsWith('.tar') ? 'database.tar' : 'database.tar.gz';
    case 'fasta-gz':
      return 'database.fasta.gz';
    default:
      return 'database.fasta';
  }
}


/** Quote a value for the shell. Single quotes, with the escape dance. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Flatten a user string to one line of printable text for a label. */
export function displayText(value: string, max = 120): string {
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max) || 'database'
  );
}


/** Cores each node job asks for, and the value passed to -num_threads. */
export const JOB_CPUS = 2;

/** How many hits the structured result carries. */
export const TOP_HITS = 100;

/** The runner, by the name it has in the spool. */
export const RUNNER_FILE = 'blast_run.sh';

/**
 * The runner's exit code for "this node cannot do the job at all".
 *
 * It means BLAST+ is not installed on the machine that ran it. Every
 * other failure here is worth another go -- an evicted job, a node
 * that died -- but this one fails identically however many times it is
 * tried, so the DAG is told not to retry it. Without that a search on
 * a pool with no BLAST+ spends three attempts and several minutes
 * arriving at the message it had in the first twenty seconds.
 */
export const EXIT_NO_BLAST = 70;

/**
 * What node `node` brings back, by the names it writes.
 *
 * EVERY NODE OF A DAG RUNS IN THE SAME DIRECTORY -- the workflow's
 * spool is one flat directory and DAGMan runs in it -- so a fixed
 * `results.json` means every node but the last is thrown away.
 * Silently: no error, no hold, just a results page missing most of the
 * search.
 *
 * The names are therefore unique per node, and the JOB WRITES THEM
 * DIRECTLY. The obvious alternative, `transfer_output_remaps`, is a
 * trap here: it works when the submit file goes through condor_submit
 * and is ignored when DAGMan submits the same file itself, which is
 * what DAGMan does by default. The attribute is on the job ad either
 * way, so the failure looks like nothing at all -- the files simply
 * come back under their original names and overwrite each other.
 */
export function outputFiles(node: string): string[] {
  return [resultsFile(node), hitsFile(node)];
}

export function resultsFile(node: string): string {
  return `results-${node}.json`;
}

export function hitsFile(node: string): string {
  return `hits-${node}.tsv`;
}

/** The prefix the results page looks for in a finished workflow. */
export const RESULTS_PREFIX = 'results-';

/**
 * Never upload more than this as a database. A browser upload of more
 * than a couple of gigabytes is an hour of waiting followed by a
 * failure, and a database that size belongs on the access point's own
 * storage, staged by a facilitator, not pushed through a web form.
 */
export const MAX_DATABASE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Query files per node job.
 *
 * With the database spooled once, this is no longer an upload budget:
 * it only decides how much the pool parallelises. Small groups mean
 * more jobs and more scheduling; one job per file is usually right
 * until there are hundreds.
 */
export const QUERIES_PER_NODE = 1;

/** What one node job runs over. */
export interface JobSpec {
  /** This node's name in the DAG. Also what its outputs are named by. */
  node: string;
  program: ProgramId;
  evalue: string;
  maxHits: number;
  /** The name the user gave the database, reported in results. */
  databaseLabel: string;
  databaseKind: DatabaseKind;
  /** The database's name in the sandbox. */
  databaseFile: string;
  /** Query file names for THIS node. */
  queryNames: string[];
  databaseBytes: number;
  /** Bytes of this node's queries, for the disk estimate. */
  queryBytes: number;
}

export function buildRunnerScript(spec: JobSpec): string {
  const program = programById(spec.program);
  const label = displayText(spec.databaseLabel);
  const evalue = isValidEvalue(spec.evalue) ? spec.evalue : '1e-5';
  const maxHits = isValidMaxHits(spec.maxHits) ? spec.maxHits : 25;

  return `#!/bin/bash
# Generated by the BLAST site app. Edit the app, not this file.
set -u

# This node's name and its queries, from the submit file's environment
# command rather than baked in here: ONE runner is spooled for the
# whole workflow. An earlier version generated it from the FIRST node's
# spec, so every other node searched a file it had never been given and
# reported it as empty -- a wrong answer, with nothing in any log.
NODE="\${BLAST_NODE:-q0}"
RESULTS="results-$NODE.json"
HITS="hits-$NODE.tsv"
# Query names pass isSafeFileName, so there is no separator to collide
# with and no quoting to get wrong.
IFS=',' read -ra QUERIES <<< "\${BLAST_QUERIES:-}"

PROGRAM=${shQuote(program.id)}
DBTYPE=${shQuote(program.dbType)}
DBFILE=${shQuote(spec.databaseFile)}
DBKIND=${shQuote(spec.databaseKind)}
DBLABEL=${shQuote(label)}
EVALUE=${shQuote(evalue)}
MAXHITS=${maxHits}
THREADS=${JOB_CPUS}
TOPN=${TOP_HITS}

: > status.tsv
: > top.tsv
: > run.log
: > query.log

# The last few lines of a log, flattened into one line for a message.
# Backslashes go too: this text is passed to awk -v, which reads them as
# escape sequences.
logtail() { tail -n 3 "$1" 2>/dev/null | tr '\\n\\\\' '  '; }

# Writes this node's results file and exits. Called on every path,
# including every failure, so the page always has something to show.
#   $1 overall status, $2 message for the user, $3 exit code
finish() {
  awk -v status="$1" -v message="$2" \\
      -v program="$PROGRAM" -v dblabel="$DBLABEL" -v evalue="$EVALUE" \\
      -v maxhits="$MAXHITS" -v topn="$TOPN" '
    function esc(s) { gsub(/[\\001-\\037\\177]/, " ", s); gsub(/\\\\/, "\\\\\\\\", s); gsub(/"/, "\\\\\\"", s); return s }
    FNR == NR { qf[++nq] = $1; qs[nq] = $2; qh[nq] = $3 + 0; total += $3 + 0; next }
    { th[++nt] = $0 }
    END {
      printf "{\\"schema\\":1"
      printf ",\\"status\\":\\"%s\\"", esc(status)
      printf ",\\"message\\":\\"%s\\"", esc(message)
      printf ",\\"program\\":\\"%s\\"", esc(program)
      printf ",\\"database\\":\\"%s\\"", esc(dblabel)
      printf ",\\"evalue\\":\\"%s\\"", esc(evalue)
      printf ",\\"max_hits_per_sequence\\":%d", maxhits
      printf ",\\"total_hits\\":%d", total
      printf ",\\"queries\\":["
      for (i = 1; i <= nq; i++)
        printf "%s{\\"file\\":\\"%s\\",\\"status\\":\\"%s\\",\\"hits\\":%d}", (i > 1 ? "," : ""), esc(qf[i]), esc(qs[i]), qh[i]
      printf "]"
      printf ",\\"top_hits\\":["
      for (i = 1; i <= nt; i++) {
        n = split(th[i], c, "\\t")
        if (n < 13) continue
        printf "%s{\\"query_file\\":\\"%s\\",\\"query\\":\\"%s\\",\\"subject\\":\\"%s\\",\\"identity\\":%s,\\"length\\":%d,\\"evalue\\":\\"%s\\",\\"bits\\":%s}", \\
          (i > 1 ? "," : ""), esc(c[1]), esc(c[2]), esc(c[3]), c[4] + 0, c[5] + 0, esc(c[12]), c[13] + 0
      }
      printf "]"
      printf ",\\"top_hits_truncated\\":%s", (total > topn ? "true" : "false")
      printf "}\\n"
    }
  ' status.tsv top.tsv > "$RESULTS"
  exit "$3"
}

# One line of plain-language advice per failure. "It did not work" is
# not a message; "ask your administrator for BLAST+" is.
need() {
  command -v "$1" >/dev/null 2>&1 && return 0
  finish error "The compute node that ran this job does not have $1 installed. Ask your system administrator to make the BLAST+ tools available on the pool, then run this search again." ${EXIT_NO_BLAST}
}

need "$PROGRAM"

printf 'query_file\\tquery_id\\tsubject_id\\tpct_identity\\talignment_length\\tmismatches\\tgap_opens\\tq_start\\tq_end\\ts_start\\ts_end\\tevalue\\tbit_score\\n' > "$HITS"

# ---- the database, prepared once per job and then reused by every query
DBDIR=blastdb
mkdir -p "$DBDIR"
DB=

if [ ! -s "$DBFILE" ]; then
  finish error "The reference database did not arrive with this job, or arrived empty. Submit the search again; if it keeps happening the database file may be too large to upload." 65
fi

case "$DBKIND" in
  blastdb-archive)
    if ! tar -xf "$DBFILE" -C "$DBDIR" >> run.log 2>&1; then
      finish error "The database archive could not be unpacked. It should be a .tar.gz of a BLAST database directory, or a plain FASTA file." 65
    fi
    index=$(find "$DBDIR" -maxdepth 4 \\( -name '*.nin' -o -name '*.pin' -o -name '*.nal' -o -name '*.pal' \\) 2>/dev/null | sort | head -n 1)
    if [ -n "$index" ]; then
      DB="\${index%.*}"
      # Volume files are named db.00.nin, db.01.nin ... strip the volume.
      case "$DB" in *.[0-9][0-9]) DB="\${DB%.*}" ;; esac
    else
      fasta=$(find "$DBDIR" -maxdepth 4 -type f \\( -name '*.fa' -o -name '*.fasta' -o -name '*.fna' -o -name '*.faa' \\) 2>/dev/null | sort | head -n 1)
      if [ -z "$fasta" ]; then
        finish error "No BLAST database and no FASTA file were found inside the archive. Upload either a prepared BLAST database (the .nin/.nsq files) or a FASTA file and let the job prepare it." 65
      fi
      need makeblastdb
      if ! makeblastdb -in "$fasta" -dbtype "$DBTYPE" -out "$DBDIR/reference" -title reference >> run.log 2>&1; then
        finish error "Preparing the database from $(basename "$fasta") failed. Check that it is $DBTYPE sequence in FASTA format. Details: $(logtail run.log)" 65
      fi
      DB="$DBDIR/reference"
    fi
    ;;
  fasta-gz|fasta)
    if [ "$DBKIND" = fasta-gz ]; then
      if ! gunzip -c "$DBFILE" > "$DBDIR/reference.fasta" 2>> run.log; then
        finish error "The database file could not be decompressed. It ends in .gz but is not a gzip file." 65
      fi
    else
      cp "$DBFILE" "$DBDIR/reference.fasta"
    fi
    need makeblastdb
    if ! makeblastdb -in "$DBDIR/reference.fasta" -dbtype "$DBTYPE" -out "$DBDIR/reference" -title reference >> run.log 2>&1; then
      finish error "The reference database could not be prepared. BLAST expects $DBTYPE sequence in FASTA format; this file does not look like that. Details: $(logtail run.log)" 65
    fi
    DB="$DBDIR/reference"
    ;;
esac

# ---- the queries
failed=0
for q in "\${QUERIES[@]}"; do
  if [ ! -s "$q" ]; then
    printf '%s\\tempty\\t0\\n' "$q" >> status.tsv
    continue
  fi
  if "$PROGRAM" -query "$q" -db "$DB" -outfmt 6 -evalue "$EVALUE" \\
       -max_target_seqs "$MAXHITS" -num_threads "$THREADS" > one.tsv 2>> query.log; then
    awk -v f="$q" 'BEGIN { OFS = "\\t" } { print f, $0 }' one.tsv >> "$HITS"
    printf '%s\\tok\\t%d\\n' "$q" "$(wc -l < one.tsv | tr -d ' ')" >> status.tsv
  else
    failed=$((failed + 1))
    printf '%s\\tfailed\\t0\\n' "$q" >> status.tsv
  fi
  rm -f one.tsv
done

# The best TOPN rows by e-value, for the page to draw. The hits file
# keeps the full set for download.
tail -n +2 "$HITS" | sort -g -k12,12 2>/dev/null | head -n "$TOPN" > top.tsv
# sort -g is not universal (busybox has no -g). Unsorted beats empty.
if [ ! -s top.tsv ] && [ "$(wc -l < "$HITS" | tr -d ' ')" -gt 1 ]; then
  tail -n +2 "$HITS" | head -n "$TOPN" > top.tsv
fi

if [ "$failed" -gt 0 ]; then
  finish partial "$failed of \${#QUERIES[@]} sequence files could not be searched; the rest are below. The usual cause is a file that is not FASTA, or that is protein where DNA was expected. Details: $(logtail query.log)" 1
fi

finish ok "" 0
`;
}

// ----------------------------------------------------------- submit file

/**
 * Memory a job asks for. BLAST's appetite tracks the database.
 *
 * 2 GB is a FLOOR, and it has to be reachable. An earlier version
 * computed `max(2048, 2048 + dbMB)`, where the max() can never choose
 * its first argument -- so a 12 KB database asked for 2049 MB, one
 * megabyte over the commonest slot size there is, and the job sat
 * idle forever against a pool with 2 GB slots. Nothing failed: it was
 * never matched, and `condor_q -better-analyze` was the only place
 * that said so. A dead max() is the tell; if the floor cannot be the
 * answer it is not a floor.
 */
export function requestMemoryMB(databaseBytes: number): number {
  const dbMB = databaseBytes / (1024 * 1024);
  // A gigabyte of headroom plus the database, which for anything
  // smaller than 1 GB lands on the floor.
  return Math.min(16384, Math.max(2048, Math.ceil(1024 + dbMB)));
}

/** Disk: the archive, the unpacked copy, the index and the output. */
export function requestDiskKB(databaseBytes: number, queryBytes: number): number {
  const kb = ((databaseBytes + queryBytes) * 4) / 1024;
  return Math.min(100 * 1024 * 1024, Math.max(2 * 1024 * 1024, Math.ceil(kb)));
}

export function buildSubmitFile(spec: JobSpec): string {
  const queries = spec.queryNames.filter(isSafeFileName);
  const inputs = [RUNNER_FILE, spec.databaseFile, ...queries].map(quote);
  const outputs = outputFiles(spec.node);

  // Note the `: >` before anything else: a declared output file that is
  // missing at the end holds the job for a file-transfer error, which
  // says nothing about what actually went wrong. Doing it here, in
  // `arguments`, rather than inside the runner script means even a
  // broken runner script fails as itself.
  const prepare = outputs.map((f) => `: > ${f}`).join('; ');

  return [
    `executable = /usr/bin/env`,
    `transfer_executable = false`,
    `arguments = "bash -c '${prepare}; exec bash ${RUNNER_FILE}'"`,
    ``,
    // Which node this is and what it searches. ONE runner is spooled
    // for the whole workflow, so everything that differs between nodes
    // has to arrive from outside it -- and the environment carries it
    // without a layer of shell quoting, because every name here has
    // already passed isSafeFileName.
    `environment = ${adString(`BLAST_NODE=${spec.node} BLAST_QUERIES=${queries.join(',')}`)}`,
    ``,
    `request_cpus = ${JOB_CPUS}`,
    `request_memory = ${requestMemoryMB(spec.databaseBytes)}`,
    `request_disk = ${requestDiskKB(spec.databaseBytes, spec.queryBytes)}`,
    ``,
    `should_transfer_files = YES`,
    `when_to_transfer_output = ON_EXIT`,
    `transfer_input_files = ${inputs.join(',')}`,
    ``,
    // Every name below carries the node's own name, because every node
    // of this DAG runs in the SAME directory -- see outputFiles(), and
    // do not be tempted back to transfer_output_remaps.
    `output = stdout-${spec.node}.txt`,
    `error = stderr-${spec.node}.txt`,
    // Declared, so they come back -- and created at the start of the
    // job, so declaring them cannot turn a failure into a hold.
    `transfer_output_files = ${outputs.join(',')}`,
    ``,
    // No batch_name here. In a DAG the name belongs on the MANAGER
    // job, which is what the app lists -- one row per search rather
    // than one per query file -- and node jobs are found from it by
    // DAGManJobId. Setting it per node would name the parts, not the
    // whole.
    //
    // It would also have been written `JobBatchName = ...`, which is
    // the trap this repository's AGENTS.md warns about: a submit file
    // is not a ClassAd, so that line defines a submit MACRO and sets
    // no attribute at all. The command is `batch_name`.
    `queue 1`,
    ``,
  ].join('\n');
}

/** A batch name that groups one search's jobs. Safe by construction. */
export function batchNameFor(program: ProgramId, when = new Date()): string {
  const stamp = when.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `blast-${program}-${stamp}`;
}

/** True for any batch name this app produces, for the queue constraint. */
export const BATCH_PREFIX = 'blast-';

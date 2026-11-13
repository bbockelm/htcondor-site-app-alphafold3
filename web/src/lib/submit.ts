// The shared half of building a submit file: escaping, naming and
// sizing. The submit files themselves live with the pipelines that
// produce them, in pipelines/.
//
// They are plain string builders on purpose: a submit file is text,
// the format is documented, and a template engine between you and it
// would only hide the thing you need to read when a job does not run.
//
// What is here is the part that is the same whatever you are running,
// and the part where a mistake is a security bug rather than a job
// that does not start.
//
// What NOT to put here:
//   - A log location, an accounting group, or anything else the access
//     point requires. The server applies site policy to every job.
//   - Anything derived from user input without escaping. See below.
//
// TWO THINGS ABOUT OUTPUT, both learned the hard way:
//
//  1. Have the job write a STRUCTURED result -- JSON -- alongside
//     whatever it prints for a human. A page that can read
//     {"rows": [...]} can draw a table, sort it, and show the top ten;
//     a page handed a block of text can only put it in a <pre>. The
//     job is the only place that knows the shape of its own output, so
//     emitting JSON there costs one line and saves the interface from
//     parsing prose.
//
//  2. HTCondor HOLDS a job whose declared output file does not exist
//     when it finishes. So a job that writes results.json only on
//     success is held on every failure -- and held for "missing
//     output", which says nothing about what actually went wrong. The
//     user sees a job stuck in a state nobody can explain.
//
//     Fix: create the file at the START, before anything can fail.
//     `: > results.json` costs nothing and means the failure path
//     returns an empty-but-present file, so the job fails with its
//     real error instead of a misleading hold.

/**
 * Quote a value for a submit-file command.
 *
 * Two separate hazards, both easy to miss:
 *
 *   `$(...)` and `$$(...)` are macro substitutions evaluated by the
 *   submit processor, and `$ENV(HOME)` reads the environment of the
 *   process doing the submitting -- which is the SERVER, not the user.
 *   A file name a user typed must not be able to reach either. `$` is
 *   escaped as `$(DOLLAR)`, which is the documented literal.
 *
 *   Newlines end a command. One in a value turns the rest of the line
 *   into a new submit command of the user's choosing.
 */
export function quote(value: string): string {
  return value
    .replace(/\$/g, '$(DOLLAR)')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/**
 * Quote a value as a ClassAd string literal, braces and all.
 *
 * Separate from `quote` and applied first: this is about the ClassAd
 * grammar, that one is about macro expansion, and they escape
 * different characters.
 */
export function adString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ');
  return `"${escaped}"`;
}

/**
 * Quote a value to be interpolated into JSON the job will read.
 *
 * JSON.stringify brings its own quotes. Interpolate the result WITHOUT
 * adding more.
 */
export function jsonString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Reject a file name that cannot safely be a transfer entry.
 *
 * An allow-list, not a block-list. The name goes into a
 * comma-separated `transfer_input_files`, into a multipart
 * Content-Disposition filename, and in most apps onto a shell command
 * line. A rule written as "no slashes, no newlines" let through
 * `my file.fa`, `$(x).fa`, `-rf.fa` and `a"b.fa` -- every one of which
 * is a problem somewhere along that path.
 *
 * Tell the user which file to rename. That is a better experience than
 * a job held for a reason nobody can read.
 */
export function isSafeFileName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

/**
 * Disk to ask for, given the bytes going in. `request_disk` is KiB.
 *
 * Three times the input with a floor, because the sandbox holds the
 * input, the outputs, and whatever the job writes while working. A job
 * that runs out of disk is evicted, which looks like a job that
 * mysteriously restarts.
 */
export function requestDiskKB(inputBytes: number): number {
  const kb = Math.ceil(Math.max(0, inputBytes) / 1024);
  return Math.max(512 * 1024, kb * 3);
}

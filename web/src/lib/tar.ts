// Reading a job's output sandbox in the browser.
//
// WHY A PAGE PARSES TAR AT ALL
//
// A plain job's results are a handful of files you already know the
// names of, and `GET /jobs/{id}/files/{name}` fetches them. A DAG is
// different: the names depend on how the work was split, which was
// decided at SUBMIT time, and after a reload the page has a job id and
// nothing else.
//
// Two obvious answers both fail, and it is worth saying why so nobody
// re-derives them:
//
//   Ask the queue for the node jobs. They have left it -- that is what
//   "finished" means -- and the history is a different endpoint that
//   still would not say what each node's files were called.
//
//   Spool a manifest with the workflow. The page cannot read it back:
//   `/jobs/{id}/output` returns what the job PRODUCED, and a file that
//   was uploaded as an input is not in it. The request answers 404 and
//   the results page reports a perfectly good search as unreadable.
//
// So the page asks for the output sandbox, which is exactly the set of
// files the workflow produced, and finds its results among them by
// name. One request, no guessing, and a node that never ran is simply
// absent rather than silently mistaken for the end of the list.
//
// Only the OUTPUTS come back, so this stays small however large the
// inputs were -- which matters here, because the input is the thing
// this pipeline exists to avoid copying.
//
// THE FORMAT
//
// Uncompressed tar: a 512-byte header per entry, then the contents
// padded up to 512. The name is the first 100 bytes and the size is 12
// bytes of octal at offset 124. That is all this needs; it is not a
// general tar reader and should not become one.

export interface TarEntry {
  name: string;
  bytes: Uint8Array;
}

const BLOCK = 512;
const NAME_LEN = 100;
const SIZE_OFF = 124;
const SIZE_LEN = 12;

/** Read a NUL-terminated field. */
function field(buf: Uint8Array, at: number, len: number): string {
  const raw = buf.subarray(at, at + len);
  const end = raw.indexOf(0);
  return new TextDecoder().decode(end === -1 ? raw : raw.subarray(0, end));
}

/**
 * The entries of an uncompressed tar.
 *
 * Stops at the first unreadable header rather than throwing: a
 * truncated archive should show the results that did arrive, not an
 * error page.
 */
export function readTar(buf: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  for (let off = 0; off + BLOCK <= buf.length; ) {
    const name = field(buf, off, NAME_LEN);
    // Two zero blocks end the archive; one empty name is enough to stop.
    if (!name) break;
    const size = parseInt(field(buf, off + SIZE_OFF, SIZE_LEN).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) break;
    const start = off + BLOCK;
    if (start + size > buf.length) break;
    out.push({ name, bytes: buf.subarray(start, start + size) });
    off = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}

export function entryText(entry: TarEntry): string {
  return new TextDecoder().decode(entry.bytes);
}

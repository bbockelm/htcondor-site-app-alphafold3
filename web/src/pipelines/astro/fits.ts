// What this app does, in one place: the choices an astronomer makes and
// the arithmetic that turns them into a submission.
//
// THE OPERATION
//
// Two things happen to a FITS file here, and both are the first things
// anyone does with a new pile of frames:
//
//   1. Look at it.   A FITS image is a 2-D array of floats with a
//      dynamic range of 10^5 or more. There is nothing to "view": you
//      choose a clip and a stretch, and only then is there a picture.
//      That choice is science, not decoration, which is why it is the
//      control this app exposes.
//
//   2. Check it.     Shape, bit depth, how many pixels are NaN, the
//      sky level, the noise, and the handful of header cards that say
//      what the frame actually is (OBJECT, FILTER, EXPTIME, DATE-OBS).
//      This is the triage step that tells you a download is corrupt,
//      or that the "F814W" frame is actually F606W.
//
// Both are per-image, so this app's natural shape is ONE JOB PER FILE.
//
// The third mode is the one that is NOT per-image: a colour composite
// maps one filter to each of red, green and blue, so it needs two or
// three frames TOGETHER. That is one job with several inputs, not a
// fan-out, and the difference matters for submission -- see plan().
//
// WHY NOT SOMETHING MORE AMBITIOUS
//
// Source detection, photometry, reprojection and mosaicking are all
// reasonable things to want. They need a calibrated WCS, a PSF model
// and judgement about what counts as a detection, and an app that
// guesses at those on the user's behalf produces a number the user
// cannot defend. Statistics and a picture are honest: nothing here is
// a measurement anyone will put in a paper, and nothing here is wrong.

// ---------------------------------------------------------------- size
//
// FITS files are big: a single WFC3 frame is 30-200 MB, and the ones on
// the ESA/Hubble FITS Liberator page run to several hundred. Everything
// below is about that one fact.
//
// The good news, and it is worth stating because the template's BLAST
// example is about the opposite case: NOTHING HERE IS SHARED. Each
// image is read by exactly one job, so the upload is the sum of the
// files, not jobs x anything. The only thing every job gets a copy of
// is the ~10 KB Python runner. There is no `jobs x databaseSize`
// multiplier to design around; there is just a lot of bytes, once.
//
// The bad news: the upload is still the whole wall clock. Processing
// one frame takes seconds. Pushing 1.4 GB up a campus uplink takes
// minutes, and the user is watching a browser tab the whole time. So
// the number the app must show before the button is pressed is the
// total upload, and the sentence it must say is "this is the slow
// part".

/** A single file bigger than this is refused, with an explanation. */
import { isSafeFileName } from '../../lib/submit';

export const MAX_FILE_BYTES = 1024 * 1024 * 1024;

/** Total bytes one submission may push. Beyond this, do it in batches. */
export const UPLOAD_BUDGET_BYTES = 8 * 1024 * 1024 * 1024;

/** Images per submission. 500 frames should not become 500 clusters. */
export const MAX_IMAGES = 50;

/** Channels in a colour composite. */
export const CHANNELS = ['red', 'green', 'blue'] as const;
export type Channel = (typeof CHANNELS)[number];

// ------------------------------------------------------------- choices

export type Mode = 'each' | 'composite';

/**
 * The stretch: how pixel values are mapped to screen brightness.
 *
 * asinh is the default because astronomical images are mostly empty sky
 * with a few very bright sources, and asinh is linear near the sky and
 * logarithmic in the bright tail -- it shows faint structure without
 * burning out a galaxy core. Linear is kept because it is the only one
 * in which equal screen brightness means equal flux, which is what you
 * want when you are checking a frame rather than showing it.
 */
export const STRETCHES = [
  { id: 'asinh', label: 'asinh — faint structure and bright cores together (usual choice)' },
  { id: 'log', label: 'log — strongest on faint structure' },
  { id: 'sqrt', label: 'square root — gentler than log' },
  { id: 'linear', label: 'linear — equal brightness means equal flux' },
] as const;

export type StretchId = (typeof STRETCHES)[number]['id'];

export function isStretch(v: string): v is StretchId {
  return STRETCHES.some((s) => s.id === v);
}

/**
 * The clip: which percentiles of the pixel distribution become black
 * and white.
 *
 * Offered as a handful of named cuts rather than two free-text numbers.
 * A pair of boxes invites 99.95 and 0.05 typed the wrong way round,
 * which produces an inverted image and no error at all.
 */
export const CLIPS = [
  { id: '99.5', low: 0.25, high: 99.75, label: '99.5% — usual choice' },
  { id: '95', low: 2.5, high: 97.5, label: '95% — flatter, shows the sky' },
  { id: '99', low: 0.5, high: 99.5, label: '99%' },
  { id: '99.9', low: 0.05, high: 99.95, label: '99.9% — keeps the brightest pixels' },
  { id: '100', low: 0, high: 100, label: 'None — full range, min to max' },
] as const;

export type ClipId = (typeof CLIPS)[number]['id'];

export function clipById(id: string): (typeof CLIPS)[number] {
  return CLIPS.find((c) => c.id === id) ?? CLIPS[0];
}

/**
 * Longest side of the preview, in pixels.
 *
 * The job decimates the array by an integer stride before rendering
 * rather than resampling it, so a preview is always made of real
 * pixels; nothing is interpolated into existence. 1024 is the default
 * because it is the largest that still loads instantly in a list.
 */
export const SIZES = [
  { value: 512, label: '512 px — quick look' },
  { value: 1024, label: '1024 px — usual choice' },
  { value: 2048, label: '2048 px — closer inspection' },
] as const;

export function isSize(n: number): boolean {
  return SIZES.some((s) => s.value === n);
}

export interface Options {
  mode: Mode;
  stretch: StretchId;
  clip: ClipId;
  size: number;
}

export const DEFAULT_OPTIONS: Options = {
  mode: 'each',
  stretch: 'asinh',
  clip: '99.5',
  size: 1024,
};

// ----------------------------------------------------------- the files

/**
 * Does this look like a FITS file by name?
 *
 * By NAME only, and used to warn rather than to refuse: the magic
 * number is the real test and the job does it properly. A `.fit` from
 * a 1990s instrument, or a `.fits.gz`, is still FITS, and refusing a
 * valid file because its extension is unfamiliar is worse than letting
 * the job say "this is not FITS" in a sentence.
 */
export function looksLikeFits(name: string): boolean {
  return /\.(fits|fit|fts)(\.(gz|fz|bz2))?$/i.test(name.trim());
}

/**
 * Reject a name that cannot safely be a transfer entry.
 *
 * An allow-list, copied from the template and kept strict on purpose.
 * The name travels through a comma-separated `transfer_input_files`, a
 * multipart Content-Disposition header, and a Python argument list. The
 * characters that survive all three unchanged are few, and an
 * astronomer can rename a file -- the app says which one and why, which
 * is a far better experience than a job held for a reason nobody can
 * read.
 */
// Re-exported, not reimplemented. This pipeline had its own copy with
// explicit checks for ".", ".." and a leading "-", all of which the
// shared allow-list already excludes: its first character must be
// alphanumeric. Two copies of a security check are two things to keep
// in step, and the tests below now cover the one that is used.
export { isSafeFileName };

/** Human-readable byte count. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// -------------------------------------------------------------- the plan

export interface PlanFile {
  name: string;
  bytes: number;
}

export interface Plan {
  /** Clusters this submission becomes. */
  jobs: number;
  /** Frames in it. Equal to `jobs` only in 'each' mode. */
  images: number;
  /** Bytes the browser pushes to the access point. */
  uploadBytes: number;
  /** Fatal: the submit button stays disabled and this is shown. */
  blocker: string | null;
  /** Non-fatal, worth saying anyway. */
  warnings: string[];
}

/**
 * What this submission costs, and whether it is allowed at all.
 *
 * Two submission shapes, and the difference is the point:
 *
 *   'each'       N files -> N clusters, each with one image. The jobs
 *                are independent, they run in parallel, and the upload
 *                is the sum of the files. This is the shape the API
 *                supports well, because each job's input goes into its
 *                own sandbox and nothing is duplicated.
 *
 *   'composite'  2-3 files -> ONE cluster, because the job cannot make
 *                a colour picture out of one plane at a time. `queue N`
 *                would be wrong here for the same reason it is wrong in
 *                the BLAST example: uploads are per cluster.proc, so N
 *                procs would each need their own copy of all three
 *                frames to no purpose.
 */
export function plan(opts: Options, files: readonly PlanFile[]): Plan {
  const warnings: string[] = [];
  const uploadBytes = files.reduce((n, f) => n + f.bytes, 0);
  const jobs = opts.mode === 'composite' ? (files.length ? 1 : 0) : files.length;

  let blocker: string | null = null;

  const unsafe = files.filter((f) => !isSafeFileName(f.name));
  const oversized = files.filter((f) => f.bytes > MAX_FILE_BYTES);
  const empty = files.filter((f) => f.bytes === 0);
  const notFits = files.filter((f) => !looksLikeFits(f.name));

  if (files.length === 0) {
    blocker = null; // Nothing chosen yet is not an error, just not ready.
  } else if (unsafe.length) {
    blocker =
      `Rename ${unsafe.length === 1 ? 'this file' : 'these files'} before submitting — ` +
      `only letters, digits, dot, dash and underscore survive the trip to a compute node: ` +
      unsafe
        .slice(0, 3)
        .map((f) => f.name)
        .join(', ') +
      (unsafe.length > 3 ? `, and ${unsafe.length - 3} more` : '');
  } else if (empty.length) {
    blocker = `${empty[0].name} is empty. Check that the download finished.`;
  } else if (oversized.length) {
    blocker =
      `${oversized[0].name} is ${formatBytes(oversized[0].bytes)}, over the ` +
      `${formatBytes(MAX_FILE_BYTES)} limit for a file uploaded through a browser. ` +
      `A frame this size should be staged on the access point's own storage — ask your ` +
      `system administrator.`;
  } else if (opts.mode === 'composite' && files.length < 2) {
    blocker = 'A colour composite needs at least two filters. Add another image.';
  } else if (opts.mode === 'composite' && files.length > CHANNELS.length) {
    blocker = `A colour composite uses at most ${CHANNELS.length} images, one per colour channel.`;
  } else if (opts.mode === 'each' && files.length > MAX_IMAGES) {
    blocker =
      `${files.length} images at once is more than this app will submit. ` +
      `Do it in batches of ${MAX_IMAGES} or fewer.`;
  } else if (uploadBytes > UPLOAD_BUDGET_BYTES) {
    blocker =
      `This would upload ${formatBytes(uploadBytes)}, over the ` +
      `${formatBytes(UPLOAD_BUDGET_BYTES)} limit for one submission. Submit fewer images at a time.`;
  }

  if (notFits.length && !blocker) {
    warnings.push(
      `${notFits.length === 1 ? `${notFits[0].name} does not` : `${notFits.length} files do not`} ` +
        `end in .fits — the job will say so if it is not a FITS file.`,
    );
  }
  if (uploadBytes > 512 * 1024 * 1024 && !blocker) {
    warnings.push(
      `${formatBytes(uploadBytes)} is a long upload. Leave this tab open until every image ` +
        `says it is queued — closing it part-way leaves jobs that never run.`,
    );
  }

  return { jobs, images: files.length, uploadBytes, blocker, warnings };
}

/** The sentence shown above the submit button. */
export function planSentence(opts: Options, p: Plan): string {
  if (p.jobs === 0) return 'Add FITS images to begin.';
  if (opts.mode === 'composite') {
    return (
      `One job, combining ${p.images} filters into a single colour picture — they have to be in ` +
      `the same job to be combined. ${formatBytes(p.uploadBytes)} is uploaded from this ` +
      `computer; that is the slow part, and the processing itself takes seconds.`
    );
  }
  return (
    `${p.jobs} ${p.jobs === 1 ? 'job' : 'jobs'}, one per image, running in parallel. ` +
    `${formatBytes(p.uploadBytes)} is uploaded from this computer — each image is sent once, ` +
    `to its own job. The upload is the slow part; the processing itself takes seconds.`
  );
}

// -------------------------------------------------- resource requests

/**
 * Memory for one job, in MB.
 *
 * astropy memory-maps the data, but statistics and the stretch promote
 * a plane to float32, and a 16-bit 4k x 4k frame doubles on the way in.
 * Four times the file covers that; the 2 GB floor covers the Python
 * interpreter and numpy themselves, which a small frame would otherwise
 * not pay for. The ceiling is there so a pathological input cannot ask
 * the pool for a machine that does not exist -- a job that asks for
 * more memory than any slot has does not fail, it waits forever, which
 * is the least debuggable outcome of the three.
 */
export function requestMemoryMB(totalInputBytes: number): number {
  const mb = totalInputBytes / (1024 * 1024);
  return Math.min(32768, Math.max(2048, Math.ceil(4 * mb)));
}

/**
 * Disk for one job, in KiB -- the unit request_disk uses.
 *
 * The inputs, room for a decompressed copy if they arrived gzipped, and
 * the preview, which is at most a few megabytes.
 */
export function requestDiskKB(totalInputBytes: number): number {
  const kb = Math.ceil((totalInputBytes * 4) / 1024);
  return Math.min(200 * 1024 * 1024, Math.max(2 * 1024 * 1024, kb));
}

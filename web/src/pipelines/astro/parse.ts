// Reading what the job wrote.
//
// results.json is this app's contract with itself -- runner.ts writes
// it with json.dump, so the shape is not in doubt. What IS in doubt is
// whether the file arrived whole: the job declares it and creates it
// EMPTY before doing any work, so a zero-byte results.json is the
// normal shape of a job that failed, not a bug. A killed job leaves a
// truncated one. Both have to produce a sentence rather than a stack
// trace.

/** One frame's statistics, as the job reports them. */
export interface ImageReport {
  file: string;
  label: string;
  hdu: number;
  hdu_name: string;
  header: Record<string, string | number | boolean>;
  channel?: string;
  width: number;
  height: number;
  pixels: number;
  finite_pixels: number;
  blank_pixels: number;
  min?: number;
  max?: number;
  mean?: number;
  std?: number;
  median?: number;
  sigma_mad?: number;
  sample_pixels?: number;
  clip_low_value?: number;
  clip_high_value?: number;
}

export interface PreviewReport {
  file: string;
  width: number;
  height: number;
  channels: number;
  decimation: number;
}

export interface Results {
  status: 'ok' | 'partial' | 'error';
  message: string;
  mode: string;
  stretch: string;
  clipLow: number;
  clipHigh: number;
  images: ImageReport[];
  /** null when the job did not get as far as drawing anything. */
  preview: PreviewReport | null;
  notes: string[];
}

/**
 * Parse results.json, or throw an Error whose message is already fit to
 * show a user.
 */
export function parseResults(text: string): Results {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(
      'this job brought back an empty results file, which means it stopped before it could ' +
        'report anything. Its error output will say why.',
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    throw new Error(
      'the results file was incomplete, which usually means the job was cut short part-way.',
    );
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('the results file was not in the expected form.');
  }

  const o = raw as Record<string, unknown>;
  const status = o.status === 'ok' || o.status === 'partial' ? o.status : 'error';

  return {
    status,
    message: str(o.message),
    mode: str(o.mode),
    stretch: str(o.stretch),
    clipLow: num(o.clip_low),
    clipHigh: num(o.clip_high),
    images: Array.isArray(o.images) ? o.images.map(image).filter((i): i is ImageReport => !!i) : [],
    preview: preview(o.preview),
    notes: Array.isArray(o.notes) ? o.notes.filter((n): n is string => typeof n === 'string') : [],
  };
}

function preview(value: unknown): PreviewReport | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  // A preview with no size is not a preview. Rendering an <img> for it
  // would show a broken-image icon, which reads as "the app is
  // broken" rather than "this job did not get that far".
  if (!num(p.width) || !num(p.height)) return null;
  return {
    file: str(p.file) || 'preview.png',
    width: num(p.width),
    height: num(p.height),
    channels: num(p.channels) || 1,
    decimation: num(p.decimation) || 1,
  };
}

function image(value: unknown): ImageReport | null {
  if (!value || typeof value !== 'object') return null;
  const i = value as Record<string, unknown>;
  const header: Record<string, string | number | boolean> = {};
  if (i.header && typeof i.header === 'object') {
    for (const [k, v] of Object.entries(i.header as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') header[k] = v;
    }
  }
  return {
    file: str(i.file),
    label: str(i.label) || str(i.file) || 'image',
    hdu: num(i.hdu),
    hdu_name: str(i.hdu_name),
    header,
    channel: typeof i.channel === 'string' ? i.channel : undefined,
    width: num(i.width),
    height: num(i.height),
    pixels: num(i.pixels),
    finite_pixels: num(i.finite_pixels),
    blank_pixels: num(i.blank_pixels),
    min: opt(i.min),
    max: opt(i.max),
    mean: opt(i.mean),
    std: opt(i.std),
    median: opt(i.median),
    sigma_mad: opt(i.sigma_mad),
    sample_pixels: opt(i.sample_pixels),
    clip_low_value: opt(i.clip_low_value),
    clip_high_value: opt(i.clip_high_value),
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function opt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * A number from a FITS frame, at a width an astronomer can read.
 *
 * Counts in a raw frame run to 10^5 and a calibrated one to 10^-19, so
 * neither plain decimal nor plain exponential is right for both. Pick
 * per value.
 */
export function formatValue(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e5 || a < 1e-3) return v.toExponential(3);
  return v.toPrecision(5).replace(/\.?0+$/, '');
}

/** The header cards worth putting at the top, in the order they help. */
export const HEADER_ORDER = [
  'OBJECT',
  'TELESCOP',
  'INSTRUME',
  'DETECTOR',
  'FILTER',
  'FILTER1',
  'FILTER2',
  'EXPTIME',
  'DATE-OBS',
  'BUNIT',
] as const;

export function headerRows(
  header: Record<string, string | number | boolean>,
): { key: string; value: string }[] {
  const rows: { key: string; value: string }[] = [];
  for (const key of HEADER_ORDER) {
    const v = header[key];
    if (v === undefined) continue;
    rows.push({ key, value: typeof v === 'number' ? formatValue(v) : String(v) });
  }
  return rows;
}

// What one finished job produced.
//
// THE PICTURE, AND WHY IT IS AN <img src> AND NOT A fetch
//
// The other results an app like this returns -- numbers, JSON, a table
// -- are fetched, parsed and rendered. A picture is different, and the
// obvious way to do it is wrong here:
//
//   fetch the PNG, make a Blob, URL.createObjectURL, point an <img> at
//   the blob: URL
//
// The access point sends `Content-Security-Policy: default-src 'self'`.
// A blob: URL is not 'self', so the browser refuses to load it and the
// image simply does not appear -- no error in the page, nothing in the
// network tab that looks wrong, just a blank box. It works in `make
// dev`, where there is no CSP, and breaks when deployed.
//
// So the PNG is loaded the way a picture on a web page has always been
// loaded: an <img> whose src is the API URL. Same origin, so the CSP
// allows it and the session cookie rides along automatically. The
// browser streams and caches it, the page never holds the bytes, and a
// large preview costs the page nothing.
//
// THE EMPTY PNG
//
// Every declared output file is created empty at the start of the job,
// because HTCondor holds a job whose declared output is missing. That
// rule is right, and it has a consequence for a result that is a
// picture: a job that failed brings back a zero-byte preview.png, and
// an <img> pointed at zero bytes renders a broken-image icon. The user
// reads that as "this app is broken", not as "this job failed".
//
// So whether there is a picture is decided by results.json -- which
// says preview: null when the job never got that far -- and never by
// whether the file exists.

import { useEffect, useState } from 'react';
import { api, ApiError, type Job } from '../../lib/api';
import { PREVIEW_FILE, RESULTS_FILE } from './runner';
import {
  formatValue,
  headerRows,
  parseResults,
  type ImageReport,
  type Results as ResultsData,
} from './parse';

interface Props {
  job: Job;
}

const CHANNEL_LABEL: Record<string, string> = {
  red: 'Red',
  green: 'Green',
  blue: 'Blue',
};

export function Results({ job }: Props) {
  const id = `${job.ClusterId}.${job.ProcId}`;
  const [data, setData] = useState<ResultsData | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setProblem(null);
    api
      .jobFile(id, RESULTS_FILE)
      .then((text: string) => {
        if (!live) return;
        setData(parseResults(text));
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 401) return;
        setProblem(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [id]);

  if (problem) {
    return (
      <div className="results">
        <p className="meta">
          The results for this job could not be read: {problem} You can still{' '}
          <a href={api.outputUrl(id)}>download everything it produced</a>.
        </p>
      </div>
    );
  }

  if (!data) return <p className="meta">Reading the results…</p>;

  return (
    <div className="results" data-testid="results">
      {data.status !== 'ok' && data.message && (
        <p className={data.status === 'error' ? 'status-err' : 'status-warn'}>{data.message}</p>
      )}

      {data.preview ? (
        <figure className="preview">
          {/* Plain <img src>, not a blob: URL -- see the header. */}
          <img
            src={api.fileUrl(id, data.preview.file || PREVIEW_FILE)}
            alt={`Preview of ${data.images.map((i) => i.label).join(', ')}`}
            width={data.preview.width}
            height={data.preview.height}
            loading="lazy"
          />
          <figcaption className="meta">
            {data.preview.width} × {data.preview.height} px
            {data.preview.decimation > 1 && `, every ${ordinal(data.preview.decimation)} pixel`}
            {data.preview.channels === 3 && ', colour composite'} ·{' '}
            {describeStretch(data.stretch)} ·{' '}
            <a href={api.fileUrl(id, data.preview.file || PREVIEW_FILE)} download>
              Download the PNG
            </a>
          </figcaption>
        </figure>
      ) : (
        <p className="meta">No picture was produced for this job.</p>
      )}

      {data.notes.map((n) => (
        <p className="meta" key={n}>
          {n}
        </p>
      ))}

      {data.images.map((image) => (
        <ImagePanel key={image.file + image.label} image={image} />
      ))}

      <p className="meta">
        <a href={api.outputUrl(id)}>Download everything this job produced</a> (a tar of the whole
        sandbox, including the statistics as JSON)
      </p>
    </div>
  );
}

function ImagePanel({ image }: { image: ImageReport }) {
  const header = headerRows(image.header);
  const blankShare = image.pixels ? (100 * image.blank_pixels) / image.pixels : 0;

  return (
    <section className="image-panel">
      <h4>
        {image.channel && <span className={`chip chip-${image.channel}`}>{CHANNEL_LABEL[image.channel] ?? image.channel}</span>}
        {image.label}
        <span className="meta">
          {' '}
          — {image.width} × {image.height}, extension {image.hdu}
          {image.hdu_name ? ` (${image.hdu_name})` : ''}
        </span>
      </h4>

      {header.length > 0 && (
        <dl className="cards">
          {header.map((r) => (
            <div key={r.key}>
              <dt>{r.key}</dt>
              <dd>{r.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <table className="stats">
        <tbody>
          <Row label="Lowest pixel" value={formatValue(image.min)} />
          <Row label="Highest pixel" value={formatValue(image.max)} />
          <Row label="Mean" value={formatValue(image.mean)} />
          <Row label="Median" value={formatValue(image.median)} />
          <Row
            label="Noise (1.4826 × MAD)"
            value={formatValue(image.sigma_mad)}
            hint="A sky-noise estimate that a bright galaxy does not distort, unlike the standard deviation."
          />
          <Row label="Standard deviation" value={formatValue(image.std)} />
          <Row
            label="Black / white levels"
            value={`${formatValue(image.clip_low_value)} … ${formatValue(image.clip_high_value)}`}
            hint="The two values that became black and white in the picture above."
          />
          <Row
            label="Blank pixels"
            value={
              image.blank_pixels
                ? `${image.blank_pixels.toLocaleString()} (${blankShare.toFixed(blankShare < 1 ? 2 : 1)}%)`
                : 'none'
            }
            hint="NaN or infinite: masked detector defects, chip gaps, or the edge of a drizzled frame."
          />
        </tbody>
      </table>

      {image.sample_pixels !== undefined && image.sample_pixels < image.pixels && (
        <p className="meta">
          Median, noise and the black/white levels come from the {image.sample_pixels.toLocaleString()}{' '}
          pixels of the preview grid rather than from all{' '}
          {image.pixels.toLocaleString()}. The rest are over every pixel.
        </p>
      )}
    </section>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <tr>
      <th scope="row">
        {label}
        {hint && <span className="meta hint">{hint}</span>}
      </th>
      <td>{value}</td>
    </tr>
  );
}

function ordinal(n: number): string {
  if (n % 10 === 2 && n % 100 !== 12) return `${n}nd`;
  if (n % 10 === 3 && n % 100 !== 13) return `${n}rd`;
  return `${n}th`;
}

function describeStretch(id: string): string {
  switch (id) {
    case 'linear':
      return 'linear stretch';
    case 'sqrt':
      return 'square-root stretch';
    case 'log':
      return 'log stretch';
    default:
      return 'asinh stretch';
  }
}

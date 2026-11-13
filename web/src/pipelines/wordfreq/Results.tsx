import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { RESULTS_NAME } from './wordfreq';
import { parseResults, sortWords, type Results as ResultsData, type SortKey } from './parse';

/**
 * What a finished job counted, as a table.
 *
 * The table is drawn from results.json, which the job writes; the
 * plain-text summary is kept behind a toggle because it is what people
 * paste into an email. Reading the JSON is what makes the table
 * sortable at all -- parsing the formatted text would mean the
 * interface re-deriving numbers the job already knew.
 *
 * Both are fetched together so that switching between them is
 * instant, and so that a job whose JSON is empty (it failed before
 * writing any) can fall straight back to the summary, which is where
 * the real error is.
 */
export function Results({ jobId }: { jobId: string }) {
  const [data, setData] = useState<ResultsData | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showText, setShowText] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; ascending: boolean }>({
    key: 'count',
    ascending: false,
  });

  useEffect(() => {
    let live = true;
    setData(null);
    setSummary(null);
    setProblem(null);
    setError(null);

    void (async () => {
      // The summary first: it is the thing worth showing when the
      // counts are missing, so it must not be lost to the same failure.
      try {
        const text = await api.stdout(jobId);
        if (live) setSummary(text);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
      try {
        const json = await api.jobFile(jobId, RESULTS_NAME);
        if (live) setData(parseResults(json));
      } catch (e) {
        if (live) setProblem(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      live = false;
    };
  }, [jobId]);

  if (error && !summary && !data) {
    return (
      <p className="notice error" role="alert" data-testid="results-error">
        The results for this file could not be read: {error}. They are still available from the
        download link above.
      </p>
    );
  }

  if (!data && !summary) return <p className="meta">Fetching the results…</p>;

  const rows = data ? sortWords(data.words, sort.key, sort.ascending) : [];
  const toggle = (key: SortKey) =>
    setSort((s) => ({ key, ascending: s.key === key ? !s.ascending : key === 'word' }));
  const arrow = (key: SortKey) => (sort.key !== key ? '' : sort.ascending ? ' ▲' : ' ▼');

  return (
    <div className="results">
      {data && (
        <p className="meta" data-testid="results-summary">
          {fmt(data.totalWords)} words in the file, {fmt(data.countedWords)} counted,{' '}
          {fmt(data.uniqueWords)} different.
        </p>
      )}

      {problem && !data && (
        <p className="notice error" role="alert" data-testid="results-problem">
          No table for this file: {problem}
        </p>
      )}

      {data && !showText && (
        <table className="counts" data-testid="results-table">
          <thead>
            <tr>
              <th scope="col" className="rank">
                #
              </th>
              <th scope="col">
                <button type="button" className="sort" onClick={() => toggle('word')}>
                  Word{arrow('word')}
                </button>
              </th>
              <th scope="col" className="num">
                <button type="button" className="sort" onClick={() => toggle('count')}>
                  Times used{arrow('count')}
                </button>
              </th>
              <th scope="col" className="num">
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((w, i) => (
              <tr key={w.word}>
                <td className="rank">{i + 1}</td>
                <td className="word">{w.word}</td>
                <td className="num">{fmt(w.count)}</td>
                <td className="num">
                  {/* A bar as well as a number: the shape of the
                      distribution is the thing people actually look
                      at, and it costs one element. */}
                  <span className="bar" style={{ width: `${barWidth(w, rows)}%` }} aria-hidden />
                  {w.share.toFixed(2)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showText &&
        (summary ? (
          <pre className="report" data-testid="results">
            {summary}
          </pre>
        ) : (
          <p className="notice error" role="alert">
            The summary could not be read: {error}
          </p>
        ))}

      {summary && data && (
        <button type="button" className="secondary" onClick={() => setShowText(!showText)}>
          {showText ? 'Show the table' : 'Show the plain summary'}
        </button>
      )}

      {/* A job that wrote no table still has a summary, and the
          summary is where its error message is. Show it outright
          rather than hiding it behind a toggle nobody will find. */}
      {summary && !data && (
        <pre className="report" data-testid="results">
          {summary}
        </pre>
      )}
    </div>
  );
}

function fmt(n: number): string {
  return n.toLocaleString();
}

/**
 * The bar, as a percentage of its cell.
 *
 * Capped well short of the cell because the number sits in the same
 * cell: at 100% the most common word's share wraps onto its own line
 * and the top row -- the one everybody reads first -- is the one that
 * looks broken. Every bar is scaled by the same factor, so the shape
 * of the distribution is unchanged.
 */
const BAR_MAX_PERCENT = 55;

function barWidth(w: { count: number }, rows: { count: number }[]): number {
  const max = rows.length ? Math.max(...rows.map((r) => r.count)) : 0;
  return max > 0 ? Math.round((w.count / max) * BAR_MAX_PERCENT) : 0;
}

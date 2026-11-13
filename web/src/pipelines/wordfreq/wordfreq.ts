// The word counter that actually runs on the execute node.
//
// It is an awk program, generated here and shipped to the job as an
// ordinary input file. Three reasons it looks like this:
//
//   1. awk is on every Linux execute node. A Python version would be a
//      bet on python3 and a specific minor version; a compiled binary
//      would be a bet on glibc.
//   2. Generating it here means NO user-supplied text ever reaches the
//      submit file. The file a user dropped is uploaded under a fixed
//      name and the label they see is a string constant inside this
//      program, so the submit file is the same bytes for every run
//      except for four integers. That removes the whole class of
//      submit-macro injection the quoting helpers in submit.ts exist
//      to defend against, rather than defending against it twice.
//   3. It is POSIX awk. No gensub, no asort, no IGNORECASE: those are
//      GNU extensions and the execute node may well have mawk or
//      busybox awk.

/** What the user chose. All of it is applied inside the awk program. */
export interface CountOptions {
  /** Words shorter than this are ignored. */
  minLength: number;
  /** How many rows the readable report shows. The CSV always has all. */
  topN: number;
  /** Treat "The" and "the" as one word. */
  foldCase: boolean;
  /** Skip "the", "and", "of" and the rest of the usual suspects. */
  skipCommonWords: boolean;
}

export const DEFAULT_OPTIONS: CountOptions = {
  minLength: 3,
  topN: 25,
  foldCase: true,
  skipCommonWords: true,
};

/** The name the input file is uploaded under, whatever the user called it. */
export const INPUT_NAME = 'input.txt';
/** The generated counter, uploaded alongside it. */
export const PROGRAM_NAME = 'wordfreq.awk';
/** The full table of every word, for a spreadsheet. */
export const CSV_NAME = 'word-counts.csv';
/** The same counts as JSON, which is what the page draws its table from. */
export const RESULTS_NAME = 'results.json';

/**
 * Everything the job declares in transfer_output_files.
 *
 * The submit file creates each of these empty before any real work --
 * HTCondor holds a job whose declared output is missing at the end,
 * and "held for missing output" is a dead end for a user who dropped
 * a file that turned out not to be text. Keep this list and the
 * creation step together: adding a file here without creating it
 * reintroduces exactly that hold.
 */
export const OUTPUT_FILES = [RESULTS_NAME, CSV_NAME] as const;

/**
 * Common English words, skipped when the user asks for it.
 *
 * Deliberately short. A long stopword list looks more scientific and is
 * mostly a way to silently delete words somebody cared about; these are
 * the ones whose counts are never the answer to anything.
 */
export const STOPWORDS = [
  'a', 'about', 'above', 'after', 'again', 'all', 'am', 'an', 'and', 'any',
  'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below',
  'between', 'both', 'but', 'by', 'can', 'did', 'do', 'does', 'doing', 'down',
  'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have',
  'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his',
  'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me',
  'more', 'most', 'my', 'myself', 'no', 'nor', 'not', 'now', 'of', 'off', 'on',
  'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over',
  'own', 'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the',
  'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they',
  'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very',
  'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who',
  'whom', 'why', 'will', 'with', 'would', 'you', 'your', 'yours', 'yourself',
  'yourselves',
];

/**
 * Quote a string for an awk source literal.
 *
 * awk has no raw strings: a backslash or a double quote in the value
 * would end the literal or start an escape. A newline would end the
 * statement. The label this is used for is a file name the user chose,
 * so all three are reachable from outside.
 */
export function awkString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ');
  return `"${escaped}"`;
}

/** Clamp the knobs to values that produce a report worth reading. */
export function normalizeOptions(opts: CountOptions): CountOptions {
  return {
    minLength: clamp(opts.minLength, 1, 20),
    topN: clamp(opts.topN, 1, 500),
    foldCase: !!opts.foldCase,
    skipCommonWords: !!opts.skipCommonWords,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

/**
 * Build the awk program for one file.
 *
 * `label` is what the user called the file; it appears in the report so
 * that a downloaded result is identifiable without its job id.
 */
export function buildProgram(label: string, raw: CountOptions): string {
  const o = normalizeOptions(raw);
  const stop = o.skipCommonWords
    ? STOPWORDS.map((w) => `  stop[${awkString(w)}] = 1;`).join('\n')
    : '  # the user asked to keep common words';
  // A flag, not `length(stop)`: length() of an ARRAY is a GNU/POSIX-2018
  // extension and this program may well meet busybox awk.
  const usestop = o.skipCommonWords ? 1 : 0;

  // The label is the one value here that came from a user. It is
  // embedded twice: once as an awk literal for the text report, and
  // once ALREADY JSON-ENCODED for results.json. Encoding it here, with
  // JSON.stringify, is why the awk program needs no JSON escaper of
  // its own -- which matters because writing one in POSIX awk is how
  // you end up emitting invalid JSON for a file called `a"b.txt`.
  //
  // The words themselves need no escaping: the tokenizer keeps only
  // [A-Za-z'], so a word can never contain a quote, a backslash or a
  // control character. That is a property of the gsub below, and the
  // test suite asserts it rather than trusting it.
  const labelJson = awkString(JSON.stringify(label));

  return `# Word frequency count, generated by the Word Frequency site app.
# POSIX awk only -- this may run under mawk or busybox awk.

BEGIN {
  label = ${awkString(label)};
  labeljson = ${labelJson};
  results = ${awkString(RESULTS_NAME)};
  minlen = ${o.minLength};
  topn = ${o.topN};
  fold = ${o.foldCase ? 1 : 0};
  usestop = ${usestop};
${stop}
}

{
  line = $0;
  if (fold) line = tolower(line);
  # A word is a run of letters, with apostrophes allowed inside it so
  # that "don't" survives. Everything else is a separator, which keeps
  # punctuation, digits and markup out of the counts.
  gsub(/[^A-Za-z']+/, " ", line);
  n = split(line, words, " ");
  for (i = 1; i <= n; i++) {
    w = words[i];
    # Strip leading and trailing apostrophes: 'quoted' is the word.
    sub(/^'+/, "", w);
    sub(/'+$/, "", w);
    if (w == "") continue;
    rawtotal++;
    if (length(w) < minlen) continue;
    if (w in stop) continue;
    count[w]++;
    total++;
  }
}

END {
  unique = 0;
  for (w in count) unique++;

  printf "Word frequencies for %s\\n", label;
  printf "\\n";
  printf "  %d words in the file\\n", rawtotal;
  printf "  %d words counted\\n", total;
  printf "  %d different words\\n", unique;
  printf "  words shorter than %d letters ignored\\n", minlen;
  if (fold) printf "  upper and lower case counted together\\n";
  else printf "  upper and lower case counted separately\\n";
  if (usestop) printf "  common words such as \\"the\\" and \\"and\\" ignored\\n";
  printf "\\n";

  # Both declared output files are created even when nothing is
  # counted. A missing one is a HOLD, not an error the user can read.
  csv = ${awkString(CSV_NAME)};
  printf "word,count\\n" > csv;
  close(csv);

  if (total == 0) {
    printf "No words were counted. The file may be empty, may not be\\n";
    printf "text, or every word in it may be shorter than %d letters.\\n", minlen;
    emit_json(0);
    exit 0;
  }

  # The full table, sorted by the shell. POSIX awk cannot sort an array
  # and an in-awk sort of every distinct word would be the slowest part
  # of the job; sort(1) is as available as awk itself.
  sorter = "sort -t, -k2,2nr -k1,1 >> " csv;
  for (w in count) printf "%s,%d\\n", w, count[w] | sorter;
  close(sorter);

  # The top N, chosen by repeated maximum. That is O(unique * topn),
  # which beats sorting everything when topn is the 25 or so a person
  # actually reads. Collected into arrays first so the same ranking
  # feeds both the text report and the JSON.
  shown = (topn < unique) ? topn : unique;
  for (rank = 1; rank <= shown; rank++) {
    best = ""; bestc = -1;
    for (w in count) {
      if (count[w] > bestc || (count[w] == bestc && w < best)) {
        best = w; bestc = count[w];
      }
    }
    if (bestc < 0) { shown = rank - 1; break; }
    topword[rank] = best; topcount[rank] = bestc;
    delete count[best];
  }

  emit_json(shown);

  printf "Top %d:\\n\\n", shown;
  printf "  %-24s %8s %7s\\n", "word", "count", "share";
  for (rank = 1; rank <= shown; rank++) {
    printf "  %-24s %8d %6.2f%%\\n", topword[rank], topcount[rank],
      (topcount[rank] * 100.0) / total;
  }
  printf "\\nThe full table of every word is in %s.\\n", csv;
}

# The structured result the page draws its table from.
#
# Written with explicit printf rather than assembled in a string: a
# single long concatenation is where an unbalanced brace hides, and
# this file is read by whoever is debugging a job that produced
# unparseable JSON.
function emit_json(n,   i, sep) {
  printf "{\\n" > results;
  printf "  \\"file\\": %s,\\n", labeljson >> results;
  printf "  \\"totalWords\\": %d,\\n", rawtotal + 0 >> results;
  printf "  \\"countedWords\\": %d,\\n", total + 0 >> results;
  printf "  \\"uniqueWords\\": %d,\\n", unique + 0 >> results;
  printf "  \\"options\\": {\\"minLength\\": %d, \\"topN\\": %d, \\"foldCase\\": %s, \\"skipCommonWords\\": %s},\\n",
    minlen, topn, (fold ? "true" : "false"), (usestop ? "true" : "false") >> results;
  printf "  \\"words\\": [" >> results;
  sep = "\\n    ";
  for (i = 1; i <= n; i++) {
    # No escaping needed: the tokenizer admits only letters and
    # apostrophes, so a word cannot contain a quote or a backslash.
    printf "%s{\\"word\\": \\"%s\\", \\"count\\": %d, \\"share\\": %.4f}",
      sep, topword[i], topcount[i], (total > 0 ? (topcount[i] * 100.0) / total : 0) >> results;
    sep = ",\\n    ";
  }
  printf "%s]\\n}\\n", (n > 0 ? "\\n  " : "") >> results;
  close(results);
}
`;
}

/**
 * What the job runs.
 *
 * Every file in OUTPUT_FILES is created empty FIRST, before awk can
 * fail. HTCondor holds a job whose declared output file is missing at
 * the end, and a hold for "missing output" tells the user nothing
 * about the file they dropped. An empty-but-present file lets the real
 * failure -- a non-zero exit, a message on stderr -- be the thing they
 * see.
 *
 * It is one `bash -c` string because `: >` is shell, not awk. Nothing
 * in it is derived from user input: the names are module constants.
 */
export function jobScript(): string {
  return [...OUTPUT_FILES.map((f) => `: > ${f}`), `awk -f ${PROGRAM_NAME} ${INPUT_NAME}`].join('; ');
}

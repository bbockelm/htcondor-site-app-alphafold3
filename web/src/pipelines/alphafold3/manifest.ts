// Reading what the user gave us: a CSV manifest, or sequences pasted
// into the box.
//
// The manifest is the tutorial's own format, column for column:
//
//   job_name, mol1_type, mol1_chain, mol1_seq, mol2_type, ...
//
// so a spreadsheet prepared for the command-line tutorial works here
// unchanged. Everything this file does beyond parsing is REFUSING: a
// name that cannot be a file name in a flat directory, a sequence that
// is not a sequence, a row with nothing in it. Each refusal names the
// row and the thing to change, because the alternative is a workflow
// that runs for an hour and comes back empty.

import { isSafeFileName } from '../../lib/submit';
import { isMoleculeType, type FoldJob, type Molecule } from './foldinput';

/** A manifest row that became a job, plus where it came from. */
export interface ParsedJob extends FoldJob {
  /** 1-based, as the tutorial numbers job directories. */
  index: number;
  /** `Job1_my_protein`: unique, safe, and the stem of every file. */
  tag: string;
}

export interface ParseResult {
  jobs: ParsedJob[];
  /** One line per thing the user has to fix. Shown as given. */
  problems: string[];
}

/** The most jobs one workflow will carry. Each is two node jobs. */
export const MAX_JOBS = 200;

/** A manifest larger than this is not a manifest. */
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

/**
 * Split CSV text into rows.
 *
 * Quoted fields, doubled quotes inside them, CRLF, and a trailing
 * newline. Sequences contain no commas, but job names written by a
 * person contain anything at all.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let any = false;

  const endField = () => {
    row.push(field);
    field = '';
    any = true;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    any = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      any = true;
    } else if (c === ',') {
      endField();
    } else if (c === '\n') {
      endRow();
    } else if (c === '\r') {
      // Swallowed: a CRLF ends the row on the \n.
    } else {
      field += c;
    }
  }
  if (field !== '' || any || row.length) endRow();

  // Drop rows that are entirely empty, which is what a trailing
  // newline and a blank line between records both look like.
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/** Letters only: every residue and base AlphaFold3 takes is a letter. */
const SEQUENCE_RE = /^[A-Za-z]+$/;
/** A chain id is a short label, not a sentence. */
const CHAIN_RE = /^[A-Za-z0-9]{1,4}$/;
/** A SMILES string or CCD code: printable, no quotes, no separators. */
const LIGAND_RE = /^[\x21-\x7e]+$/;

function checkChains(chain: string): string | undefined {
  const parts = chain.includes('|') ? chain.split('|') : [chain];
  const ids = parts.map((p) => p.trim());
  if (ids.length === 0 || ids.some((id) => !CHAIN_RE.test(id))) {
    return `chain “${chain}” should be a short label such as A, or several separated by | such as A|B`;
  }
  if (new Set(ids).size !== ids.length) return `chain “${chain}” names the same chain twice`;
  return undefined;
}

function checkMolecule(m: Molecule): string | undefined {
  const bad = checkChains(m.chain);
  if (bad) return bad;
  const seq = m.sequence.trim();
  if (m.type === 'smiles') {
    return LIGAND_RE.test(seq) ? undefined : 'the SMILES string contains spaces or control characters';
  }
  if (m.type === 'ccdCodes') {
    const codes = seq.split('|').map((c) => c.trim());
    return codes.length > 0 && codes.every((c) => LIGAND_RE.test(c))
      ? undefined
      : 'the CCD codes should look like ATP, or ATP|ADP for several';
  }
  if (!SEQUENCE_RE.test(seq)) {
    return `the ${m.type} sequence contains something that is not a residue letter`;
  }
  return undefined;
}

/** `Job3_my_protein`, the way the tutorial names a job directory. */
export function jobTag(index: number, name: string): string {
  return `Job${index}_${name}`;
}

/**
 * Turn rows into jobs.
 *
 * The first row is the header. Header names are trimmed, which the
 * upstream script does not do: `job_name, mol1_type` with a space
 * after the comma gives DictReader a key of `" mol1_type"`, the
 * molecule loop stops on the first column it cannot find, and every
 * job comes out with an empty `sequences` list. It fails later, in
 * AlphaFold3, having cost a queue slot.
 */
export function jobsFromRows(rows: string[][]): ParseResult {
  const problems: string[] = [];
  const jobs: ParsedJob[] = [];
  if (rows.length === 0) {
    return { jobs, problems: ['The manifest is empty.'] };
  }

  const header = rows[0].map((h) => h.trim().toLowerCase());
  if (!header.includes('job_name')) {
    return {
      jobs,
      problems: [
        'The manifest needs a job_name column. The first line should read: ' +
          'job_name,mol1_type,mol1_chain,mol1_seq',
      ],
    };
  }

  const seen = new Set<string>();
  for (let r = 1; r < rows.length; r++) {
    const line = r + 1;
    const cells = rows[r];
    const get = (key: string): string => {
      const i = header.indexOf(key);
      return i >= 0 && i < cells.length ? cells[i].trim() : '';
    };

    const name = get('job_name');
    if (name === '') {
      problems.push(`Line ${line}: no job_name.`);
      continue;
    }
    const index = jobs.length + 1;
    const tag = jobTag(index, name);
    if (!isSafeFileName(tag)) {
      problems.push(
        `Line ${line}: rename “${name}”. Job names become file names, so they can use ` +
          'letters, digits, dot, dash and underscore only.',
      );
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      problems.push(`Line ${line}: there is already a job called “${name}”.`);
      continue;
    }
    seen.add(key);

    const molecules: Molecule[] = [];
    let rowBad = false;
    for (let i = 1; header.includes(`mol${i}_type`); i++) {
      const type = get(`mol${i}_type`);
      const chain = get(`mol${i}_chain`);
      const sequence = get(`mol${i}_seq`);
      // A trailing empty triplet is how a spreadsheet writes "this row
      // has fewer molecules than that one". Skipped, not refused.
      if (type === '' && chain === '' && sequence === '') continue;
      if (type === '' || chain === '' || sequence === '') {
        problems.push(
          `Line ${line}, molecule ${i}: needs all three of type, chain and sequence.`,
        );
        rowBad = true;
        continue;
      }
      if (!isMoleculeType(type)) {
        problems.push(
          `Line ${line}, molecule ${i}: “${type}” is not a molecule type. ` +
            'Use protein, rna, dna, smiles or ccdCodes.',
        );
        rowBad = true;
        continue;
      }
      const m: Molecule = { type, chain, sequence };
      const bad = checkMolecule(m);
      if (bad) {
        problems.push(`Line ${line}, molecule ${i}: ${bad}.`);
        rowBad = true;
        continue;
      }
      molecules.push(m);
    }
    if (rowBad) continue;
    if (molecules.length === 0) {
      problems.push(`Line ${line}: “${name}” has no molecules to fold.`);
      continue;
    }
    jobs.push({ index, tag, name, molecules });
  }

  if (jobs.length > MAX_JOBS) {
    problems.push(
      `That is ${jobs.length} jobs. This form runs at most ${MAX_JOBS} at a time; ` +
        'split the manifest, or ask a facilitator about running the batch from the command line.',
    );
  }
  return { jobs, problems };
}

export function jobsFromCsv(text: string): ParseResult {
  return jobsFromRows(parseCsv(text));
}

/**
 * Sequences pasted into the box, as protein jobs.
 *
 * This is how most people arrive: one sequence, on the clipboard, out
 * of a paper or UniProt. FASTA only reaches protein with one chain --
 * anything else (RNA, a ligand, a multimer) needs the manifest, and the
 * interface says so rather than guessing.
 */
export function jobsFromFasta(text: string, startIndex = 1): ParseResult {
  const problems: string[] = [];
  const jobs: ParsedJob[] = [];
  const trimmed = text.trim();
  if (trimmed === '') return { jobs, problems };

  // No `>` at all: one sequence, pasted bare. Giving it a header here
  // rather than refusing is the difference between an answer and a
  // form error for the commonest input there is.
  const body = trimmed.startsWith('>') ? trimmed : `>pasted_sequence\n${trimmed}`;
  const records = body
    .split(/^>/m)
    .slice(1)
    .map((chunk) => {
      const nl = chunk.indexOf('\n');
      const head = (nl < 0 ? chunk : chunk.slice(0, nl)).trim();
      const seq = (nl < 0 ? '' : chunk.slice(nl + 1)).replace(/\s+/g, '');
      return { head, seq };
    });

  for (const [i, rec] of records.entries()) {
    const label = rec.head.split(/\s+/)[0] ?? '';
    // A FASTA header is free text -- `sp|P0CG48|UBC_HUMAN` is typical --
    // so it is reduced to something that can be a file name rather than
    // rejected. The user's own name survives in fold_input.json.
    const name = label.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '') || `sequence_${i + 1}`;
    if (rec.seq === '') {
      problems.push(`Pasted sequence ${i + 1} (“${label || 'unnamed'}”) has no residues.`);
      continue;
    }
    if (!SEQUENCE_RE.test(rec.seq)) {
      problems.push(
        `Pasted sequence ${i + 1} (“${label || 'unnamed'}”) contains something that is not a residue letter.`,
      );
      continue;
    }
    const index = startIndex + jobs.length;
    const tag = jobTag(index, name);
    if (!isSafeFileName(tag)) {
      problems.push(`Pasted sequence ${i + 1}: “${label}” cannot be used as a job name.`);
      continue;
    }
    jobs.push({
      index,
      tag,
      name,
      molecules: [{ type: 'protein', chain: 'A', sequence: rec.seq }],
    });
  }
  return { jobs, problems };
}

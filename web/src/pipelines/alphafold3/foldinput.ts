// The job's program, generated in the browser: fold_input.json.
//
// This is a port of scripts/generate-job-directories.py from the AF3
// tutorials, and it is deliberately a PORT rather than an improvement.
// AlphaFold3 reads this file; a difference between what the tutorial
// produces and what this produces is a difference in the science, not
// a difference in an interface. foldinput.test.ts checks the output
// against files the upstream script actually wrote.
//
// Doing it here rather than in the job is the same move the template's
// other pipelines make with awk programs and Python scripts: the user's
// sequences become a FILE, which is data, instead of arguments, which
// are a place to get quoting wrong.

/** What a row of the manifest says one molecule is. */
export type MoleculeType = 'protein' | 'rna' | 'dna' | 'smiles' | 'ccdCodes';

export const MOLECULE_TYPES: readonly MoleculeType[] = [
  'protein',
  'rna',
  'dna',
  'smiles',
  'ccdCodes',
];

export function isMoleculeType(v: string): v is MoleculeType {
  return (MOLECULE_TYPES as readonly string[]).includes(v);
}

/** One molecule, as the manifest gives it: still text. */
export interface Molecule {
  type: MoleculeType;
  /** Chain id, or several separated by `|`. */
  chain: string;
  /** Sequence, SMILES string, or `|`-separated CCD codes. */
  sequence: string;
}

/** One AF3 job: a name and the molecules it folds. */
export interface FoldJob {
  /** The `name` inside fold_input.json. The user's own job name. */
  name: string;
  molecules: Molecule[];
}

/** A molecule block, in the shape AlphaFold3 expects. */
type Chains = string | string[];
interface SequenceBlock {
  id: Chains;
  sequence: string;
}
interface SmilesBlock {
  id: Chains;
  smiles: string;
}
interface CcdBlock {
  id: Chains;
  ccdCodes: string[];
}
export type MoleculeBlock =
  | { protein: SequenceBlock }
  | { rna: SequenceBlock }
  | { dna: SequenceBlock }
  | { ligand: SmilesBlock | CcdBlock };

/**
 * `"A|B|C"` becomes `["A","B","C"]`; `"A"` stays a string.
 *
 * Upstream makes exactly this distinction, and it is load-bearing
 * further down: the token count multiplies a sequence by the number of
 * chains, and a one-element ARRAY would be counted the same as a bare
 * string but written differently into the JSON.
 */
export function chainIds(chain: string): Chains {
  if (chain.includes('|')) {
    return chain
      .split('|')
      .map((c) => c.trim())
      .filter((c) => c !== '');
  }
  return chain.trim();
}

export function moleculeBlock(m: Molecule): MoleculeBlock {
  const id = chainIds(m.chain);
  const sequence = m.sequence.trim();
  if (m.type === 'smiles') return { ligand: { id, smiles: sequence } };
  if (m.type === 'ccdCodes') {
    return {
      ligand: {
        id,
        ccdCodes: sequence
          .split('|')
          .map((c) => c.trim())
          .filter((c) => c !== ''),
      },
    };
  }
  return { [m.type]: { id, sequence } } as MoleculeBlock;
}

/** Seeds to run each job with. One prediction per seed. */
export const SEED_CHOICES = [1, 2, 3, 5] as const;

export function seedList(count: number): number[] {
  const n = Math.min(Math.max(Math.round(count), 1), SEED_CHOICES[SEED_CHOICES.length - 1]);
  return Array.from({ length: n }, (_, i) => i + 1);
}

/**
 * fold_input.json, as text.
 *
 * Two spaces of indent and this key order because that is what the
 * upstream script writes, and the fixtures in foldinput.test.ts are
 * its actual output.
 */
export function foldInputJson(job: FoldJob, seeds: number[]): string {
  return JSON.stringify(
    {
      name: job.name,
      sequences: job.molecules.map(moleculeBlock),
      modelSeeds: seeds,
      dialect: 'alphafold3',
      version: 3,
    },
    null,
    2,
  );
}

/**
 * Tokens: the sequence length summed over every chain.
 *
 * Ligands contribute nothing. That is upstream's choice and it is a
 * simplification -- a ligand is really a handful of tokens -- but the
 * estimate it feeds has a floor well above the difference.
 */
export function countTokens(molecules: Molecule[]): number {
  let total = 0;
  for (const m of molecules) {
    const block = moleculeBlock(m);
    const inner = Object.values(block)[0] as { id: Chains; sequence?: string };
    if (typeof inner.sequence !== 'string') continue;
    const chains = Array.isArray(inner.id) ? inner.id.length : 1;
    total += inner.sequence.length * chains;
  }
  return total;
}

/** The fit upstream uses to turn a token count into GPU memory. */
export function estimateVramGB(tokens: number): number {
  return Math.max(0, 0.01796 * tokens - 4.13);
}

/**
 * Smallest GPU this job can be given, in GB.
 *
 * The floor is REACHABLE, which is the whole point of writing it as a
 * floor: a 76-residue peptide estimates below zero, and asking for
 * `ceil(0) GB` of GPU memory is a request no machine can satisfy in a
 * way anyone can reason about. Anything under about 620 tokens lands
 * here. (The template's AGENTS.md calls the opposite case out: a
 * `max()` whose first argument can never win is a bug, and this one
 * wins for every small job.)
 */
export const MIN_VRAM_GB = 7;

export function requestedVramGB(tokens: number): number {
  return Math.max(MIN_VRAM_GB, Math.ceil(estimateVramGB(tokens)));
}

/**
 * Above this the tutorials tell you to ask a facilitator first, rather
 * than queueing something no GPU in the pool can hold.
 */
export const VRAM_WARN_GB = 130;

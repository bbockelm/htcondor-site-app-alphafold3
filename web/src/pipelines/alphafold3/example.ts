// Something to run for someone who has no manifest to hand.
//
// Two jobs, both built here rather than shipped as an asset: human
// ubiquitin on its own, and the same protein with an ATP ligand. They
// are real sequences and a real molecule, because the point of the
// example is to show what the form expects -- a made-up protein would
// teach the shape of the file and nothing else.
//
// Ubiquitin is 76 residues, which is about as small as a fold gets.
// That matters for an example: the GPU request lands on its floor, the
// alignment search is as short as this workflow ever is, and nobody is
// asked to wait on an 800-residue complex to see whether the interface
// works.
//
// WHAT THE EXAMPLE CANNOT INCLUDE is the model weights. They are
// licensed from Google DeepMind, they are not redistributable, and
// they are several gigabytes besides. With the weights box empty this
// runs the alignment stage and stops there, which is a real half of
// the workflow and is what the note below says.

import type { FileSet } from '../types';
import type { AlphaFold3Options } from './index';

export const EXAMPLE_MANIFEST = 'example-manifest.csv';

/** Human ubiquitin (UBB/UBC repeat), 76 residues. */
export const UBIQUITIN =
  'MQIFVKTLTGKTITLEVEPSDTIENVKAKIQDKEGIPPDQQRLIFAGKQLEDGRTLSDYNIQKESTLHLVLRLRGG';

/**
 * The manifest, as text.
 *
 * The first row ends in an empty molecule triplet, which is what a
 * spreadsheet writes when one row has fewer molecules than another. It
 * is here on purpose: that row shape is the commonest thing a real
 * manifest does and the parser has to skip it rather than refuse it.
 */
export function buildExampleCsv(): string {
  return [
    'job_name,mol1_type,mol1_chain,mol1_seq,mol2_type,mol2_chain,mol2_seq',
    `ubiquitin,protein,A,${UBIQUITIN},,,`,
    `ubiquitin_with_ATP,protein,A,${UBIQUITIN},ccdCodes,B,ATP`,
    '',
  ].join('\n');
}

export function buildExample(): FileSet {
  return {
    manifest: [new File([buildExampleCsv()], EXAMPLE_MANIFEST, { type: 'text/csv' })],
  };
}

/**
 * Nothing is overridden.
 *
 * The weights box is the one setting that would matter here and the
 * example has no business filling it in: wherever this group keeps its
 * weights, this app does not know it, and a guess would be a job that
 * waits for a GPU to tell the user a file was not found.
 */
export const EXAMPLE_OPTIONS: Partial<AlphaFold3Options> = {};

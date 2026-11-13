// What this access point provides, and where AlphaFold3 lives on it.
//
// EVERYTHING IN THIS FILE IS SITE POLICY, NOT SCIENCE. The AlphaFold3
// workflow is the same everywhere; what differs between access points
// is the container image, whether any execute point has the ~650 GB of
// reference databases on local disk, what a GPU job has to say to be
// scheduled, and where this group keeps the two wrapper scripts.
//
// Pick a preset at the bottom of this file. ONE line.
//
// The shipped default is `none`, which is not a working configuration:
// it submits, runs, and reports "AlphaFold3 is not available here" in
// words. That is deliberate. The values in `chtc` and `ospool` are
// transcribed from the two published tutorials, but nothing in this
// repository can check that a given pool has AlphaFold3 machines in it
// today -- and an app that quietly asks for a container no execute
// point can fetch holds every job with a file-transfer error, which
// tells the user nothing at all. An honest failure beats a plausible
// one, so configuring this file is a deployment step with a check in
// front of it. See README.md.

export interface SiteConfig {
  /** Which preset this is. Shown in the interface. */
  id: string;
  /** How the access point is named to a user. */
  label: string;

  /**
   * `container_image` for both stages, or '' for none.
   *
   * A `.sif` here makes HTCondor add `TARGET.HasSIF` to the job's
   * requirements by itself, so there is nothing else to write.
   */
  containerImage: string;

  /**
   * `Requirements` for the ALIGNMENT stage, or '' for none.
   *
   * This is the clause that says "only machines that already hold the
   * reference databases". Without it a data job can land anywhere and
   * spend the better part of an hour pulling several hundred gigabytes
   * before it starts, which is why both tutorials set it and why the
   * disk request below is written as an expression.
   */
  dataRequirements: string;

  /** `+Attr = value` lines for the alignment stage. Values are ClassAd
   *  expressions, so a string needs its own quotes. */
  dataAttributes: Record<string, string>;
  /** `+Attr = value` lines for the inference stage. At CHTC a GPU job
   *  that does not say `+WantGPULab = true` matches nothing. */
  inferenceAttributes: Record<string, string>;
  /** Plain submit commands for the inference stage, for site submit
   *  transforms that key off one (CHTC reads `want_ospool`). */
  inferenceCommands: Record<string, string>;

  /**
   * Where `data_pipeline.sh` and `inference_pipeline.sh` are staged, as
   * something `transfer_input_files` accepts: a URL the execute node
   * can fetch, or an absolute path on the access point.
   *
   * '' means they are not staged, and the job looks for them in the
   * container and on PATH instead. Neither tutorial's container ships
   * them, so '' usually ends in the "not available here" message.
   */
  toolsBase: string;

  /** Default for the model weights box. Per-user, so usually ''. */
  weightsDefault: string;

  /** Alignment stage. `dataDisk` is a submit expression, not a number,
   *  so it can ask for less when the databases are already there. */
  dataCpus: number;
  dataMemory: string;
  dataDisk: string;
  /** `--msa_workers`. Keep `--msa_cpus_per_worker` at 1 and scale this;
   *  the product must not exceed dataCpus. */
  msaWorkers: number;

  /** Inference stage. The GPU memory is computed per job from tokens. */
  inferenceMemory: string;
  inferenceDisk: string;
}

/**
 * Not configured. Submits, runs, and says so.
 *
 * The requests are small on purpose: this preset cannot do any real
 * work, so its one job is to be scheduled quickly enough to deliver
 * its explanation.
 */
export const NONE: SiteConfig = {
  id: 'none',
  label: 'not configured for AlphaFold3',
  containerImage: '',
  dataRequirements: '',
  dataAttributes: {},
  inferenceAttributes: {},
  inferenceCommands: {},
  toolsBase: '',
  weightsDefault: '',
  dataCpus: 1,
  dataMemory: '2 GB',
  dataDisk: '2 GB',
  msaWorkers: 1,
  inferenceMemory: '2 GB',
  inferenceDisk: '2 GB',
};

/**
 * CHTC, as published in CHTC/tutorial-CHTC-AF3.
 *
 * Three things here are CHTC's and not AlphaFold3's: `HasCHTCStaging`,
 * `+WantGPULab` (a GPU job without it is never matched) and
 * `want_ospool`, which a CHTC submit transform reads.
 */
export const CHTC: SiteConfig = {
  id: 'chtc',
  label: 'CHTC',
  containerImage: 'osdf:///osg-public/containers/alphafold3-custom-v6.sif',
  dataRequirements: '(TARGET.HasCHTCStaging == true) && (TARGET.HasAlphafold3 == true)',
  dataAttributes: {},
  inferenceAttributes: {
    GPUJobLength: '"short"',
    WantGPULab: 'true',
    is_resumable: 'true',
  },
  inferenceCommands: { want_ospool: 'true' },
  toolsBase: '',
  weightsDefault: '',
  dataCpus: 8,
  dataMemory: '24 GB',
  // KiB, as an expression: 700 GB, less the 650 GB the databases would
  // have cost on a machine that does not already have them.
  dataDisk: '700000000 - ( (TARGET.HasAlphafold3 ?: 1) * 650000000 )',
  msaWorkers: 4,
  inferenceMemory: '8 GB',
  inferenceDisk: '10 GB',
};

/** The OSPool, as published in osg-htc/tutorial-OSPool-AF3. */
export const OSPOOL: SiteConfig = {
  id: 'ospool',
  label: 'the OSPool',
  containerImage: 'osdf:///osg-public/containers/alphafold3-custom-v6.sif',
  dataRequirements: '(TARGET.HasAlphafold3 == true)',
  dataAttributes: {},
  inferenceAttributes: {},
  inferenceCommands: {},
  toolsBase: '',
  weightsDefault: '',
  dataCpus: 2,
  dataMemory: '2 GB',
  dataDisk: '15 GB',
  msaWorkers: 2,
  inferenceMemory: '8 GB',
  inferenceDisk: '10 GB',
};

export const PRESETS: Record<string, SiteConfig> = { none: NONE, chtc: CHTC, ospool: OSPOOL };

/**
 * THE LINE TO CHANGE.
 *
 * Before changing it, check that the pool actually has machines with
 * the databases on them -- `condor_status -constraint HasAlphafold3
 * -af Machine | wc -l` on the access point. If that is zero, the
 * alignment stage will sit idle for ever rather than fail, and nothing
 * in this interface can tell you why.
 *
 * Then set `toolsBase` on the preset to wherever this group staged
 * `data_pipeline.sh` and `inference_pipeline.sh` -- at CHTC that is
 * `osdf:///chtc/staging/<initial>/<netid>/alphafold3`.
 */
export const SITE: SiteConfig = NONE;

/** True when this app has not been pointed at an AlphaFold3 yet. */
export function isConfigured(site: SiteConfig = SITE): boolean {
  return site.toolsBase !== '' || site.containerImage !== '';
}

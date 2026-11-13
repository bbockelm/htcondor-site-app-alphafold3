import { describe, expect, it } from 'vitest';
import {
  DATA_RUNNER,
  EXIT_NO_AF3,
  INFERENCE_RUNNER,
  batchNameFor,
  buildDataRunner,
  buildDataSubmit,
  buildInferenceRunner,
  buildInferenceSubmit,
  dataStatusFile,
  dataTarball,
  inferenceStatusFile,
  inferenceTarball,
  isSafeReference,
  referenceBasename,
  tagOfStatusFile,
  toolReference,
  type RunSpec,
} from './af3';
import { CHTC, NONE, OSPOOL, type SiteConfig } from './site';

const WEIGHTS = '/staging/b/bbockelm/alphafold3/af3.bin.zst';

function spec(site: SiteConfig = NONE, weights = WEIGHTS): RunSpec {
  return { site, weights };
}

/** The value of a submit command, or undefined if it is not there. */
function command(submit: string, key: string): string | undefined {
  const line = submit.split('\n').find((l) => l.toLowerCase().startsWith(`${key.toLowerCase()} =`));
  return line?.slice(line.indexOf('=') + 1).trim();
}

describe('where a job is told to find a file', () => {
  it('takes a URL or an absolute path', () => {
    expect(isSafeReference('osdf:///chtc/staging/b/bbockelm/af3.bin.zst')).toBe(true);
    expect(isSafeReference('https://example.edu/af3.bin.zst')).toBe(true);
    expect(isSafeReference('/staging/b/bbockelm/af3.bin.zst')).toBe(true);
  });

  it('refuses everything that could become something else', () => {
    // In order: a submit macro, the server's own environment, the
    // separator between two transfer_input_files entries, a new submit
    // command, shell punctuation, a relative path, and nothing at all.
    for (const bad of [
      '/staging/$(Cluster)/af3.bin.zst',
      '/staging/$ENV(HOME)/af3.bin.zst',
      '/staging/a.zst,/etc/passwd',
      '/staging/a.zst\nrequest_gpus = 99',
      '/staging/a; rm -rf /',
      '/staging/"quoted".zst',
      'af3.bin.zst',
      '../af3.bin.zst',
      '',
    ]) {
      expect(isSafeReference(bad), bad).toBe(false);
    }
  });

  it('finds the file name at the end of one', () => {
    expect(referenceBasename('osdf:///a/b/af3.bin.zst')).toBe('af3.bin.zst');
    expect(referenceBasename('/a/b/af3.bin.zst')).toBe('af3.bin.zst');
    expect(referenceBasename('https://x/y/af3.bin.zst?v=2')).toBe('af3.bin.zst');
  });

  it('hangs a tool off a staging base without doubling the slash', () => {
    expect(toolReference('osdf:///a/b', 'data_pipeline.sh')).toBe('osdf:///a/b/data_pipeline.sh');
    expect(toolReference('osdf:///a/b/', 'data_pipeline.sh')).toBe('osdf:///a/b/data_pipeline.sh');
    expect(toolReference('', 'data_pipeline.sh')).toBe('');
  });
});

describe('the names files have in the workflow’s one flat directory', () => {
  it('puts a dot before data_pipeline.tar.gz, which the inference wrapper globs for', () => {
    // The wrapper looks for *.data_pipeline.tar.gz. A file called
    // data_pipeline.tar.gz does NOT match that glob -- the star cannot
    // eat the dot -- which is why both tutorials remap the name, and
    // why this app renames the file in the job instead: remaps are
    // ignored when DAGMan submits the node.
    expect(dataTarball('Job1_x')).toBe('Job1_x.data_pipeline.tar.gz');
    expect(dataTarball('Job1_x').endsWith('.data_pipeline.tar.gz')).toBe(true);
  });

  it('gives every job its own output names', () => {
    const a = [dataTarball('Job1_a'), dataStatusFile('Job1_a'), inferenceTarball('Job1_a')];
    const b = [dataTarball('Job2_b'), dataStatusFile('Job2_b'), inferenceTarball('Job2_b')];
    expect(new Set([...a, ...b]).size).toBe(6);
  });

  it('reads the job back out of a status file name', () => {
    expect(tagOfStatusFile(dataStatusFile('Job1_x.y'))).toBe('Job1_x.y');
    expect(tagOfStatusFile(inferenceStatusFile('Job1_x.y'))).toBe('Job1_x.y');
    expect(tagOfStatusFile('stdout-data-Job1_x.txt')).toBe('');
  });
});

describe('the alignment stage submit file', () => {
  const sub = buildDataSubmit(spec(), { tag: 'Job1_x', tokens: 100 });

  it('creates every declared output before anything can fail', () => {
    // HTCondor HOLDS a job whose declared output is missing at the
    // end, and holds it for a transfer error that says nothing about
    // what went wrong.
    const declared = command(sub, 'transfer_output_files')!.split(',');
    expect(declared).toEqual([dataTarball('Job1_x'), dataStatusFile('Job1_x')]);
    for (const f of declared) {
      expect(command(sub, 'arguments')).toContain(`: > ${f}`);
    }
  });

  it('carries the job it is running in the environment, not in the script', () => {
    expect(command(sub, 'environment')).toBe('"AF3_TAG=Job1_x"');
  });

  it('asks for the sequence file and the runner', () => {
    expect(command(sub, 'transfer_input_files')).toBe(`${DATA_RUNNER},Job1_x.fold_input.json`);
  });

  it('says +is_alphafold3, which both tutorials ask not to remove', () => {
    expect(sub).toContain('+is_alphafold3 = true');
  });

  it('does not use transfer_output_remaps', () => {
    // It is in both tutorials' submit files and it is honoured by
    // condor_submit. DAGMan submits this file itself, where it is
    // ignored silently -- the attribute is on the job ad either way.
    expect(sub).not.toContain('transfer_output_remaps');
  });

  it('does not hold the job when it fails', () => {
    // `on_exit_hold = (ExitCode != 0)` is in both tutorials. Under
    // DAGMan a held node is not a failed node: nothing retries it,
    // nothing reports it, and the workflow waits for ever.
    expect(sub).not.toContain('on_exit_hold');
  });

  it('names stdout and stderr after the job, because every node shares a directory', () => {
    expect(command(sub, 'output')).toBe('stdout-data-Job1_x.txt');
    expect(command(sub, 'error')).toBe('stderr-data-Job1_x.txt');
  });

  it('asks for no GPU', () => {
    expect(sub).not.toContain('request_gpus');
  });
});

describe('the alignment stage, at a site that has AlphaFold3', () => {
  const sub = buildDataSubmit(
    { site: { ...CHTC, toolsBase: 'osdf:///chtc/staging/b/bbockelm/af3' }, weights: WEIGHTS },
    { tag: 'Job1_x', tokens: 100 },
  );

  it('matches only machines that already hold the reference databases', () => {
    expect(command(sub, 'requirements')).toBe(CHTC.dataRequirements);
  });

  it('runs in the site’s container', () => {
    expect(command(sub, 'container_image')).toBe(CHTC.containerImage);
  });

  it('asks for less disk when the databases are already on the machine', () => {
    expect(command(sub, 'request_disk')).toBe(CHTC.dataDisk);
  });

  it('fetches the wrapper script from where the site staged it', () => {
    expect(command(sub, 'transfer_input_files')).toContain(
      'osdf:///chtc/staging/b/bbockelm/af3/data_pipeline.sh',
    );
  });

  it('says nothing at all about any of that when the site is unconfigured', () => {
    const bare = buildDataSubmit(spec(NONE), { tag: 'Job1_x', tokens: 100 });
    expect(bare).not.toContain('container_image');
    expect(bare).not.toContain('requirements =');
    expect(bare).not.toContain('data_pipeline.sh,');
  });
});

describe('the structure stage submit file', () => {
  const sub = buildInferenceSubmit(spec(), { tag: 'Job1_x', tokens: 780 });

  it('asks for one GPU, with the memory this job’s size needs', () => {
    expect(command(sub, 'request_gpus')).toBe('1');
    // Written with its unit. A bare number here is MEGABYTES, so `10`
    // would ask for 10 MB of GPU memory and match the first card it
    // saw.
    expect(command(sub, 'gpus_minimum_memory')).toBe('10 GB');
  });

  it('takes the alignments from the job its parent node produced them in', () => {
    const inputs = command(sub, 'transfer_input_files')!.split(',');
    expect(inputs).toContain(dataTarball('Job1_x'));
    expect(inputs).toContain(WEIGHTS);
    expect(inputs).toContain(INFERENCE_RUNNER);
  });

  it('adds what this site needs a GPU job to say', () => {
    const chtc = buildInferenceSubmit(spec(CHTC), { tag: 'Job1_x', tokens: 780 });
    // A CHTC GPU job without +WantGPULab matches nothing at all, and
    // nothing says so: it sits idle.
    expect(chtc).toContain('+WantGPULab = true');
    expect(chtc).toContain('+GPUJobLength = "short"');
    expect(chtc).toContain('want_ospool = true');
    expect(buildInferenceSubmit(spec(OSPOOL), { tag: 'Job1_x', tokens: 780 })).not.toContain(
      'WantGPULab',
    );
  });

  it('creates its outputs first, and does not remap or hold', () => {
    const declared = command(sub, 'transfer_output_files')!.split(',');
    expect(declared).toEqual([inferenceTarball('Job1_x'), inferenceStatusFile('Job1_x')]);
    for (const f of declared) expect(command(sub, 'arguments')).toContain(`: > ${f}`);
    expect(sub).not.toContain('transfer_output_remaps');
    expect(sub).not.toContain('on_exit_hold');
  });
});

describe('the runner scripts', () => {
  const data = buildDataRunner(spec());
  const infer = buildInferenceRunner(spec());

  it('is one script for every node, holding no job’s name', () => {
    // ONE runner is spooled for the whole workflow. An earlier version
    // of the template's BLAST pipeline generated it from the FIRST
    // node's values, so every other node processed that node's file
    // and reported it under its own name: a wrong answer, with nothing
    // in any log.
    for (const script of [data, infer]) {
      expect(script).not.toContain('Job1_');
      expect(script).toContain('TAG="${AF3_TAG:-}"');
    }
  });

  it('gives up without retrying when the machine has no AlphaFold3', () => {
    // The DAG's RETRY ... UNLESS-EXIT is written against this number.
    expect(data).toContain(`${EXIT_NO_AF3}`);
    expect(data).toContain('data_pipeline.sh');
    expect(infer).toContain('inference_pipeline.sh');
  });

  it('renames the alignment tarball, because the remap would not happen', () => {
    expect(data).toContain('*data_pipeline.tar.gz');
    expect(data).toContain('mv "$produced" "$OUT"');
    expect(data).toContain('OUT="$TAG.data_pipeline.tar.gz"');
  });

  it('makes the wrapper path absolute before running it from elsewhere', () => {
    // find_tool answers "./data_pipeline.sh" when the site staged the
    // script with the workflow -- and the wrapper is then run from a
    // directory of its own, where that path names nothing. The job
    // would report "no AlphaFold3 here" on a machine that had it.
    for (const script of [data, infer]) {
      expect(script).toContain('WRAPPER="$PWD/${WRAPPER#./}"');
      expect(script.indexOf('WRAPPER="$PWD/')).toBeLessThan(script.indexOf('cd "$RUNDIR"'));
    }
  });

  it('runs the wrapper in a directory of its own', () => {
    // The wrapper moves every *.json beside it into AlphaFold3's input
    // directory. Run in the workflow's own directory it would have
    // swept up every other job's sequences.
    expect(data).toContain('RUNDIR="run.$TAG"');
    expect(data).toContain('cp "$INPUT" "$RUNDIR/fold_input.json"');
  });

  it('writes its status file on the failure paths too', () => {
    // Every `finish` call writes the file the results page reads. A
    // runner that only wrote it on success would leave a failed job
    // as a blank row.
    const finishes = data.match(/finish \w+/g) ?? [];
    expect(finishes.length).toBeGreaterThan(4);
    expect(data).toContain('finish ok "" 0');
  });

  it('tells the user where the weights were meant to come from', () => {
    expect(infer).toContain("WEIGHTS='af3.bin.zst'");
    expect(infer).toContain('licensed from Google DeepMind');
  });

  it('scales MSA workers no further than the CPUs it asked for', () => {
    // msa_cpus_per_worker x msa_workers must not exceed request_cpus,
    // or the job oversubscribes its own allocation.
    const greedy = buildDataRunner({ site: { ...CHTC, dataCpus: 2, msaWorkers: 8 }, weights: '' });
    expect(greedy).toContain('--msa_cpus_per_worker 1 --msa_workers 2');
    expect(buildDataRunner(spec(CHTC))).toContain('--msa_workers 4');
  });
});

describe('batch names', () => {
  it('stamps the time, so one run can be told from another', () => {
    const a = batchNameFor(new Date('2026-01-12T03:14:00Z'));
    expect(a).toBe('alphafold3-20260112031400');
  });
});

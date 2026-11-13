import { describe, expect, it } from 'vitest';
import {
  MAX_JOBS,
  jobTag,
  jobsFromCsv,
  jobsFromFasta,
  parseCsv,
} from './manifest';

describe('reading a manifest', () => {
  it('reads the columns the tutorial documents', () => {
    const { jobs, problems } = jobsFromCsv(
      'job_name,mol1_type,mol1_chain,mol1_seq\nmine,protein,A,ACDEF\n',
    );
    expect(problems).toEqual([]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].tag).toBe('Job1_mine');
    expect(jobs[0].molecules).toEqual([{ type: 'protein', chain: 'A', sequence: 'ACDEF' }]);
  });

  it('survives a header written with spaces after the commas', () => {
    // The upstream script does not: DictReader keys the row by the
    // header verbatim, the molecule loop stops at the first column it
    // cannot find, and every job comes out with no molecules at all --
    // which AlphaFold3 discovers, in a job, after it has queued.
    const { jobs, problems } = jobsFromCsv(
      'job_name, mol1_type, mol1_chain, mol1_seq\nmine,protein,A,ACDEF\n',
    );
    expect(problems).toEqual([]);
    expect(jobs[0].molecules).toHaveLength(1);
  });

  it('skips a trailing empty molecule, which is how spreadsheets write a short row', () => {
    const { jobs, problems } = jobsFromCsv(
      'job_name,mol1_type,mol1_chain,mol1_seq,mol2_type,mol2_chain,mol2_seq\n' +
        'one,protein,A,ACDEF,,,\n' +
        'two,protein,A,ACDEF,rna,B,GUCU\n',
    );
    expect(problems).toEqual([]);
    expect(jobs.map((j) => j.molecules.length)).toEqual([1, 2]);
  });

  it('refuses a half-written molecule rather than folding the rest', () => {
    const { problems } = jobsFromCsv(
      'job_name,mol1_type,mol1_chain,mol1_seq\nmine,protein,,ACDEF\n',
    );
    expect(problems.join(' ')).toContain('all three');
  });

  it('names the row and the thing to change, every time', () => {
    const { jobs, problems } = jobsFromCsv(
      'job_name,mol1_type,mol1_chain,mol1_seq\n' +
        'bad type,protein,A,ACDEF\n' +
        'ok_name,rhubarb,A,ACDEF\n' +
        'ok2,protein,A chain,ACDEF\n' +
        'ok3,protein,A,ACD3F\n' +
        'ok4,protein,A,\n',
    );
    expect(jobs).toHaveLength(0);
    expect(problems).toHaveLength(5);
    expect(problems[0]).toContain('Line 2');
    expect(problems[1]).toContain('rhubarb');
    expect(problems[2]).toContain('Line 4');
    expect(problems[3]).toContain('residue letter');
    expect(problems[4]).toContain('Line 6');
  });

  it('refuses a name that could not be a file name in a flat directory', () => {
    // Every file this workflow writes is named after the job, in one
    // directory shared by every node. A name with a slash or a space
    // in it is a file nobody can transfer -- and `$(Cluster)` is a
    // submit-file macro that would be expanded by the submit
    // processor rather than written.
    for (const name of ['../etc/passwd', 'my protein', '$(Cluster)', 'a;b', '"quoted"']) {
      const { jobs, problems } = jobsFromCsv(
        `job_name,mol1_type,mol1_chain,mol1_seq\n"${name.replace(/"/g, '""')}",protein,A,ACDEF\n`,
      );
      expect(jobs, name).toHaveLength(0);
      expect(problems.join(' '), name).toContain('letters, digits');
    }
  });

  it('refuses two jobs with the same name', () => {
    const { jobs, problems } = jobsFromCsv(
      'job_name,mol1_type,mol1_chain,mol1_seq\nmine,protein,A,ACDEF\nMine,protein,A,ACDEF\n',
    );
    expect(jobs).toHaveLength(1);
    expect(problems.join(' ')).toContain('already a job');
  });

  it('refuses a manifest with no job_name column', () => {
    const { problems } = jobsFromCsv('name,seq\nmine,ACDEF\n');
    expect(problems.join(' ')).toContain('job_name column');
  });

  it('refuses a row with nothing to fold', () => {
    const { problems } = jobsFromCsv('job_name,mol1_type,mol1_chain,mol1_seq\nmine,,,\n');
    expect(problems.join(' ')).toContain('no molecules');
  });

  it('complains once the batch is larger than this form runs', () => {
    const rows = ['job_name,mol1_type,mol1_chain,mol1_seq'];
    for (let i = 0; i < MAX_JOBS + 1; i++) rows.push(`job${i},protein,A,ACDEF`);
    const { problems } = jobsFromCsv(rows.join('\n'));
    expect(problems.join(' ')).toContain(`at most ${MAX_JOBS}`);
  });

  it('accepts the ligand and multi-chain forms', () => {
    const { jobs, problems } = jobsFromCsv(
      'job_name,mol1_type,mol1_chain,mol1_seq,mol2_type,mol2_chain,mol2_seq\n' +
        'x,protein,A|B|C|D,ACDEF,smiles,K,CC(=O)OC1C[NH+]2CCC1CC2\n' +
        'y,protein,A,ACDEF,ccdCodes,G|H,ATP|ADP\n',
    );
    expect(problems).toEqual([]);
    expect(jobs).toHaveLength(2);
  });

  it('refuses the same chain letter twice in one molecule', () => {
    const { problems } = jobsFromCsv(
      'job_name,mol1_type,mol1_chain,mol1_seq\nx,protein,A|A,ACDEF\n',
    );
    expect(problems.join(' ')).toContain('same chain twice');
  });
});

describe('the CSV reader itself', () => {
  it('keeps a quoted comma inside its field', () => {
    expect(parseCsv('a,"b,c",d\n')).toEqual([['a', 'b,c', 'd']]);
  });
  it('reads a doubled quote as one quote', () => {
    expect(parseCsv('"he said ""hi""",x\n')).toEqual([['he said "hi"', 'x']]);
  });
  it('reads CRLF and drops blank lines', () => {
    expect(parseCsv('a,b\r\n\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
  it('reads a last line with no newline', () => {
    expect(parseCsv('a,b\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});

describe('a sequence pasted into the box', () => {
  it('folds a bare sequence with no FASTA header', () => {
    // How most people arrive: the sequence is on the clipboard and the
    // `>` line is not.
    const { jobs, problems } = jobsFromFasta('ACDEFGHIKL\nMNPQRSTVWY\n');
    expect(problems).toEqual([]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].molecules[0].sequence).toBe('ACDEFGHIKLMNPQRSTVWY');
    expect(jobs[0].molecules[0].type).toBe('protein');
  });

  it('reads several records, and tidies a header into a usable name', () => {
    const { jobs } = jobsFromFasta('>sp|P0CG48|UBC_HUMAN Ubiquitin\nACDEF\n>second one\nGHIKL\n');
    expect(jobs.map((j) => j.name)).toEqual(['sp_P0CG48_UBC_HUMAN', 'second']);
    expect(jobs.map((j) => j.tag)).toEqual(['Job1_sp_P0CG48_UBC_HUMAN', 'Job2_second']);
  });

  it('numbers its jobs after the manifest ones', () => {
    const { jobs } = jobsFromFasta('ACDEF', 4);
    expect(jobs[0].tag).toBe(jobTag(4, 'pasted_sequence'));
  });

  it('says so when the box holds something that is not a sequence', () => {
    const { jobs, problems } = jobsFromFasta('>mine\nACDEF123\n');
    expect(jobs).toHaveLength(0);
    expect(problems.join(' ')).toContain('residue letter');
  });

  it('is empty, not an error, when the box is empty', () => {
    expect(jobsFromFasta('   \n')).toEqual({ jobs: [], problems: [] });
  });
});

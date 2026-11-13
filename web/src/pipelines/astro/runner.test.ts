import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { buildRunner, runnerConfig, pythonString, type RunnerConfig } from './runner';
import { DEFAULT_OPTIONS } from './fits';

const config: RunnerConfig = runnerConfig(DEFAULT_OPTIONS, [
  { file: 'frame.fits', label: 'frame.fits' },
]);

/**
 * Run python3 over a generated runner.
 *
 * This is the test that matters in this file, and it deliberately does
 * not skip when python3 is missing. The unit tests can check that the
 * generated text contains what we meant; only a Python parser can tell
 * us the job will get past line one, and a job that cannot be parsed
 * is a job whose failure arrives as a hold nobody can read. If python3
 * is not available, that is a broken development environment, not a
 * test to quietly pass.
 */
function pythonCheck(source: string, expression: string): string {
  return execFileSync('python3', ['-I', '-c', PROBE, expression], {
    input: source,
    encoding: 'utf8',
  }).trim();
}

// Reads the runner on stdin, compiles it, and evaluates an expression
// against the CONFIG literal it parsed out. -I so nothing is imported
// from the working directory.
const PROBE = `
import ast, json, sys
src = sys.stdin.read()
tree = ast.parse(src, "fits_preview.py")   # raises SyntaxError if bad
compile(tree, "fits_preview.py", "exec")   # and this catches the rest
CONFIG = None
for node in tree.body:
    if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "CONFIG":
        call = node.value
        CONFIG = json.loads(ast.literal_eval(call.args[0]))
print(eval(sys.argv[1], {"CONFIG": CONFIG, "json": json}))
`;

describe('the generated runner', () => {
  it('is a Python program python3 will accept', () => {
    expect(pythonCheck(buildRunner(config), '"ok"')).toBe('ok');
  });

  it('carries the options through to the job unchanged', () => {
    const source = buildRunner(
      runnerConfig(
        { mode: 'composite', stretch: 'log', clip: '99.9', size: 2048 },
        [
          { file: 'r.fits', label: 'r.fits', channel: 'red' },
          { file: 'b.fits', label: 'b.fits', channel: 'blue' },
        ],
      ),
    );
    expect(pythonCheck(source, 'CONFIG["mode"]')).toBe('composite');
    expect(pythonCheck(source, 'CONFIG["stretch"]')).toBe('log');
    expect(pythonCheck(source, 'CONFIG["size"]')).toBe('2048');
    expect(pythonCheck(source, 'CONFIG["low"]')).toBe('0.05');
    expect(pythonCheck(source, '[i["channel"] for i in CONFIG["images"]]')).toBe(
      "['red', 'blue']",
    );
  });

  // The whole reason user input goes in as JSON and never as
  // interpolated source. Every one of these is a real file name or a
  // real FITS OBJECT card somebody has had.
  it('survives anything a user can put in a label', () => {
    for (const nasty of [
      'a"b',
      "it's",
      'back\\slash',
      'new\nline',
      '"""; import os; os.system("id")',
      'tab\there',
      'Grus II (dSph), α=22h',
      '\u0000control',
    ]) {
      const source = buildRunner(
        runnerConfig(DEFAULT_OPTIONS, [{ file: 'frame.fits', label: nasty }]),
      );
      expect(pythonCheck(source, 'CONFIG["images"][0]["label"] == json.loads(%s)' .replace('%s', JSON.stringify(JSON.stringify(nasty))))).toBe('True');
    }
  });

  it('never emits a sequence that would end a template literal', () => {
    // The runner is built from a JS template literal; a backtick or a
    // `${` reaching the output would mean the escaping in runner.ts
    // has drifted.
    const source = buildRunner(
      runnerConfig(DEFAULT_OPTIONS, [{ file: 'frame.fits', label: 'a`b${c}' }]),
    );
    expect(pythonCheck(source, '"ok"')).toBe('ok');
  });
});

describe('pythonString', () => {
  it('produces a literal python can read back', () => {
    for (const value of ['plain', 'a"b', 'a\\b', 'a\nb', 'åäö']) {
      const literal = pythonString(value);
      const out = execFileSync('python3', ['-I', '-c', 'import sys; print(eval(sys.argv[1]))', literal], {
        encoding: 'utf8',
      });
      expect(out.replace(/\n$/, '')).toBe(value.replace(/\n/g, '\n'));
    }
  });
});

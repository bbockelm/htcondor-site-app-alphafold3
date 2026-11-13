import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { loginAs, passwordFor, type DemoCredentials } from './fixtures/login';

const creds: DemoCredentials = JSON.parse(
  readFileSync(process.env.DEMO_CREDENTIALS_FILE!, 'utf8'),
);
const APP_ID = process.env.APP_ID ?? 'htcondor-site-app-alphafold3';
const APP_URL = `/site/${APP_ID}/`;

// WHAT THIS SUITE CAN AND CANNOT PROVE.
//
// The demo pool has no GPU, no AlphaFold3 container, no reference
// databases and no model weights, so no AlphaFold3 job can succeed
// here and no test below pretends one did. What a real server does
// prove -- and what no unit test can -- is that the submit files are
// ones a schedd accepts, that the workflow spools and DAGMan runs the
// graph, that a node job starts and reports on itself, and that its
// report reaches the results page as a sentence somebody can read.
//
// That last one is the whole failure path of this app, and on a pool
// that has AlphaFold3 it is the only part of the mechanism that
// changes.

test.beforeEach(async ({ page }) => {
  await loginAs(page, 'admin', passwordFor(creds, 'admin'));
});

test('the app is served under its own id and knows where it is', async ({ page }) => {
  await page.goto(APP_URL);

  // Not just "something rendered": assert the server injected the
  // mount point. Without it every relative asset still resolves (the
  // browser falls back to the directory) but client-side routing
  // silently builds wrong URLs.
  const injected = await page.evaluate(() => window.__HTCONDOR_APP__);
  expect(injected?.id).toBe(APP_ID);
  expect(injected?.base).toBe(APP_URL);

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

<<<<<<< HEAD
test('a manifest of sequences reaches the real queue as a workflow', async ({ page }) => {
=======
test('what to run is asked before which files to run it on', async ({ page }) => {
  await page.goto(APP_URL);

  // A slot's label, its hint and its `accept` all belong to the
  // pipeline, so a form that takes the files first is labelling its
  // pickers for whatever pipeline happened to be selected by default.
  // Asserted on DOM order rather than on coordinates: that is what the
  // reading order actually is, and it does not depend on the window.
  const before = await page.evaluate(() => {
    const pipeline = document.querySelector('[data-testid="pipeline"]');
    const picker = document.querySelector('[data-testid="file-input"]');
    if (!pipeline || !picker) return null;
    // DOCUMENT_POSITION_FOLLOWING: the picker comes after the pipeline.
    return Boolean(pipeline.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(before).toBe(true);

  // And the pipeline explains itself where it is chosen, rather than
  // leaving a first-time user to guess from the slot labels.
  await expect(page.getByTestId('pipeline-summary')).not.toBeEmpty();
  await expect(page.getByTestId('pipeline-about')).toContainText('What you need');
});

test('submitting reaches the real queue', async ({ page }) => {
>>>>>>> f125d64 (Take the template's field-feedback fixes: form order, one-pipeline picker, phone tables, job order)
  await page.goto(APP_URL);

  // A manifest in the shape the tutorial documents, attached through
  // the hidden input; drag-and-drop is the same code path below it.
  // This is also the only place the browser's own File reader is
  // exercised -- the unit tests build the same text by hand.
  await page.getByTestId('file-input').setInputFiles({
    name: 'manifest.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'job_name,mol1_type,mol1_chain,mol1_seq\ne2e_peptide,protein,A,ACDEFGHIKLMNPQRSTVWY\n',
    ),
  });
  await expect(page.getByTestId('file-list')).toContainText('manifest.csv');

  // With a weights location the workflow is TWO stages with an edge
  // between them, which is a different graph and a different thing for
  // the server to accept: the structure node asks for a file nobody
  // supplied, because its parent produces it. The server's own DAG
  // analyser has to see that, and a workflow it rejected would never
  // reach the queue. Nothing here folds anything -- the demo pool has
  // no GPU and nothing is staged at the path below -- so the structure
  // node is submitted, never run.
  await page.getByTestId('af3-weights').fill('/staging/e2e/alphafold3/af3.bin.zst');

  await page.getByTestId('submit').click();

  // The success notice carries the real cluster.proc the schedd
  // assigned, so asserting on it proves the submit reached the queue
  // rather than that a button changed state.
  const notice = page.getByTestId('submitted');
  await expect(notice).toBeVisible({ timeout: 60_000 });
  await expect(notice).toContainText(/Submitted job \d+\.\d+/);
  await expect(page.getByTestId('job-list')).toBeVisible();
});

test('a weights location that is not one is refused here, not by the schedd', async ({ page }) => {
  await page.goto(APP_URL);
  await page.getByTestId('use-example').check();
  // `$(Cluster)` is a submit-file macro. If it reached the submit file
  // it would be expanded rather than written, which is the quiet half
  // of this class of bug; the loud half is `$ENV(...)`, which reads the
  // SERVER's environment.
  await page.getByTestId('af3-weights').fill('/staging/$(Cluster)/af3.bin.zst');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('error')).toContainText('model weights location');
  await expect(page.getByTestId('submitted')).toBeHidden();
});

test('an API failure is reported in words, not swallowed', async ({ page }) => {
  await page.route('**/api/v1/jobs/dag', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'the schedd is not answering' }),
        })
      : route.continue(),
  );

  await page.goto(APP_URL);
  // The example data first: the pipeline refuses to plan an empty
  // submission, and that refusal is a client-side message that never
  // reaches the API -- so without this the route below is never hit.
  await page.getByTestId('use-example').check();
  await expect(page.getByTestId('example-files')).toContainText('.csv');

  await page.getByTestId('submit').click();

  // The server's own message, not a generic "something went wrong":
  // the API writes these to be read by the person who hit them.
  await expect(page.getByTestId('error')).toContainText('the schedd is not answering');
});

test('the example data is enough to submit with, on its own', async ({ page }) => {
  await page.goto(APP_URL);

  // The whole reason the box exists: a person seeing this for the
  // first time has no manifest of sequences, and without it there is
  // nothing they can do but read the form. The model weights are the
  // one thing the example cannot supply -- they are licensed -- so
  // ticking the box runs the alignment stage alone.
  await page.getByTestId('use-example').check();
  await expect(page.getByTestId('example-files')).toContainText('.csv');

  await page.getByTestId('submit').click();

  const notice = page.getByTestId('submitted');
  await expect(notice).toBeVisible({ timeout: 60_000 });
  await expect(notice).toContainText(/Submitted job \d+\.\d+/);
});

<<<<<<< HEAD
test('a workflow that cannot run says why, per job, on the results page', async ({ page }) => {
  // The slow one. It runs the whole mechanism: the DAG spools, DAGMan
  // starts on the access point, it submits the node jobs itself, a
  // node runs on an execute machine, finds no AlphaFold3 there, writes
  // its status file and exits with the code the DAG excuses from
  // RETRY. The manager finishes, and the page reads every node's
  // report out of the one sandbox they share.
=======
test('a finished job shows what it found, not only a download link', async ({ page }) => {
  // This one waits for a real job to run in the demo pool, so it is
  // slower than the rest. It is also the only test that proves the
  // results view is reachable at all: every pipeline shipped one for a
  // while, and the shell rendered none of them.
  test.setTimeout(240_000);

  await page.goto(APP_URL);
  await page.getByTestId('use-example').check();
  await page.getByTestId('submit').click();

  const submitted = page.getByTestId('submitted');
  await expect(submitted).toBeVisible();
  const id = (await submitted.innerText()).match(/(\d+\.\d+)/)![1];

  // The list polls every five seconds; a word count of four kilobytes
  // is seconds of compute and the rest is scheduling and transfer.
  const toggle = page.getByTestId(`results-toggle-${id}`);
  await expect(toggle).toBeVisible({ timeout: 200_000 });
  await toggle.click();

  const results = page.getByTestId(`results-${id}`);
  await expect(results).toBeVisible();
  // The counts, read from the job's results.json -- not the stdout
  // text, and not a link to a tarball.
  await expect(results.getByTestId('results-table')).toBeVisible();
  // A content word out of the passage, not a common one: "Skip common
  // words" is on by default, so "the" is deliberately NOT in the table
  // and asserting on it tests the wrong thing entirely.
  await expect(results.getByTestId('results-table')).toContainText('species');
  await expect(results.getByTestId('results-summary')).toContainText(/\d+ words in the file/);

  // ON A PHONE the same table is a list of cards.
  //
  // Checked against the real rendered page at a real phone width,
  // because this is CSS and nothing else can tell you whether it
  // happened. The layout is a media query, not a measurement, so the
  // same resize the browser does is the whole mechanism -- there is no
  // JavaScript to re-run and no first paint to get wrong.
  await page.setViewportSize({ width: 390, height: 844 });
  const table = results.getByTestId('results-table');

  // Rows and cells are no longer laid out as a table.
  const layout = await table.evaluate((el) => ({
    row: getComputedStyle(el.querySelector('tbody tr')!).display,
    cell: getComputedStyle(el.querySelector('tbody td')!).display,
    heading: getComputedStyle(el.querySelector('thead th.rank')!).display,
  }));
  expect(layout.row).toBe('block');
  expect(layout.cell).toBe('flex');
  // A heading that is not a sort control has nothing to do here: its
  // text now travels with each cell instead.
  expect(layout.heading).toBe('none');

  // The column's meaning travels with the value: the heading is drawn
  // in front of each cell from data-label, so a card is not a column
  // of unlabelled numbers.
  const labelled = await table.locator('tbody tr').first().evaluate((row) => {
    const cells = [...row.querySelectorAll('td')];
    return cells.map((td) => ({
      label: td.getAttribute('data-label'),
      before: getComputedStyle(td, '::before').content,
    }));
  });
  expect(labelled.map((c) => c.label)).toEqual(['Rank', 'Word', 'Times used', 'Share']);
  expect(labelled.map((c) => c.before)).toEqual([
    '"Rank"',
    '"Word"',
    '"Times used"',
    '"Share"',
  ]);

  // Sorting is not lost with the headings: the two heading buttons
  // stay, as a sort bar above the cards.
  await expect(table.getByRole('button', { name: /Times used/ })).toBeVisible();
  await expect(table.getByRole('button', { name: /^Word/ })).toBeVisible();

  // And nothing runs off the side of the screen.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('a workflow’s results are gathered from every node', async ({ page }) => {
  // BLAST is a DAG, so the job in the list is the MANAGER: it has no
  // hits of its own and its results are whatever its nodes wrote into
  // the shared sandbox. That path has its own ways to fail silently --
  // nodes overwriting each other's output, a manifest that cannot be
  // read back -- none of which a unit test can see.
>>>>>>> f125d64 (Take the template's field-feedback fixes: form order, one-pipeline picker, phone tables, job order)
  //
  // The demo pool genuinely cannot fold anything, so this is the real
  // answer rather than an avoided one -- and a failure that arrives as
  // a sentence is the thing most likely to break silently in this app.
  test.setTimeout(300_000);

  await page.goto(APP_URL);
  await page.getByTestId('use-example').check();
  await page.getByTestId('submit').click();

  const submitted = page.getByTestId('submitted');
  await expect(submitted).toBeVisible({ timeout: 60_000 });
  const id = (await submitted.innerText()).match(/(\d+\.\d+)/)![1];

  const toggle = page.getByTestId(`results-toggle-${id}`);
  await expect(toggle).toBeVisible({ timeout: 260_000 });
  await toggle.click();

  const results = page.getByTestId(`results-${id}`);
  await expect(results.getByTestId('af3-results')).toBeVisible();
  // Two jobs from the example manifest, each found by name in the
  // workflow's shared directory: proof the per-job output names
  // survived a flat spool.
  await expect(results.getByTestId('af3-summary')).toContainText('2 structures');
  await expect(results.getByTestId('af3-table')).toContainText('Job1_ubiquitin');
  await expect(results.getByTestId('af3-table')).toContainText('Job2_ubiquitin_with_ATP');
  // ...and the node's own words about why it could not fold them,
  // which is the whole point of writing a status file on the failure
  // path.
  await expect(results.getByTestId('af3-job-problem').first()).toContainText(
    'AlphaFold3 is not available',
  );
});

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

test('what to run is explained before which files to run it on', async ({ page }) => {
  await page.goto(APP_URL);

  // This app has ONE pipeline, so it draws no selector at all -- a
  // dropdown with a single entry is a control that cannot be used.
  // What stands in that space is the pipeline explaining itself, and
  // it has to come before the pickers: a slot's label, its hint and
  // its `accept` all belong to the pipeline, so a form that asks for
  // files first is labelling its pickers for something the user has
  // not been told about yet.
  await expect(page.getByTestId('pipeline')).toHaveCount(0);
  await expect(page.getByTestId('pipeline-about')).toContainText('What you need');

  // Asserted on DOM order rather than coordinates: that is what the
  // reading order actually is, and it does not depend on the window.
  const explainedFirst = await page.evaluate(() => {
    const about = document.querySelector('[data-testid="pipeline-about"]');
    const picker = document.querySelector('input[type="file"]');
    if (!about || !picker) return null;
    // DOCUMENT_POSITION_FOLLOWING: the picker comes after the text.
    return Boolean(about.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(explainedFirst).toBe(true);
});

test('a manifest of sequences reaches the real queue as a workflow', async ({ page }) => {
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

test('a workflow that cannot run says why, per job, on the results page', async ({ page }) => {
  // The slow one. It runs the whole mechanism: the DAG spools, DAGMan
  // starts on the access point, it submits the node jobs itself, a
  // node runs on an execute machine, finds no AlphaFold3 there, writes
  // its status file and exits with the code the DAG excuses from
  // RETRY. The manager finishes, and the page reads every node's
  // report out of the one sandbox they share.
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

test('the submit outcome lands on screen, where the button was pressed', async ({ page }) => {
  // The notice used to be rendered at the top of the page. On a
  // filled-in form that is a screenful or more above the button, so
  // pressing Run looked like it had done nothing at all.
  //
  // No earlier test could catch that, and every one of them passed
  // while it was happening: toBeVisible() asks whether an element is
  // RENDERED, not whether it is on screen, and an element scrolled a
  // thousand pixels above the window satisfies it. toBeInViewport is
  // the assertion that matches the complaint.
  await page.setViewportSize({ width: 390, height: 844 }); // a phone
  await page.goto(APP_URL);

  await page.getByTestId('use-example').check();

  const button = page.getByTestId('submit');
  // Pressed at the BOTTOM EDGE of the window, which is where a button
  // at the end of a form is when you have just scrolled down to it --
  // and the case where putting the notice next to the button is not
  // enough on its own, because next-to-it is just off the bottom.
  await button.evaluate((el) => el.scrollIntoView({ block: 'end' }));
  await button.click();

  const notice = page.getByTestId('submitted');
  await expect(notice).toBeVisible();
  // ratio: 1, not the default. The default passes on ANY intersection,
  // and measuring it showed this test going green on six visible
  // pixels of a fifty-pixel notice -- a sliver nobody can read, which
  // is the complaint it is supposed to be catching.
  await expect(notice).toBeInViewport({ ratio: 1 });

  // And the button is STILL on screen next to it. Without this, a page
  // that answered by scrolling back to a notice at the top would pass:
  // the notice would be in the viewport and the control the person was
  // using would have been thrown a screenful away.
  await expect(button).toBeInViewport({ ratio: 1 });
});

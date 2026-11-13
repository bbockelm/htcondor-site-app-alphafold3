import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PipelineChooser } from './PipelineChooser';
import type { AnyPipeline } from '../pipelines';
import type { PipelineDescription } from '../pipelines/types';

/**
 * Rendered to a string rather than into the DOM.
 *
 * This component has no state and no effects, so the markup IS the
 * behaviour, and a string spares the suite a React root, `act` and a
 * testing library the bundle would otherwise have to justify.
 */
function render(pipelines: AnyPipeline[], value = pipelines[0].id): string {
  return renderToStaticMarkup(
    <PipelineChooser pipelines={pipelines} value={value} onChange={() => {}} busy={false} />,
  );
}

const DESCRIPTION: PipelineDescription = {
  what: 'Folds the thing.',
  needs: 'A sequence file.',
  gives: 'A structure, as mmCIF.',
  cost: 'About an hour each.',
};

function stub(id: string, description?: PipelineDescription): AnyPipeline {
  return {
    id,
    name: `${id} pipeline`,
    summary: `what ${id} is for`,
    description,
    batchPrefix: `${id}-`,
    inputs: [{ id: 'input', label: 'Files', hint: 'anything', multiple: false }],
    defaults: {},
    Controls: () => <div />,
    plan: () => ({ kind: 'error', message: 'not in this test' }),
    Results: () => <div />,
  };
}

describe('choosing what to run', () => {
  it('offers a selector when there is a choice to make', () => {
    const html = render([stub('alpha'), stub('beta')]);
    expect(html).toContain('data-testid="pipeline"');
    expect(html).toContain('<option value="alpha"');
    expect(html).toContain('<option value="beta"');
  });

  it('draws NO selector for a single pipeline', () => {
    // A drop-down with one entry is a control that cannot do
    // anything. An app built from this template by deleting the
    // examples it does not want has exactly one pipeline, and that is
    // the common case, not the odd one.
    const html = render([stub('only')]);
    expect(html).not.toContain('<select');
    expect(html).not.toContain('data-testid="pipeline"');
  });

  it('puts the pipeline’s own description in that space instead', () => {
    // The point of removing the selector is that something USEFUL
    // takes its place: a first-time user of a single-purpose app has
    // nothing else on the page telling them what it wants.
    const html = render([stub('only', DESCRIPTION)]);
    expect(html).toContain('data-testid="pipeline-about"');
    expect(html).toContain('Folds the thing.');
    expect(html).toContain('A sequence file.');
    expect(html).toContain('A structure, as mmCIF.');
    expect(html).toContain('About an hour each.');
  });

  it('describes the pipeline that is SELECTED, not the first one', () => {
    const html = render([stub('alpha', DESCRIPTION), stub('beta')], 'beta');
    expect(html).toContain('what beta is for');
    expect(html).not.toContain('Folds the thing.');
  });

  it('still explains itself when several pipelines are offered', () => {
    const html = render([stub('alpha', DESCRIPTION), stub('beta')]);
    expect(html).toContain('data-testid="pipeline"');
    expect(html).toContain('data-testid="pipeline-about"');
  });

  it('omits the cost line a pipeline did not write', () => {
    const html = render([stub('only', { ...DESCRIPTION, cost: undefined })]);
    expect(html).toContain('What you get back');
    expect(html).not.toContain('What a run costs');
  });
});

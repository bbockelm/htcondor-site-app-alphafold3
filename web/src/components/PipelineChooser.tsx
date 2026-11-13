// What is being run, and what that means -- the first thing on the page.
//
// TWO THINGS LIVE HERE, AND BOTH ARE FEEDBACK FROM A REAL SITE.
//
// 1. It comes FIRST, above the file pickers. An earlier shell asked for
//    the files and then asked what to do with them, which is backwards:
//    a slot's label, its hint and its `accept` all belong to the
//    pipeline, so until the pipeline is chosen the pickers are labelled
//    for whatever was selected by default.
//
// 2. ONE pipeline gets no selector. A drop-down with a single entry is
//    a control that cannot do anything, and an app built from this
//    template by deleting two of the three examples has exactly that.
//    The space goes to the pipeline's own description instead, which is
//    what a first-time user of a single-purpose app actually needs:
//    what it does, what to bring, what comes back.
//
// The description is rendered either way, under the selector when there
// is one. It is not only for the single-pipeline case -- it is simply
// the explanation, and a three-pipeline app needs it as much.

import type { AnyPipeline } from '../pipelines';

interface Props {
  pipelines: AnyPipeline[];
  value: string;
  onChange: (id: string) => void;
  busy: boolean;
}

export function PipelineChooser({ pipelines, value, onChange, busy }: Props) {
  const pipeline = pipelines.find((p) => p.id === value) ?? pipelines[0];
  // One pipeline: no choice to make, so no control to draw.
  const choosing = pipelines.length > 1;

  return (
    <fieldset>
      <legend>{choosing ? 'What to run' : pipeline.name}</legend>

      {choosing && (
        <label>
          <span>Pipeline</span>
          <select
            value={pipeline.id}
            onChange={(e) => onChange(e.target.value)}
            disabled={busy}
            data-testid="pipeline"
          >
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <p className="summary" data-testid="pipeline-summary">
        {pipeline.summary}
      </p>

      {pipeline.description && (
        <dl className="about" data-testid="pipeline-about">
          <dt>What this does</dt>
          <dd>{pipeline.description.what}</dd>
          <dt>What you need</dt>
          <dd>{pipeline.description.needs}</dd>
          <dt>What you get back</dt>
          <dd>{pipeline.description.gives}</dd>
          {pipeline.description.cost && (
            <>
              <dt>What a run costs</dt>
              <dd>{pipeline.description.cost}</dd>
            </>
          )}
        </dl>
      )}
    </fieldset>
  );
}

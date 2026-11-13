import { useRef, useState, type DragEvent } from 'react';
import { formatSize } from '../lib/format';

interface Props {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
  /** `accept` for the file input, e.g. '.fits,.fit'. */
  accept?: string;
  /**
   * Whether more than one file is meaningful. A pipeline that takes
   * exactly one keeps only the last dropped, rather than silently
   * submitting the first of several.
   */
  multiple?: boolean;
  /**
   * Test ids for the hidden input and the file list.
   *
   * A pipeline with one slot keeps the unqualified ids, so a test can
   * drive the default pipeline without knowing which one it is; a
   * pipeline with several qualifies them by slot. See app.tsx.
   */
  inputTestId?: string;
  listTestId?: string;
}

/**
 * Drag-and-drop file picker.
 *
 * Keyboard and click both work, not only drag: a drop target that
 * cannot be reached from the keyboard is unusable for some people and
 * merely annoying on a laptop trackpad for everyone else.
 */
export function Dropzone({
  files,
  onChange,
  disabled,
  accept,
  multiple = true,
  inputTestId = 'file-input',
  listTestId = 'file-list',
}: Props) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  function add(incoming: FileList | null) {
    if (!incoming) return;
    const dropped = Array.from(incoming);
    // A pipeline that takes exactly one file keeps the last dropped.
    // Accumulating would leave an earlier file selected and submit
    // that one, which looks like the drop did nothing.
    if (!multiple) {
      const last = dropped[dropped.length - 1];
      onChange(last ? [last] : []);
      return;
    }
    const byName = new Map(files.map((f) => [f.name, f]));
    for (const f of dropped) byName.set(f.name, f);
    onChange(Array.from(byName.values()));
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    if (!disabled) add(e.dataTransfer.files);
  }

  return (
    <>
      <div
        className={`dropzone${over ? ' over' : ''}`}
        role="button"
        tabIndex={0}
        aria-label="Add input files"
        onClick={() => !disabled && input.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!disabled) input.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <input
          ref={input}
          type="file"
          accept={accept}
          multiple={multiple}
          data-testid={inputTestId}
          onChange={(e) => {
            add(e.target.files);
            e.target.value = '';
          }}
        />
        Drop input files here, or choose files
      </div>

      {files.length > 0 && (
        <ul className="files" data-testid={listTestId}>
          {files.map((f) => (
            <li key={f.name}>
              <span className="name">{f.name}</span>
              <span className="size">{formatSize(f.size)}</span>
              <button
                type="button"
                className="secondary"
                aria-label={`Remove ${f.name}`}
                onClick={() => onChange(files.filter((x) => x.name !== f.name))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}


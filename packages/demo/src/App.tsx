import type {
  EmbeddedImage,
  ExtractedImage,
  ProgressEvent,
  Table,
  TextPage,
} from '@pdfextract/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PdfSession, type Result, type SessionOptions } from './session';

// Extraction records are immutable; object identity keeps repeated equal spans distinct.
const recordKeys = new WeakMap<object, number>();
let recordSequence = 0;
function keyFor(record: object) {
  if (!recordKeys.has(record)) recordKeys.set(record, ++recordSequence);
  return recordKeys.get(record);
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = 'code' in error ? `${error.code}: ` : '';
    return `${code}${error.message}`;
  }
  return String(error);
}

function useDownloads() {
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const urls = pending.current;
    const clear = () => {
      for (const [url, timer] of urls) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      urls.clear();
    };
    window.addEventListener('pagehide', clear);
    return () => {
      window.removeEventListener('pagehide', clear);
      clear();
    };
  }, []);
  return (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    pending.current.set(
      url,
      setTimeout(() => {
        URL.revokeObjectURL(url);
        pending.current.delete(url);
      }, 1000),
    );
  };
}

export function App() {
  const session = useRef<PdfSession | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File>();
  const [result, setResult] = useState<Result>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Choose a PDF to get started.');
  const [progress, setProgress] = useState<ProgressEvent>();
  const [error, setError] = useState('');
  const [ocr, setOcr] = useState(false);
  const [ocrMode, setOcrMode] = useState<SessionOptions['ocrMode']>('auto');
  const [language, setLanguage] = useState('eng');
  const [password, setPassword] = useState('');
  const [minWidth, setMinWidth] = useState('');
  const [minHeight, setMinHeight] = useState('');
  const [tables, setTables] = useState(false);
  const [composite, setComposite] = useState(false);
  const [annotations, setAnnotations] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [view, setView] = useState<'text' | 'structure' | 'tables' | 'json'>('text');
  const download = useDownloads();

  useEffect(() => {
    const close = () => {
      const previous = session.current;
      session.current = null;
      void previous?.close().catch(console.error);
    };
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setFile(undefined);
        setResult(undefined);
        setBusy(false);
        setError('');
        setPassword('');
        setProgress(undefined);
        setStatus('Choose a PDF to get started.');
      }
    };
    window.addEventListener('pagehide', close);
    window.addEventListener('pageshow', restore);
    return () => {
      window.removeEventListener('pagehide', close);
      window.removeEventListener('pageshow', restore);
      close();
    };
  }, []);

  async function extract(
    nextFile: File,
    overrides: Partial<Pick<SessionOptions, 'ocr' | 'ocrMode'>> = {},
  ) {
    const previous = session.current;
    const next = new PdfSession(nextFile);
    session.current = next;
    setFile(nextFile);
    setResult(undefined);
    setPageIndex(0);
    setBusy(true);
    setError('');
    setProgress(undefined);
    setStatus('Opening PDF…');
    try {
      await previous?.close();
      if (session.current !== next) return;
      const output = await next.extract(
        {
          ocr,
          ocrMode,
          language,
          password,
          minWidth: pixels(minWidth),
          minHeight: pixels(minHeight),
          tables,
          composite,
          annotations,
          ...overrides,
        },
        (event) => {
          if (session.current !== next) return;
          setProgress(event);
          setStatus(
            `${{ open: 'Opening PDF', text: 'Reading text', images: 'Finding images', ocr: 'Recognizing text', export: 'Exporting image' }[event.stage]}…`,
          );
        },
      );
      if (session.current !== next) return;
      setResult(output);
      setStatus(
        output.text.status === 'partial' || output.imageWarnings.length
          ? 'Extraction finished with warnings.'
          : 'Extraction complete.',
      );
    } catch (cause) {
      if (session.current === next) {
        setError(describeError(cause));
        setStatus(
          next.controller.signal.aborted ? 'Extraction cancelled.' : 'Could not extract this PDF.',
        );
      }
      try {
        await next.close();
      } catch (cleanup) {
        if (session.current === next)
          setError(`${describeError(cause)} Cleanup: ${describeError(cleanup)}`);
      }
    } finally {
      if (session.current === next) setBusy(false);
    }
  }

  function reset(cancelled = false) {
    const previous = session.current;
    session.current = null;
    setBusy(false);
    setResult(undefined);
    setProgress(undefined);
    setError('');
    setStatus(
      cancelled ? 'Extraction cancelled. You can try again.' : 'Choose a PDF to get started.',
    );
    if (!cancelled) {
      setFile(undefined);
      setPassword('');
    }
    if (input.current) input.current.value = '';
    void previous?.close().catch((cause) => {
      if (!session.current) setError(describeError(cause));
    });
  }

  const page = result?.text.pages[pageIndex];
  // Text and image-list diagnostics share one panel.
  const warnings = result ? [...result.text.warnings, ...result.imageWarnings] : [];
  // The Tables view only exists for results extracted with table detection.
  const views = result?.tables
    ? (['text', 'structure', 'tables', 'json'] as const)
    : (['text', 'structure', 'json'] as const);
  const activeView = view === 'tables' && !result?.tables ? 'text' : view;
  return (
    <>
      <header className="topbar">
        <a className="brand" href={import.meta.env.BASE_URL}>
          pdfextract<span> / inspector</span>
        </a>
        <a href="https://github.com/tobilg/pdfextract">Source & docs</a>
      </header>
      <main>
        <section className="intro">
          <h1>See what’s inside your PDF.</h1>
          <p>Explore text, its structure, and the original embedded images.</p>
          <p className="privacy">
            Your PDF stays in this tab. Nothing is uploaded or saved by the demo.
          </p>
        </section>
        <section className="upload-panel" aria-label="PDF input">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (file) void extract(file);
            }}
          >
            <fieldset disabled={busy}>
              <legend className="sr-only">Extraction options</legend>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={ocr}
                  onChange={(event) => setOcr(event.target.checked)}
                />
                Recognize scanned text (OCR)
              </label>
              {ocr && (
                <label>
                  OCR coverage
                  <select
                    value={ocrMode}
                    onChange={(event) =>
                      setOcrMode(event.target.value as SessionOptions['ocrMode'])
                    }
                  >
                    <option value="auto">Embedded image regions</option>
                    <option value="always">Whole pages (including vector text)</option>
                  </select>
                </label>
              )}
              {ocr && (
                <label>
                  Language
                  <select value={language} onChange={(event) => setLanguage(event.target.value)}>
                    <option value="eng">English</option>
                    <option value="deu">German</option>
                  </select>
                </label>
              )}
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={tables}
                  onChange={(event) => setTables(event.target.checked)}
                />
                Detect tables
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={composite}
                  onChange={(event) => setComposite(event.target.checked)}
                />
                Show images with overlays (as on the page)
              </label>
              {composite && (
                <label className="checkbox nested">
                  <input
                    type="checkbox"
                    checked={annotations}
                    onChange={(event) => setAnnotations(event.target.checked)}
                  />
                  Include annotations
                </label>
              )}
              <fieldset className="size-filter">
                <legend>
                  Minimum image size <span className="muted">(optional, pixels)</span>
                </legend>
                <label>
                  <span className="sr-only">Minimum image width</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    value={minWidth}
                    placeholder="Width"
                    onChange={(event) => setMinWidth(event.target.value)}
                  />
                </label>
                <span aria-hidden="true">×</span>
                <label>
                  <span className="sr-only">Minimum image height</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    value={minHeight}
                    placeholder="Height"
                    onChange={(event) => setMinHeight(event.target.value)}
                  />
                </label>
              </fieldset>
              <label>
                Password <span className="muted">(optional)</span>
                <input
                  type="password"
                  value={password}
                  autoComplete="off"
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="For encrypted PDFs"
                />
              </label>
              {file && <button type="submit">Extract again</button>}
            </fieldset>
          </form>
          <label
            className={`drop-zone ${busy ? 'busy' : ''}`}
            htmlFor="pdf-file"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const dropped = event.dataTransfer.files[0];
              if (dropped && !busy) void extract(dropped);
            }}
          >
            <span className="file-mark" aria-hidden="true">
              PDF
            </span>
            <span>
              <strong>{file?.name ?? 'Choose a PDF or drop it here'}</strong>
              <small>
                {file
                  ? `${(file.size / 1024 / 1024).toFixed(2)} MiB · Choose another PDF`
                  : 'Whole PDF files · up to 64 MiB'}
              </small>
            </span>
            <input
              ref={input}
              id="pdf-file"
              type="file"
              accept="application/pdf,.pdf"
              disabled={busy}
              onChange={(event) => {
                const chosen = event.target.files?.[0];
                if (chosen) void extract(chosen);
                event.target.value = '';
              }}
            />
          </label>
          <div className="status-row">
            <div role="status" aria-live="polite">
              <span>{status}</span>
              {busy && progress && (
                <small>
                  {' '}
                  {progress.completed.toLocaleString()}
                  {progress.total ? ` / ${progress.total.toLocaleString()}` : ''} {progress.unit}
                </small>
              )}
            </div>
            {busy ? (
              <button type="button" onClick={() => reset(true)}>
                Cancel extraction
              </button>
            ) : (
              file && (
                <button type="button" onClick={() => reset()}>
                  Clear PDF
                </button>
              )
            )}
          </div>
          {busy && (
            <progress
              aria-label="Extraction progress"
              value={progress?.total ? progress.completed : undefined}
              max={progress?.total ?? 1}
            />
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>
        {result && page && session.current ? (
          <>
            <div className="result-summary">
              <strong>
                {result.text.pageCount} {result.text.pageCount === 1 ? 'page' : 'pages'}
              </strong>
              <span>
                {result.images.length} embedded {result.images.length === 1 ? 'image' : 'images'}
              </span>
              {result.ignoredImages > 0 && (
                <span>
                  {result.ignoredImages} smaller {result.ignoredImages === 1 ? 'image' : 'images'}{' '}
                  ignored
                </span>
              )}
              {result.tables && (
                <span>
                  {tableCount(result.text.pages)}{' '}
                  {tableCount(result.text.pages) === 1 ? 'table' : 'tables'}
                </span>
              )}
              <span>
                {result.text.pages
                  .reduce((count, entry) => count + entry.fullText.length, 0)
                  .toLocaleString()}{' '}
                text characters
              </span>
            </div>
            {result.images.length === 0 &&
              result.text.pages.every(
                (entry) =>
                  !entry.fullText.trim() && ['disabled', 'not-needed'].includes(entry.ocrStatus),
              ) && (
                <aside className="ocr-hint" aria-label="Whole-page OCR suggestion">
                  <h2>The PDF opened, but has no extractable text or embedded images.</h2>
                  <p>
                    Visible lettering may be drawn as vector shapes. Whole-page OCR can recognize
                    it, including in schematics and diagrams. Small labels and complex layouts may
                    be imperfect.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      if (!file) return;
                      setOcr(true);
                      setOcrMode('always');
                      void extract(file, { ocr: true, ocrMode: 'always' });
                    }}
                  >
                    Recognize whole pages
                  </button>
                </aside>
              )}
            {warnings.length > 0 && (
              <details className="warnings">
                <summary>{warnings.length} extraction warnings</summary>
                <ul>
                  {warnings.map((warning) => (
                    <li key={keyFor(warning)}>
                      {warning.pageNumber ? `Page ${warning.pageNumber}: ` : ''}
                      {warning.message} ({warning.code})
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="workspace">
              <section className="text-panel" aria-label="Extracted text">
                <div className="panel-heading">
                  <h2>Text & structure</h2>
                  <div className="actions">
                    <button
                      type="button"
                      onClick={() =>
                        download(
                          new Blob([JSON.stringify(result.text, null, 2)], {
                            type: 'application/json',
                          }),
                          'structured-text.json',
                        )
                      }
                    >
                      Download JSON
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        download(
                          new Blob([result.text.fullText], { type: 'text/plain;charset=utf-8' }),
                          'text.txt',
                        )
                      }
                    >
                      Download text
                    </button>
                  </div>
                </div>
                <div className="text-controls">
                  <label>
                    Page
                    <select
                      aria-label="Text page"
                      value={pageIndex}
                      onChange={(event) => setPageIndex(Number(event.target.value))}
                    >
                      {result.text.pages.map((entry, index) => (
                        <option key={entry.pageNumber} value={index}>
                          {entry.pageNumber}
                        </option>
                      ))}
                    </select>
                  </label>
                  <fieldset className="view-switch">
                    <legend className="sr-only">Text view</legend>
                    {views.map((option) => (
                      <button
                        key={option}
                        type="button"
                        aria-pressed={activeView === option}
                        onClick={() => setView(option)}
                      >
                        {
                          {
                            text: 'Reading',
                            structure: 'Structure',
                            tables: 'Tables',
                            json: 'Page JSON',
                          }[option]
                        }
                      </button>
                    ))}
                  </fieldset>
                </div>
                <p className="page-meta">
                  {page.width.toFixed(1)} × {page.height.toFixed(1)} pt · {page.blocks.length}{' '}
                  blocks
                  {result.tables
                    ? ` · ${page.tables.length} ${page.tables.length === 1 ? 'table' : 'tables'}`
                    : ''}{' '}
                  · OCR: {page.ocrStatus}
                </p>
                {activeView === 'json' ? (
                  <pre className="json-view" data-testid="page-json">
                    {JSON.stringify(page, null, 2)}
                  </pre>
                ) : activeView === 'structure' ? (
                  <Structure page={page} />
                ) : activeView === 'tables' ? (
                  <Tables page={page} />
                ) : (
                  <div className="reading" data-testid="reading">
                    {page.fullText ||
                      'No text was found on this page. Try OCR for scans, or whole-page OCR for lettering drawn as vector shapes.'}
                  </div>
                )}
              </section>
              <Images
                session={session.current}
                images={result.images}
                ignored={result.ignoredImages}
                composite={result.composite}
              />
            </div>
          </>
        ) : (
          <section className="empty-workspace" aria-label="Waiting for a PDF">
            <div>
              <h2>Text with context</h2>
              <p>
                Read the extracted text, inspect pages, blocks and spans, or download the structured
                JSON.
              </p>
            </div>
            <div>
              <h2>Images at their source size</h2>
              <p>
                Browse separate thumbnails and download the full PNG. Embedded scans, masks and
                repeated placements are included.
              </p>
            </div>
          </section>
        )}
      </main>
      <footer>
        Built with @pdfextract/core and @pdfextract/ocr. Results are cleared when you reload or
        close this tab. <a href="notices/README.txt">Third-party notices</a>
      </footer>
    </>
  );
}

function tableCount(pages: readonly TextPage[]) {
  return pages.reduce((count, entry) => count + entry.tables.length, 0);
}

function Tables({ page }: { page: TextPage }) {
  if (!page.tables.length)
    return (
      <p className="reading">
        No tables were detected on this page. Detection needs ruling lines or at least three aligned
        text columns.
      </p>
    );
  return (
    <div className="tables" data-testid="tables">
      {page.tables.map((table, index) => (
        <TableView key={keyFor(table)} table={table} index={index} />
      ))}
    </div>
  );
}

function TableView({ table, index }: { table: Table; index: number }) {
  // Stable row objects keep row keys stable, even for rows fully covered by a row span.
  const rows = useMemo(
    () =>
      Array.from({ length: table.rowCount }, (_, row) => ({
        cells: table.cells.filter((cell) => cell.row === row),
      })),
    [table],
  );
  return (
    <figure>
      <figcaption>
        Table {index + 1} · {table.rowCount} × {table.columnCount} ·{' '}
        {table.detection === 'ruled' ? 'ruling lines' : 'aligned columns'}
      </figcaption>
      <div className="table-scroll">
        <table>
          <tbody>
            {rows.map((row) => (
              <tr key={keyFor(row)}>
                {row.cells.map((cell) => (
                  <td key={keyFor(cell)} rowSpan={cell.rowSpan} colSpan={cell.columnSpan}>
                    {cell.text}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

function Structure({ page }: { page: TextPage }) {
  if (!page.blocks.length)
    return <p className="reading">No text blocks on this page. Try OCR for scanned text.</p>;
  return (
    <div className="structure">
      {page.blocks.map((block, index) => (
        <details key={keyFor(block)}>
          <summary>
            Block {index + 1}
            {block.tableIndex !== undefined ? ` (table ${block.tableIndex + 1})` : ''}
            <span className="structure-summary">
              {block.lines.length} lines · {block.text.slice(0, 70)}
            </span>
          </summary>
          {block.lines.map((line, lineIndex) => (
            <div className="line" key={keyFor(line)}>
              <strong>Line {lineIndex + 1}</strong>
              {line.spans.map((span) => (
                <div className="span" key={keyFor(span)}>
                  <p>{span.text}</p>
                  <small>
                    <b>{span.source}</b> · x {span.bbox.x.toFixed(1)}, y {span.bbox.y.toFixed(1)}, w{' '}
                    {span.bbox.width.toFixed(1)}, h {span.bbox.height.toFixed(1)} pt
                    {span.confidence !== undefined
                      ? ` · confidence ${Math.round(span.confidence * 100)}%`
                      : ''}
                  </small>
                </div>
              ))}
            </div>
          ))}
        </details>
      ))}
    </div>
  );
}

const PAGE_SIZE = 8;
/** A positive whole number of pixels from a size input; anything else means no filter. */
function pixels(value: string) {
  const number = Number(value);
  return value.trim() && Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/** Size and orientation as shown on the page; exports correct the first placement's orientation. */
function displayed(image: EmbeddedImage) {
  const orientation = image.occurrences[0]?.originalOrientation;
  const quarterTurn = orientation?.rotation === 90 || orientation?.rotation === 270;
  return {
    width: quarterTurn ? image.height : image.width,
    height: quarterTurn ? image.width : image.height,
    corrected: !!orientation && (orientation.rotation !== 0 || orientation.mirrored),
  };
}

function Images({
  session,
  images,
  ignored,
  composite,
}: {
  session: PdfSession;
  images: readonly EmbeddedImage[];
  ignored: number;
  composite: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const visible = useMemo(() => images.slice(offset, offset + PAGE_SIZE), [images, offset]);
  // Remount the gallery when the document changes, including its current-page URLs.
  return (
    <section className="images-panel" aria-label="Embedded images">
      <div className="panel-heading">
        <h2>
          Embedded images <span className="count">{images.length}</span>
        </h2>
      </div>
      <p className="muted">
        Thumbnails for browsing. Downloads keep full resolution, oriented as on the page.
        {composite
          ? ' Images with overlays include the text, shapes and images drawn above them.'
          : ''}
      </p>
      {images.length ? (
        <>
          <ThumbnailPage
            key={`${images[0].id}-${offset}`}
            session={session}
            images={visible}
            offset={offset}
          />
          <div className="pagination">
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => setOffset(offset - PAGE_SIZE)}
            >
              Previous images
            </button>
            <span>
              {offset + 1} to {Math.min(offset + PAGE_SIZE, images.length)} of {images.length}
            </span>
            <button
              type="button"
              disabled={offset + PAGE_SIZE >= images.length}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next images
            </button>
          </div>
        </>
      ) : ignored ? (
        <p className="empty-message">
          All {ignored} embedded {ignored === 1 ? 'image is' : 'images are'} smaller than the
          minimum image size.
        </p>
      ) : (
        <p className="empty-message">
          This PDF has no embedded raster images. Vector artwork and page screenshots are not listed
          as images.
        </p>
      )}
    </section>
  );
}

function ThumbnailPage({
  session,
  images,
  offset,
}: {
  session: PdfSession;
  images: readonly EmbeddedImage[];
  offset: number;
}) {
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [composited, setComposited] = useState<Record<string, ExtractedImage['composited']>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [exporting, setExporting] = useState('');
  const [message, setMessage] = useState('');
  const operation = useRef<AbortController | null>(null);
  const download = useDownloads();
  useEffect(() => {
    const controller = new AbortController();
    const urls: string[] = [];
    void (async () => {
      for (const image of images) {
        try {
          const preview = await session.image(image.id, true, controller.signal);
          if (controller.signal.aborted) break;
          const url = URL.createObjectURL(new Blob([preview.data], { type: preview.mimeType }));
          urls.push(url);
          setPreviews((previous) => ({ ...previous, [image.id]: url }));
          setComposited((previous) => ({ ...previous, [image.id]: preview.composited }));
        } catch (cause) {
          if (controller.signal.aborted) break;
          setErrors((previous) => ({ ...previous, [image.id]: describeError(cause) }));
        }
      }
    })();
    const clear = () => {
      controller.abort();
      operation.current?.abort();
      for (const url of urls) URL.revokeObjectURL(url);
    };
    window.addEventListener('pagehide', clear);
    return () => {
      window.removeEventListener('pagehide', clear);
      clear();
    };
    // The keyed page owns this stable slice; a new document/page remounts it.
  }, [session, images]);

  async function exportImage(image: EmbeddedImage, index: number) {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setExporting(image.id);
    setMessage('Exporting full-size PNG…');
    try {
      const full: ExtractedImage = await session.image(image.id, false, controller.signal);
      if (controller.signal.aborted) return;
      download(
        new Blob([full.data], { type: full.mimeType }),
        `image-${index + 1}-${full.width}x${full.height}${full.composited === 'none' ? '' : '-composite'}.png`,
      );
      setMessage(`Downloaded image ${index + 1} at ${full.width} × ${full.height} pixels.`);
    } catch (cause) {
      if (!controller.signal.aborted) setMessage(describeError(cause));
    } finally {
      if (!controller.signal.aborted) setExporting('');
      if (operation.current === controller) operation.current = null;
    }
  }
  return (
    <>
      <div className="image-grid">
        {images.map((image, index) => (
          <article className="image-card" key={image.id}>
            <div className="image-preview">
              {previews[image.id] ? (
                <img
                  src={previews[image.id]}
                  alt={`Embedded raster ${offset + index + 1}`}
                  width={displayed(image).width}
                  height={displayed(image).height}
                />
              ) : (
                <span>{errors[image.id] ? 'Preview unavailable' : 'Preparing thumbnail…'}</span>
              )}
            </div>
            <div className="image-info">
              <h3>Image {offset + index + 1}</h3>
              <strong>
                {displayed(image).width} × {displayed(image).height} px
              </strong>
              <p>
                Page
                {new Set(image.occurrences.map((occurrence) => occurrence.pageNumber)).size === 1
                  ? ''
                  : 's'}{' '}
                {[...new Set(image.occurrences.map((occurrence) => occurrence.pageNumber))].join(
                  ', ',
                )}{' '}
                · {image.occurrences.length}{' '}
                {image.occurrences.length === 1 ? 'placement' : 'placements'}
                {image.hasAlpha ? ' · alpha' : ''}
                {displayed(image).corrected ? ' · orientation corrected' : ''}
                {image.occurrences[0]?.overlaid ? ' · overlaid' : ''}
                {image.occurrences[0]?.clipped ? ' · clipped' : ''}
              </p>
              {composited[image.id] && composited[image.id] !== 'none' && (
                <p className="badge">
                  {composited[image.id] === 'above'
                    ? 'Composite: with content drawn above'
                    : 'Composite: whole area, including content below'}
                </p>
              )}
              <details>
                <summary>Placement details</summary>
                <pre>{JSON.stringify(image.occurrences, null, 2)}</pre>
              </details>
              {image.warnings.map((warning) => (
                <p className="error" key={keyFor(warning)}>
                  {warning.message}
                </p>
              ))}
              {errors[image.id] && <p className="error">{errors[image.id]}</p>}
              <button
                type="button"
                disabled={!!exporting}
                onClick={() => void exportImage(image, offset + index)}
              >
                {exporting === image.id ? 'Exporting…' : 'Download full PNG'}
              </button>
            </div>
          </article>
        ))}
      </div>
      <div className="export-status" role="status">
        {message}
      </div>
      {exporting && (
        <button
          type="button"
          onClick={() => {
            operation.current?.abort();
            operation.current = null;
            setExporting('');
            setMessage('Image export cancelled.');
          }}
        >
          Cancel image export
        </button>
      )}
    </>
  );
}

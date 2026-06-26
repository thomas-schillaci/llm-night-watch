import { panelLabels, resultPanelContent, stringify } from "../extractionUtils";
import { ExtractionParams, ExtractionResult, PanelKey } from "../types";
import { cn } from "../lib/utils";
import { FileText } from "lucide-react";

function JsonPanel({ result, active }: { result: ExtractionResult | null; active: PanelKey }) {
  if (!result) return <pre className="panel-pre text-muted-foreground">Run extraction to inspect this payload.</pre>;
  return <pre className="panel-pre">{resultPanelContent(result, active)}</pre>;
}

export function PdfViewer({ pdfUrl }: { pdfUrl: string }) {
  return (
    <div className="viewer min-h-[680px]">
      <div className="viewer-title"><FileText className="h-4 w-4" />PDF</div>
      {pdfUrl ? <iframe className="h-full w-full" src={pdfUrl} title="PDF preview" /> : <div className="empty-state">Upload a PDF to preview it.</div>}
    </div>
  );
}

export function ExtractionRunSection({
  title,
  params,
  result,
  durationMs,
  activePanel,
  onPanelChange,
  onParamsChange,
}: {
  title: string;
  params: ExtractionParams;
  result: ExtractionResult | null;
  durationMs: number | null;
  activePanel: PanelKey;
  onPanelChange: (next: PanelKey) => void;
  onParamsChange: (next: ExtractionParams) => void;
}) {
  return (
    <section className="rounded-md border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
        <div>
          <h2 className="text-sm font-medium">{title}</h2>
        </div>
        <div className="segmented">
          {(Object.keys(panelLabels) as PanelKey[]).map((key) => (
            <button key={key} className={cn("segmented-button", activePanel === key && "segmented-button-active")} type="button" onClick={() => onPanelChange(key)}>{panelLabels[key]}</button>
          ))}
        </div>
      </div>

      <div className="grid gap-2 border-b bg-muted/25 p-3 text-xs sm:grid-cols-3">
        <label className="grid gap-1 rounded-md border bg-background px-3 py-2">
          <span className="text-muted-foreground">dpi</span>
          <input
            className="h-7 w-full bg-transparent font-mono text-sm font-semibold text-foreground outline-none focus:ring-0"
            type="number"
            min={50}
            max={400}
            step={1}
            value={params.dpi}
            onChange={(event) => onParamsChange({ ...params, dpi: Number(event.target.value) })}
          />
        </label>
        <label className="grid gap-1 rounded-md border bg-background px-3 py-2">
          <span className="text-muted-foreground">first_n_pages</span>
          <input
            className="h-7 w-full bg-transparent font-mono text-sm font-semibold text-foreground outline-none focus:ring-0"
            type="number"
            min={1}
            max={10}
            step={1}
            value={params.first_n_pages}
            onChange={(event) => onParamsChange({ ...params, first_n_pages: Number(event.target.value) })}
          />
        </label>
        <div className="rounded-md border bg-background px-3 py-2">
          <div className="text-muted-foreground">processing_time</div>
          <div className="font-mono text-sm font-semibold text-foreground">{durationMs == null ? "-" : `${(durationMs / 1000).toFixed(2)}s`}</div>
        </div>
      </div>

      {result ? (
        <div className="grid gap-0 xl:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.2fr)]">
          <div className="processed-wrap min-h-0 border-b xl:border-b-0 xl:border-r">
            <img src={result.processed_image.data_url} alt={`${result.dpi} DPI processed pages`} />
            <div className="image-meta">{result.processed_image.width} x {result.processed_image.height} · {result.first_n_pages} page{result.first_n_pages === 1 ? "" : "s"} · JPEG quality 80</div>
          </div>
          <div className="min-w-0">
            <JsonPanel result={result} active={activePanel} />
            {result.validation_errors?.length ? (
              <div className="border-t bg-amber-50 p-3">
                <div className="mb-2 text-sm font-medium text-amber-950">Validation errors</div>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-amber-950">{stringify(result.validation_errors)}</pre>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="grid gap-0 xl:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.2fr)]">
          <div className="empty-state min-h-72 border-b xl:border-b-0 xl:border-r">Processed JPEG appears after this extraction.</div>
          <JsonPanel result={null} active={activePanel} />
        </div>
      )}
    </section>
  );
}

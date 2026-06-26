import { ChangeEvent, DragEvent, FormEvent, useMemo, useState } from "react";
import { Loader2, Send, Upload } from "lucide-react";
import { extract } from "../api";
import {
  buildResponseFormat,
  defaultPrompt,
  defaultSchemaFields,
  fastExtractionParams,
  fieldNamesFromResponseFormat,
  rawResponseFormatErrors,
  renderPromptTemplate,
  schemaFieldErrors,
  schemaFieldsFromResponseFormat,
  slowExtractionParams,
  stringify,
} from "../extractionUtils";
import { ExtractionParams, ExtractionResult, PanelKey, ResponseFormatMode, SchemaField } from "../types";
import { Button } from "./ui/button";
import { ResponseFormatBuilder } from "./ResponseFormatBuilder";
import { ExtractionRunSection, PdfViewer } from "./ExtractionRunSection";

export function ManualRequestTab() {
  const [file, setFile] = useState<File | null>(null);
  const [pdfUrl, setPdfUrl] = useState("");
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [schemaFields, setSchemaFields] = useState<SchemaField[]>(defaultSchemaFields);
  const [responseFormatMode, setResponseFormatMode] = useState<ResponseFormatMode>("fields");
  const [rawResponseFormat, setRawResponseFormat] = useState(() => stringify(buildResponseFormat(defaultSchemaFields)));
  const [latestValidSchemaFields, setLatestValidSchemaFields] = useState<SchemaField[]>(defaultSchemaFields);
  const [latestValidRawResponseFormat, setLatestValidRawResponseFormat] = useState(() => stringify(buildResponseFormat(defaultSchemaFields)));
  const [fastParams, setFastParams] = useState<ExtractionParams>(fastExtractionParams);
  const [slowParams, setSlowParams] = useState<ExtractionParams>(slowExtractionParams);
  const [result100, setResult100] = useState<ExtractionResult | null>(null);
  const [result200, setResult200] = useState<ExtractionResult | null>(null);
  const [fastDurationMs, setFastDurationMs] = useState<number | null>(null);
  const [slowDurationMs, setSlowDurationMs] = useState<number | null>(null);
  const [fastPanel, setFastPanel] = useState<PanelKey>("json");
  const [slowPanel, setSlowPanel] = useState<PanelKey>("json");
  const [status, setStatus] = useState<"idle" | "running100" | "running200" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [showResponseFormatErrors, setShowResponseFormatErrors] = useState(false);

  const generatedResponseFormat = useMemo(() => stringify(buildResponseFormat(schemaFields)), [schemaFields]);
  const schemaErrors = useMemo(() => schemaFieldErrors(schemaFields), [schemaFields]);
  const rawErrors = useMemo(() => rawResponseFormatErrors(rawResponseFormat), [rawResponseFormat]);
  const responseFormatErrors = responseFormatMode === "fields" ? schemaErrors : rawErrors;
  const responseFormat = responseFormatMode === "fields" ? generatedResponseFormat : rawResponseFormat;
  const visibleResponseFormatErrors = showResponseFormatErrors ? responseFormatErrors : [];
  const promptFieldNames = useMemo(
    () => (responseFormatMode === "fields" ? schemaFields.map((field) => field.name.trim()).filter(Boolean) : fieldNamesFromResponseFormat(rawResponseFormat)),
    [rawResponseFormat, responseFormatMode, schemaFields],
  );

  const setFieldsAndSyncRaw = (nextFields: SchemaField[]) => {
    const nextRaw = stringify(buildResponseFormat(nextFields));
    setSchemaFields(nextFields);
    setRawResponseFormat(nextRaw);
    setLatestValidSchemaFields(nextFields);
    setLatestValidRawResponseFormat(nextRaw);
    setShowResponseFormatErrors(false);
  };

  const setRawAndSyncFields = (nextRaw: string) => {
    setRawResponseFormat(nextRaw);
    const nextFields = schemaFieldsFromResponseFormat(nextRaw);
    if (!nextFields) return;
    setSchemaFields(nextFields);
    setLatestValidSchemaFields(nextFields);
    setLatestValidRawResponseFormat(nextRaw);
    setShowResponseFormatErrors(false);
  };

  const setResponseFormatModeSafely = (nextMode: ResponseFormatMode) => {
    if (nextMode === "fields" && rawResponseFormatErrors(rawResponseFormat).length > 0) {
      setRawResponseFormat(latestValidRawResponseFormat);
      setSchemaFields(latestValidSchemaFields);
      setShowResponseFormatErrors(false);
    }
    setResponseFormatMode(nextMode);
  };

  const selectPdf = (next: File | null) => {
    if (next && next.type && next.type !== "application/pdf") {
      setError("Upload a PDF");
      return;
    }

    setFile(next);
    setPdfUrl(next ? URL.createObjectURL(next) : "");
    setResult100(null);
    setResult200(null);
    setFastDurationMs(null);
    setSlowDurationMs(null);
    setError("");
    setStatus("idle");
    setShowResponseFormatErrors(false);
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    selectPdf(event.target.files?.[0] ?? null);
  };

  const onDragEnter = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer.types.includes("Files")) setDragActive(true);
  };

  const onDragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer.types.includes("Files")) setDragActive(true);
  };

  const onDragLeave = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget === event.target) setDragActive(false);
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    const droppedPdf = Array.from(event.dataTransfer.files).find((droppedFile) => droppedFile.type === "application/pdf" || droppedFile.name.toLowerCase().endsWith(".pdf"));
    if (!droppedPdf) {
      setError("Drop a PDF file");
      return;
    }
    selectPdf(droppedPdf);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;
    if (responseFormatErrors.length > 0) {
      setShowResponseFormatErrors(true);
      return;
    }
    setShowResponseFormatErrors(false);
    setError("");
    setResult100(null);
    setResult200(null);
    setFastDurationMs(null);
    setSlowDurationMs(null);
    try {
      JSON.parse(responseFormat);
      setStatus("running100");
      const renderedPrompt = renderPromptTemplate(prompt, promptFieldNames);
      const fastStartedAt = performance.now();
      const first = await extract(file, fastParams, renderedPrompt, responseFormat);
      setFastDurationMs(performance.now() - fastStartedAt);
      setResult100(first);
      setStatus("running200");
      const slowStartedAt = performance.now();
      const second = await extract(file, slowParams, renderedPrompt, responseFormat);
      setSlowDurationMs(performance.now() - slowStartedAt);
      setResult200(second);
      setStatus("done");
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "Extraction failed");
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      className="relative min-h-[calc(100vh-132px)] w-full"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragActive ? (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center border-4 border-primary bg-background/85 text-lg font-medium text-primary shadow-inner">
          Drop PDF to upload
        </div>
      ) : null}

      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-5 px-5 py-5">
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-card p-3">
          <div>
            <h2 className="text-sm font-medium">Manual request</h2>
            <p className="text-xs text-muted-foreground">Upload a PDF and compare extraction settings.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent">
              <Upload className="h-4 w-4" />
              <span>{file ? file.name : "Upload PDF"}</span>
              <input className="sr-only" type="file" accept="application/pdf" onChange={onFileChange} />
            </label>
            <Button type="submit" disabled={!file || !prompt.trim() || status === "running100" || status === "running200"}>
              {status === "running100" || status === "running200" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {status === "running100" ? "Sending 100 DPI" : status === "running200" ? "Sending 200 DPI" : "Send"}
            </Button>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <label className="grid gap-3 rounded-md border bg-card p-3 text-sm">
            <span>
              <span className="block font-medium">Prompt</span>
              <span className="block text-xs text-muted-foreground">Use <code className="rounded border bg-background px-1 py-0.5 font-mono text-[11px]">{"{{fields}}"}</code> to insert a comma-separated list of response field names.</span>
            </span>
            <textarea className="min-h-40 resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-5 outline-none focus:ring-2 focus:ring-ring" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </label>
          <ResponseFormatBuilder fields={schemaFields} onChange={setFieldsAndSyncRaw} mode={responseFormatMode} onModeChange={setResponseFormatModeSafely} rawResponseFormat={rawResponseFormat} onRawResponseFormatChange={setRawAndSyncFields} errors={visibleResponseFormatErrors} />
        </section>

        {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}
        {[result100, result200].map((result) =>
          result?.status === "validation_failed" ? (
            <div key={result.dpi} className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {result.dpi} DPI: {result.validation_message || "One or more extracted fields could not be validated."}
            </div>
          ) : null,
        )}

        <section className="grid gap-4 xl:grid-cols-[minmax(420px,0.9fr)_minmax(0,1.1fr)]">
          <PdfViewer pdfUrl={pdfUrl} />

          <div className="flex min-w-0 flex-col gap-4">
            <ExtractionRunSection title="Fast extraction" params={fastParams} result={result100} durationMs={fastDurationMs} activePanel={fastPanel} onPanelChange={setFastPanel} onParamsChange={setFastParams} />
            <ExtractionRunSection title="Slow extraction" params={slowParams} result={result200} durationMs={slowDurationMs} activePanel={slowPanel} onPanelChange={setSlowPanel} onParamsChange={setSlowParams} />
          </div>
        </section>
      </div>
    </form>
  );
}

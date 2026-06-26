import { ChangeEvent, DragEvent, FormEvent, useEffect, useMemo, useState } from "react";
import { FileText, Loader2, Plus, Send, Trash2, Upload } from "lucide-react";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";

type SchemaFieldType = "string" | "number" | "integer" | "boolean" | "string_array";
type SchemaField = { id: number; name: string; type: SchemaFieldType };

type ExtractionResult = {
  dpi: number;
  first_n_pages: number;
  prompt: { text: string };
  processed_image: { dpi: number; first_n_pages: number; mime_type: string; width: number; height: number; base64: string; data_url: string };
  request: Record<string, unknown>;
  raw_response: Record<string, unknown>;
  extracted: Record<string, unknown>;
  status?: "ok" | "validation_failed";
  validation_message?: string;
  validation_errors?: Array<Record<string, unknown>>;
};

type PanelKey = "prompt" | "request" | "raw" | "json";
type ResponseFormatMode = "fields" | "raw";
type ExtractionParams = { dpi: number; first_n_pages: number };

type VllmMetrics = {
  num_requests_running: number | null;
  num_requests_waiting: number | null;
  available: boolean;
  error: string;
};

const defaultPrompt = "Extract these fields: {{fields}}. If a value is not present, use an empty string. Return only JSON.";
const fastExtractionParams: ExtractionParams = { dpi: 100, first_n_pages: 1 };
const slowExtractionParams: ExtractionParams = { dpi: 200, first_n_pages: 1 };

const fieldTypeLabels: Record<SchemaFieldType, string> = {
  string: "Text",
  number: "Number",
  integer: "Integer",
  boolean: "True/false",
  string_array: "Text list",
};

const defaultSchemaFields: SchemaField[] = [{ id: 1, name: "value", type: "string" }];

const panelLabels: Record<PanelKey, string> = {
  prompt: "Prompt",
  request: "Request",
  raw: "Raw response",
  json: "JSON",
};

function stringify(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function schemaForFieldType(type: SchemaFieldType): Record<string, unknown> {
  if (type === "string_array") return { type: "array", items: { type: "string" } };
  return { type };
}

function buildResponseFormat(fields: SchemaField[]) {
  const properties = Object.fromEntries(fields.map((field) => [field.name.trim(), schemaForFieldType(field.type)]));
  return {
    type: "json_schema",
    json_schema: {
      name: "ExtractionResult",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties,
        required: fields.map((field) => field.name.trim()),
      },
    },
  };
}

function propertiesFromResponseFormat(responseFormat: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(responseFormat) as { json_schema?: { schema?: { properties?: unknown } } };
    const properties = parsed.json_schema?.schema?.properties;
    return properties && typeof properties === "object" && !Array.isArray(properties) ? (properties as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function fieldTypeFromSchema(schema: unknown): SchemaFieldType {
  if (!schema || typeof schema !== "object") return "string";
  const fieldSchema = schema as { type?: unknown; items?: { type?: unknown } };
  if (fieldSchema.type === "array" && fieldSchema.items?.type === "string") return "string_array";
  if (fieldSchema.type === "number" || fieldSchema.type === "integer" || fieldSchema.type === "boolean") return fieldSchema.type;
  return "string";
}

function schemaFieldsFromResponseFormat(responseFormat: string): SchemaField[] | null {
  const properties = propertiesFromResponseFormat(responseFormat);
  if (!properties) return null;
  return Object.entries(properties).map(([name, schema], index) => ({ id: index + 1, name, type: fieldTypeFromSchema(schema) }));
}

function fieldNamesFromResponseFormat(responseFormat: string): string[] {
  return Object.keys(propertiesFromResponseFormat(responseFormat) ?? {});
}

function renderPromptTemplate(prompt: string, fieldNames: string[]) {
  return prompt.split("{{fields}}").join(fieldNames.join(", "));
}

function schemaFieldErrors(fields: SchemaField[]): string[] {
  const errors: string[] = [];
  const names = fields.map((field) => field.name.trim()).filter(Boolean);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);

  if (fields.some((field) => !field.name.trim())) errors.push("Every field needs a name.");
  if (duplicates.length > 0) errors.push(`Duplicate field name: ${duplicates[0]}.`);
  return errors;
}

function rawResponseFormatErrors(responseFormat: string): string[] {
  if (!responseFormat.trim()) return ["Response format cannot be empty."];
  try {
    const parsed = JSON.parse(responseFormat);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? [] : ["Response format must be a JSON object."];
  } catch (caught) {
    return [caught instanceof Error ? caught.message : "Response format must be valid JSON."];
  }
}

function errorMessageFromPayload(payload: unknown): string {
  if (payload && typeof payload === "object" && "detail" in payload) {
    const detail = (payload as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object" && "message" in detail) return String((detail as { message: unknown }).message);
    return stringify(detail);
  }
  return typeof payload === "string" ? payload : stringify(payload);
}

async function extract(file: File, params: ExtractionParams, prompt: string, responseFormat: string): Promise<ExtractionResult> {
  const body = new FormData();
  body.append("file", file);
  body.append("dpi", String(params.dpi));
  body.append("first_n_pages", String(params.first_n_pages));
  body.append("prompt", prompt);
  body.append("response_format", responseFormat);
  const response = await fetch("/api/extract", { method: "POST", body });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    throw new Error(errorMessageFromPayload(payload));
  }

  return payload as ExtractionResult;
}

async function fetchVllmMetrics(): Promise<VllmMetrics> {
  const response = await fetch("/api/vllm-metrics");
  if (!response.ok) throw new Error(`Metrics request failed: ${response.status}`);
  return (await response.json()) as VllmMetrics;
}

function metricText(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "-";
}

function VllmMetricsDisplay({ metrics }: { metrics: VllmMetrics | null }) {
  const available = metrics?.available !== false;
  return (
    <div
      className="inline-flex h-10 items-center overflow-hidden rounded-md border bg-card text-xs shadow-sm"
      title={available ? "vLLM live request metrics" : metrics?.error || "vLLM metrics unavailable"}
    >
      <div className="flex h-full items-center border-r bg-muted/50 px-3 font-medium text-foreground">vLLM</div>
      <div className="flex h-full items-center gap-3 px-3">
        <span className="inline-flex items-baseline gap-1.5">
          <span className="text-muted-foreground">Running</span>
          <span className="min-w-4 text-right font-mono text-sm font-semibold text-foreground">{available ? metricText(metrics?.num_requests_running) : "-"}</span>
        </span>
        <span className="h-4 w-px bg-border" />
        <span className="inline-flex items-baseline gap-1.5">
          <span className="text-muted-foreground">Waiting</span>
          <span className="min-w-4 text-right font-mono text-sm font-semibold text-foreground">{available ? metricText(metrics?.num_requests_waiting) : "-"}</span>
        </span>
      </div>
    </div>
  );
}

function ResponseFormatBuilder({
  fields,
  onChange,
  generatedResponseFormat,
  mode,
  onModeChange,
  rawResponseFormat,
  onRawResponseFormatChange,
  errors,
}: {
  fields: SchemaField[];
  onChange: (next: SchemaField[]) => void;
  generatedResponseFormat: string;
  mode: ResponseFormatMode;
  onModeChange: (next: ResponseFormatMode) => void;
  rawResponseFormat: string;
  onRawResponseFormatChange: (next: string) => void;
  errors: string[];
}) {
  const updateField = (id: number, patch: Partial<SchemaField>) => {
    onChange(fields.map((field) => (field.id === id ? { ...field, ...patch } : field)));
  };

  const addField = () => {
    const nextId = Math.max(0, ...fields.map((field) => field.id)) + 1;
    onChange([...fields, { id: nextId, name: "", type: "string" }]);
  };

  const removeField = (id: number) => {
    onChange(fields.length === 1 ? [{ ...fields[0], name: "", type: "string" }] : fields.filter((field) => field.id !== id));
  };

  return (
    <section className="grid gap-3 rounded-md border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-medium">Response format</h2>
          <p className="text-xs text-muted-foreground">Build fields or paste a complete JSON schema.</p>
        </div>
        <div className="segmented">
          <button className={cn("segmented-button", mode === "fields" && "segmented-button-active")} type="button" onClick={() => onModeChange("fields")}>Fields</button>
          <button className={cn("segmented-button", mode === "raw" && "segmented-button-active")} type="button" onClick={() => onModeChange("raw")}>Raw JSON</button>
        </div>
      </div>

      {mode === "fields" ? (
        <>
          <div className="grid gap-2">
            {fields.map((field) => (
              <div key={field.id} className="grid gap-2 rounded-md border bg-background p-2 sm:grid-cols-[minmax(0,1fr)_160px_40px]">
                <label className="grid gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Name</span>
                  <input
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                    value={field.name}
                    placeholder="field_name"
                    spellCheck={false}
                    onChange={(event) => updateField(field.id, { name: event.target.value })}
                  />
                </label>
                <label className="grid gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Type</span>
                  <select
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                    value={field.type}
                    onChange={(event) => updateField(field.id, { type: event.target.value as SchemaFieldType })}
                  >
                    {(Object.keys(fieldTypeLabels) as SchemaFieldType[]).map((type) => (
                      <option key={type} value={type}>
                        {fieldTypeLabels[type]}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="grid gap-1.5">
                  <span className="invisible text-xs font-medium">Remove</span>
                  <Button type="button" variant="outline" size="icon" title="Remove field" aria-label="Remove field" onClick={() => removeField(field.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <div className="flex justify-end">
            <Button type="button" size="sm" onClick={addField}>
              <Plus className="h-4 w-4" />
              Field
            </Button>
          </div>
        </>
      ) : (
        <label className="grid gap-2">
          <span className="text-xs font-medium text-muted-foreground">JSON schema</span>
          <textarea
            className="min-h-72 resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-5 outline-none focus:ring-2 focus:ring-ring"
            value={rawResponseFormat}
            onChange={(event) => onRawResponseFormatChange(event.target.value)}
            spellCheck={false}
          />
        </label>
      )}

      {errors.length ? <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{errors[0]}</div> : null}
    </section>
  );
}

function JsonPanel({ result, active }: { result: ExtractionResult | null; active: PanelKey }) {
  if (!result) return <pre className="panel-pre text-muted-foreground">Run extraction to inspect this payload.</pre>;
  const content = active === "prompt" ? result.prompt.text : active === "request" ? stringify(result.request) : active === "raw" ? stringify(result.raw_response) : stringify(result.extracted);
  return <pre className="panel-pre">{content}</pre>;
}

function ExtractionRunSection({
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

export function App() {
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
  const [vllmMetrics, setVllmMetrics] = useState<VllmMetrics | null>(null);

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

  useEffect(() => {
    let active = true;

    const refreshMetrics = async () => {
      try {
        const nextMetrics = await fetchVllmMetrics();
        if (active) setVllmMetrics(nextMetrics);
      } catch (caught) {
        if (active) setVllmMetrics({ num_requests_running: null, num_requests_waiting: null, available: false, error: caught instanceof Error ? caught.message : "Metrics unavailable" });
      }
    };

    void refreshMetrics();
    const intervalId = window.setInterval(refreshMetrics, 1000);
    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

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
    <main className="relative min-h-screen bg-background text-foreground" onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      {dragActive ? (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center border-4 border-primary bg-background/85 text-lg font-medium text-primary shadow-inner">
          Drop PDF to upload
        </div>
      ) : null}
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-5 px-5 py-5">
        <header className="flex flex-col gap-3 border-b pb-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-normal">LLM Night Watch</h1>
            <p className="text-sm text-muted-foreground">Document extraction review</p>
          </div>
          <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
            <VllmMetricsDisplay metrics={vllmMetrics} />
            <label className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent">
              <Upload className="h-4 w-4" />
              <span>{file ? file.name : "Upload PDF"}</span>
              <input className="sr-only" type="file" accept="application/pdf" onChange={onFileChange} />
            </label>
            <Button type="submit" disabled={!file || !prompt.trim() || status === "running100" || status === "running200"}>
              {status === "running100" || status === "running200" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {status === "running100" ? "Sending 100 DPI" : status === "running200" ? "Sending 200 DPI" : "Send"}
            </Button>
          </form>
        </header>

        <section className="grid gap-4 lg:grid-cols-2">
          <label className="grid gap-3 rounded-md border bg-card p-3 text-sm">
            <span>
              <span className="block font-medium">Prompt</span>
              <span className="block text-xs text-muted-foreground">Use <code className="rounded border bg-background px-1 py-0.5 font-mono text-[11px]">{"{{fields}}"}</code> to insert a comma-separated list of response field names.</span>
            </span>
            <textarea className="min-h-40 resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-5 outline-none focus:ring-2 focus:ring-ring" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </label>
          <ResponseFormatBuilder fields={schemaFields} onChange={setFieldsAndSyncRaw} generatedResponseFormat={generatedResponseFormat} mode={responseFormatMode} onModeChange={setResponseFormatModeSafely} rawResponseFormat={rawResponseFormat} onRawResponseFormatChange={setRawAndSyncFields} errors={visibleResponseFormatErrors} />
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
          <div className="viewer min-h-[680px]">
            <div className="viewer-title"><FileText className="h-4 w-4" />PDF</div>
            {pdfUrl ? <iframe className="h-full w-full" src={pdfUrl} title="PDF preview" /> : <div className="empty-state">Upload a PDF to preview it.</div>}
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <ExtractionRunSection title="Fast extraction" params={fastParams} result={result100} durationMs={fastDurationMs} activePanel={fastPanel} onPanelChange={setFastPanel} onParamsChange={setFastParams} />
            <ExtractionRunSection title="Slow extraction" params={slowParams} result={result200} durationMs={slowDurationMs} activePanel={slowPanel} onPanelChange={setSlowPanel} onParamsChange={setSlowParams} />
          </div>
        </section>
      </div>
    </main>
  );
}

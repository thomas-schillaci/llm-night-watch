import { ChangeEvent, FormEvent, useMemo, useState } from "react";
import { Check, FileJson, FileText, Image as ImageIcon, Loader2, RotateCcw, Send, Upload } from "lucide-react";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";

type Extracted = Record<string, string>;

type ExtractionResult = {
  dpi: number;
  prompt: { text: string };
  processed_image: { dpi: number; mime_type: string; width: number; height: number; base64: string; data_url: string };
  request: Record<string, unknown>;
  raw_response: Record<string, unknown>;
  extracted: Record<string, unknown>;
  status?: "ok" | "validation_failed";
  validation_message?: string;
  validation_errors?: Array<Record<string, unknown>>;
};

type PanelKey = "prompt" | "request" | "raw" | "json";

const defaultPrompt = "Extract the requested structured data from the document. If a value is not present, use an empty string. Return only JSON.";

const defaultResponseFormat = JSON.stringify(
  {
    type: "json_schema",
    json_schema: {
      name: "ExtractionResult",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          value: { type: "string" },
        },
        required: ["value"],
      },
    },
  },
  null,
  2,
);

const panelLabels: Record<PanelKey, string> = {
  prompt: "Prompt",
  request: "Request",
  raw: "Raw response",
  json: "JSON",
};

function stringify(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function normalizeExtracted(value: Record<string, unknown>): Extracted {
  return Object.fromEntries(Object.entries(value).map(([key, fieldValue]) => [key, fieldValue == null ? "" : String(fieldValue)]));
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

async function extract(file: File, dpi: 100 | 200, prompt: string, responseFormat: string): Promise<ExtractionResult> {
  const body = new FormData();
  body.append("file", file);
  body.append("dpi", String(dpi));
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

function FieldEditor({ value, onChange, disabled }: { value: Extracted; onChange: (next: Extracted) => void; disabled: boolean }) {
  const fields = Object.keys(value);
  if (fields.length === 0) return <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">No extracted fields yet.</div>;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {fields.map((field) => (
        <label key={field} className="grid gap-1.5 text-sm">
          <span className="font-medium text-foreground">{field}</span>
          <textarea
            className="min-h-20 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm leading-5 outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
            value={value[field] ?? ""}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, [field]: event.target.value })}
          />
        </label>
      ))}
    </div>
  );
}

function JsonPanel({ result, active }: { result: ExtractionResult | null; active: PanelKey }) {
  if (!result) return <pre className="panel-pre text-muted-foreground">Run extraction to inspect this payload.</pre>;
  const content = active === "prompt" ? result.prompt.text : active === "request" ? stringify(result.request) : active === "raw" ? stringify(result.raw_response) : stringify(result.extracted);
  return <pre className="panel-pre">{content}</pre>;
}

export function App() {
  const [file, setFile] = useState<File | null>(null);
  const [pdfUrl, setPdfUrl] = useState("");
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [responseFormat, setResponseFormat] = useState(defaultResponseFormat);
  const [result100, setResult100] = useState<ExtractionResult | null>(null);
  const [result200, setResult200] = useState<ExtractionResult | null>(null);
  const [editable, setEditable] = useState<Extracted>({});
  const [verifiedOriginal, setVerifiedOriginal] = useState<Extracted | null>(null);
  const [verifiedEdited, setVerifiedEdited] = useState<Extracted | null>(null);
  const [activeDpi, setActiveDpi] = useState<100 | 200>(100);
  const [activePanel, setActivePanel] = useState<PanelKey>("json");
  const [status, setStatus] = useState<"idle" | "running100" | "running200" | "done" | "error">("idle");
  const [error, setError] = useState("");

  const activeResult = activeDpi === 100 ? result100 : result200;
  const baselineRaw = result200?.extracted ?? result100?.extracted ?? {};
  const baseline = useMemo(() => normalizeExtracted(baselineRaw), [baselineRaw]);
  const dirty = useMemo(() => stringify(baseline) !== stringify(editable), [baseline, editable]);

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.files?.[0] ?? null;
    setFile(next);
    setPdfUrl(next ? URL.createObjectURL(next) : "");
    setResult100(null);
    setResult200(null);
    setEditable({});
    setVerifiedOriginal(null);
    setVerifiedEdited(null);
    setError("");
    setStatus("idle");
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;
    setError("");
    setResult100(null);
    setResult200(null);
    setVerifiedOriginal(null);
    setVerifiedEdited(null);
    try {
      JSON.parse(responseFormat);
      setStatus("running100");
      const first = await extract(file, 100, prompt, responseFormat);
      setResult100(first);
      setActiveDpi(100);
      setEditable(normalizeExtracted(first.extracted));
      setStatus("running200");
      const second = await extract(file, 200, prompt, responseFormat);
      setResult200(second);
      setActiveDpi(200);
      setEditable(normalizeExtracted(second.extracted));
      setStatus("done");
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "Extraction failed");
    }
  };

  const verify = () => {
    setVerifiedOriginal(baseline);
    setVerifiedEdited(editable);
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-5 px-5 py-5">
        <header className="flex flex-col gap-3 border-b pb-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-normal">LLM Night Watch</h1>
            <p className="text-sm text-muted-foreground">Document extraction review</p>
          </div>
          <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
            <label className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent">
              <Upload className="h-4 w-4" />
              <span>{file ? file.name : "Upload PDF"}</span>
              <input className="sr-only" type="file" accept="application/pdf" onChange={onFileChange} />
            </label>
            <Button type="submit" disabled={!file || !prompt.trim() || !responseFormat.trim() || status === "running100" || status === "running200"}>
              {status === "running100" || status === "running200" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {status === "running100" ? "Sending 100 DPI" : status === "running200" ? "Sending 200 DPI" : "Send"}
            </Button>
          </form>
        </header>

        <section className="grid gap-4 lg:grid-cols-2">
          <label className="grid gap-2 rounded-md border bg-card p-3 text-sm">
            <span className="font-medium">Prompt</span>
            <textarea className="min-h-40 resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-5 outline-none focus:ring-2 focus:ring-ring" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </label>
          <label className="grid gap-2 rounded-md border bg-card p-3 text-sm">
            <span className="font-medium">Response format</span>
            <textarea className="min-h-40 resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-5 outline-none focus:ring-2 focus:ring-ring" value={responseFormat} onChange={(event) => setResponseFormat(event.target.value)} spellCheck={false} />
          </label>
        </section>

        {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}
        {activeResult?.status === "validation_failed" ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {activeResult.validation_message || "One or more extracted fields could not be validated."}
          </div>
        ) : null}

        <section className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(520px,0.9fr)]">
          <div className="grid min-h-[680px] gap-4 lg:grid-cols-2">
            <div className="viewer">
              <div className="viewer-title"><FileText className="h-4 w-4" />PDF</div>
              {pdfUrl ? <iframe className="h-full w-full" src={pdfUrl} title="PDF preview" /> : <div className="empty-state">Upload a PDF to preview it.</div>}
            </div>
            <div className="viewer">
              <div className="viewer-title justify-between">
                <span className="inline-flex items-center gap-2"><ImageIcon className="h-4 w-4" />Processed JPEG</span>
                <div className="segmented">
                  {[100, 200].map((dpi) => (
                    <button key={dpi} className={cn("segmented-button", activeDpi === dpi && "segmented-button-active")} type="button" disabled={dpi === 200 && !result200} onClick={() => setActiveDpi(dpi as 100 | 200)}>{dpi}</button>
                  ))}
                </div>
              </div>
              {activeResult ? (
                <div className="processed-wrap">
                  <img src={activeResult.processed_image.data_url} alt={`${activeResult.dpi} DPI processed first page`} />
                  <div className="image-meta">{activeResult.processed_image.width} x {activeResult.processed_image.height} · JPEG quality 80 · base64</div>
                </div>
              ) : <div className="empty-state">The black-and-white JPEG preview appears after extraction.</div>}
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <section className="rounded-md border bg-card">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
                <div className="inline-flex items-center gap-2 text-sm font-medium"><FileJson className="h-4 w-4" />Extraction</div>
                <div className="segmented">
                  {(Object.keys(panelLabels) as PanelKey[]).map((key) => (
                    <button key={key} className={cn("segmented-button", activePanel === key && "segmented-button-active")} type="button" onClick={() => setActivePanel(key)}>{panelLabels[key]}</button>
                  ))}
                </div>
              </div>
              <JsonPanel result={activeResult} active={activePanel} />
              {activeResult?.validation_errors?.length ? (
                <div className="border-t bg-amber-50 p-3">
                  <div className="mb-2 text-sm font-medium text-amber-950">Validation errors</div>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-amber-950">{stringify(activeResult.validation_errors)}</pre>
                </div>
              ) : null}
            </section>

            <section className="rounded-md border bg-card">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
                <div>
                  <h2 className="text-sm font-medium">Verification</h2>
                  <p className="text-xs text-muted-foreground">Edit extracted fields before confirming.</p>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" type="button" disabled={!activeResult || !dirty} onClick={() => setEditable(baseline)}><RotateCcw className="h-4 w-4" />Reset</Button>
                  <Button type="button" disabled={!activeResult} onClick={verify}><Check className="h-4 w-4" />{dirty ? "Confirm edits" : "Extraction is perfect"}</Button>
                </div>
              </div>
              <div className="p-3"><FieldEditor value={editable} onChange={setEditable} disabled={!activeResult} /></div>
            </section>

            {verifiedOriginal && verifiedEdited ? (
              <section className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-md border bg-card"><div className="border-b p-3 text-sm font-medium">Before edit</div><pre className="snapshot-pre">{stringify(verifiedOriginal)}</pre></div>
                <div className="rounded-md border bg-card"><div className="border-b p-3 text-sm font-medium">After edit</div><pre className="snapshot-pre">{stringify(verifiedEdited)}</pre></div>
              </section>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}

import { Fragment, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { Button } from "./ui/button";

const API_BASE = "";

type RequestSummary = {
  request_id: string;
  started_at: number;
  method: string;
  path: string;
  query_string: string;
  model: string;
  status_code: number | null;
  latency_ms: number | null;
  elapsed_ms: number | null;
  error: string;
  request_body: string | null;
  response_body: string | null;
  request_truncated: boolean;
  response_truncated: boolean;
  validation_issues: string[];
  running: boolean;
};

type RequestsResponse = {
  active: RequestSummary[];
  saved: RequestSummary[];
};

type LoadState = "idle" | "loading" | "success" | "error";

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp * 1000));
}

function formatDuration(value: number | null) {
  if (value == null) {
    return "-";
  }
  if (value < 1000) {
    return `${Math.round(value)} ms`;
  }
  return `${(value / 1000).toFixed(1)} s`;
}

function statusTone(request: RequestSummary) {
  if (request.running) {
    return "text-muted-foreground";
  }
  if (request.error || (request.status_code != null && request.status_code >= 500)) {
    return "text-destructive";
  }
  if (request.status_code != null && request.status_code >= 400) {
    return "text-amber-700";
  }
  return "text-primary";
}

function statusIcon(request: RequestSummary) {
  const className = `h-4 w-4 ${statusTone(request)}`;
  if (request.running) {
    return <Loader2 className={`${className} animate-spin`} />;
  }
  if (request.error || (request.status_code != null && request.status_code >= 500)) {
    return <XCircle className={className} />;
  }
  if (request.status_code != null && request.status_code >= 400) {
    return <AlertCircle className={className} />;
  }
  return <CheckCircle2 className={className} />;
}

function requestStatus(request: RequestSummary) {
  if (request.running) {
    return "Running";
  }
  if (request.status_code == null) {
    return request.error ? "Error" : "-";
  }
  return String(request.status_code);
}

function bodyPreview(body: string | null, truncated: boolean) {
  if (!body) {
    return "";
  }
  return truncated ? `${body}\n[truncated]` : body;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  if (!text) {
    return null;
  }

  return (
    <button
      aria-label="Copy to clipboard"
      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
      type="button"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function RequestsTable({ emptyText, loading, requests }: { emptyText: string; loading: boolean; requests: RequestSummary[] }) {
  const [expandedRequestId, setExpandedRequestId] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading requests…
      </div>
    );
  }

  if (!requests.length) {
    return <div className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">{emptyText}</div>;
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="min-w-full border-collapse text-sm">
        <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="w-10 px-3 py-2 font-medium" aria-label="Details" />
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Time</th>
            <th className="px-3 py-2 font-medium">Method</th>
            <th className="px-3 py-2 font-medium">Path</th>
            <th className="px-3 py-2 font-medium">Model</th>
            <th className="px-3 py-2 text-right font-medium">Duration</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((request) => {
            const hasIssues = request.validation_issues.length > 0;
            const hasBody = Boolean(request.request_body || request.response_body || request.error || hasIssues);
            const expanded = expandedRequestId === request.request_id;

            return (
              <Fragment key={request.request_id}>
                <tr className="border-t align-middle">
                  <td className="px-3 py-3">
                    <button
                      aria-label={expanded ? "Hide request details" : "Show request details"}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-accent disabled:opacity-30"
                      disabled={!hasBody}
                      onClick={() => setExpandedRequestId(expanded ? null : request.request_id)}
                      type="button"
                    >
                      {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </button>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2 whitespace-nowrap">
                      {statusIcon(request)}
                      <span className={statusTone(request)}>{requestStatus(request)}</span>
                      {hasIssues ? (
                        <AlertTriangle
                          aria-label="Response validation issues"
                          className="h-4 w-4 text-amber-700"
                          title={request.validation_issues.join("; ")}
                        />
                      ) : null}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{formatTime(request.started_at)}</td>
                  <td className="px-3 py-3 font-medium">{request.method}</td>
                  <td className="max-w-[360px] px-3 py-3">
                    <div className="truncate font-medium">{request.path}</div>
                    {request.query_string ? <div className="truncate text-xs text-muted-foreground">?{request.query_string}</div> : null}
                  </td>
                  <td className="max-w-[220px] truncate px-3 py-3 text-muted-foreground">{request.model || "-"}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-right text-muted-foreground">
                    {formatDuration(request.running ? request.elapsed_ms : request.latency_ms)}
                  </td>
                </tr>
                {expanded ? (
                  <tr className="border-t bg-card">
                    <td className="px-3 py-3" />
                    <td className="px-3 py-3" colSpan={6}>
                      <div className="space-y-3">
                        {hasIssues ? (
                          <div className="space-y-2 rounded-md border border-amber-700/30 bg-amber-700/10 p-3">
                            <h4 className="flex items-center gap-2 text-xs font-medium uppercase text-amber-700">
                              <AlertTriangle className="h-3.5 w-3.5" />
                              Validation issues
                            </h4>
                            <ul className="list-inside list-disc space-y-1 text-xs text-amber-700">
                              {request.validation_issues.map((issue, index) => (
                                <li key={index}>{issue}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        <div className="grid gap-3 lg:grid-cols-2">
                          <div className="min-w-0 space-y-2">
                            <div className="flex items-center justify-between">
                              <h4 className="text-xs font-medium uppercase text-muted-foreground">Request</h4>
                              <CopyButton text={bodyPreview(request.request_body, request.request_truncated)} />
                            </div>
                            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs leading-relaxed text-foreground">{bodyPreview(request.request_body, request.request_truncated) || "-"}</pre>
                          </div>
                          <div className="min-w-0 space-y-2">
                            <div className="flex items-center justify-between">
                              <h4 className="text-xs font-medium uppercase text-muted-foreground">Response</h4>
                              <CopyButton text={bodyPreview(request.response_body || request.error, request.response_truncated)} />
                            </div>
                            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs leading-relaxed text-foreground">{bodyPreview(request.response_body || request.error, request.response_truncated) || "-"}</pre>
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function RequestsTab() {
  const [active, setActive] = useState<RequestSummary[]>([]);
  const [saved, setSaved] = useState<RequestSummary[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [hasLoaded, setHasLoaded] = useState(false);
  const [message, setMessage] = useState("");

  async function loadRequests(signal?: AbortSignal) {
    setLoadState((current) => (current === "success" ? current : "loading"));
    try {
      const payload = await readJson<RequestsResponse>(await fetch(`${API_BASE}/api/requests?limit=100`, { signal }));
      setActive(payload.active);
      setSaved(payload.saved);
      setLoadState("success");
      setHasLoaded(true);
      setMessage("");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      setLoadState("error");
      setHasLoaded(true);
      setMessage(error instanceof Error ? error.message : "Could not load requests");
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadRequests(controller.signal);
    const interval = window.setInterval(() => void loadRequests(controller.signal), 2000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, []);

  const [onlyValidationFailures, setOnlyValidationFailures] = useState(false);

  const totalSaved = saved.length;
  const recentWithBodies = useMemo(() => saved.filter((request) => request.request_body || request.response_body), [saved]);
  const allRequests = useMemo(() => {
    const merged = new Map<string, RequestSummary>();
    for (const request of active) {
      merged.set(request.request_id, request);
    }
    for (const request of saved) {
      merged.set(request.request_id, request);
    }
    return Array.from(merged.values()).sort((a, b) => b.started_at - a.started_at);
  }, [active, saved]);
  const validationFailureCount = useMemo(
    () => allRequests.filter((request) => request.validation_issues.length > 0).length,
    [allRequests],
  );
  const visibleRequests = useMemo(
    () => (onlyValidationFailures ? allRequests.filter((request) => request.validation_issues.length > 0) : allRequests),
    [allRequests, onlyValidationFailures],
  );

  return (
    <section className="mx-auto w-full max-w-[1600px] px-5 py-5">
      <div className="space-y-6">
        {message ? <p className="text-sm text-destructive">{message}</p> : null}

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-md border bg-card px-4 py-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Clock3 className="h-4 w-4" /> Running</div>
            {hasLoaded ? (
              <div className="mt-2 text-2xl font-semibold">{active.length}</div>
            ) : (
              <div className="mt-2 h-8 w-10 animate-pulse rounded bg-muted" />
            )}
          </div>
          <div className="rounded-md border bg-card px-4 py-3">
            <div className="text-sm text-muted-foreground">Saved</div>
            {hasLoaded ? (
              <div className="mt-2 text-2xl font-semibold">{totalSaved}</div>
            ) : (
              <div className="mt-2 h-8 w-10 animate-pulse rounded bg-muted" />
            )}
          </div>
          <div className="rounded-md border bg-card px-4 py-3">
            <div className="text-sm text-muted-foreground">Captured bodies</div>
            {hasLoaded ? (
              <div className="mt-2 text-2xl font-semibold">{recentWithBodies.length}</div>
            ) : (
              <div className="mt-2 h-8 w-10 animate-pulse rounded bg-muted" />
            )}
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <Button
              className={onlyValidationFailures ? "border-amber-700/50 text-amber-700" : ""}
              onClick={() => setOnlyValidationFailures((current) => !current)}
              type="button"
              variant={onlyValidationFailures ? "secondary" : "outline"}
            >
              <AlertTriangle className="h-4 w-4" />
              {onlyValidationFailures ? "Showing validation failures" : "Show validation failures only"}
              {validationFailureCount > 0 ? ` (${validationFailureCount})` : ""}
            </Button>
            <Button disabled={loadState === "loading"} onClick={() => void loadRequests()} type="button" variant="outline">
              {loadState === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
          </div>
          <RequestsTable
            emptyText={
              onlyValidationFailures
                ? "No requests with validation issues."
                : "No requests yet. Send traffic through /v1/* to populate this list."
            }
            loading={!hasLoaded}
            requests={visibleRequests}
          />
        </div>

      </div>
    </section>
  );
}

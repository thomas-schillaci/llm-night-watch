import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Clock3, Loader2, RefreshCw, XCircle } from "lucide-react";
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
  const preview = body.length > 800 ? `${body.slice(0, 800)}...` : body;
  return truncated ? `${preview}\n[truncated]` : preview;
}

function RequestsTable({ emptyText, requests }: { emptyText: string; requests: RequestSummary[] }) {
  if (!requests.length) {
    return <div className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">{emptyText}</div>;
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="min-w-full border-collapse text-sm">
        <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Time</th>
            <th className="px-3 py-2 font-medium">Method</th>
            <th className="px-3 py-2 font-medium">Path</th>
            <th className="px-3 py-2 font-medium">Model</th>
            <th className="px-3 py-2 text-right font-medium">Duration</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((request) => (
            <tr className="border-t align-top" key={request.request_id}>
              <td className="px-3 py-3">
                <div className="flex items-center gap-2 whitespace-nowrap">
                  {statusIcon(request)}
                  <span className={statusTone(request)}>{requestStatus(request)}</span>
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
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RequestDetails({ requests }: { requests: RequestSummary[] }) {
  const withBodies = requests.filter((request) => request.request_body || request.response_body).slice(0, 5);

  if (!withBodies.length) {
    return null;
  }

  return (
    <div className="space-y-3">
      {withBodies.map((request) => (
        <details className="rounded-md border bg-card" key={request.request_id}>
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
            {request.method} {request.path} <span className="text-muted-foreground">{request.model || ""}</span>
          </summary>
          <div className="grid gap-3 border-t p-3 lg:grid-cols-2">
            <div className="min-w-0 space-y-2">
              <h4 className="text-xs font-medium uppercase text-muted-foreground">Request</h4>
              <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed text-foreground">{bodyPreview(request.request_body, request.request_truncated) || "-"}</pre>
            </div>
            <div className="min-w-0 space-y-2">
              <h4 className="text-xs font-medium uppercase text-muted-foreground">Response</h4>
              <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed text-foreground">{bodyPreview(request.response_body, request.response_truncated) || "-"}</pre>
            </div>
          </div>
        </details>
      ))}
    </div>
  );
}

export function RequestsTab() {
  const [active, setActive] = useState<RequestSummary[]>([]);
  const [saved, setSaved] = useState<RequestSummary[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [message, setMessage] = useState("");

  async function loadRequests(signal?: AbortSignal) {
    setLoadState((current) => (current === "success" ? current : "loading"));
    try {
      const payload = await readJson<RequestsResponse>(await fetch(`${API_BASE}/api/requests?limit=100`, { signal }));
      setActive(payload.active);
      setSaved(payload.saved);
      setLoadState("success");
      setMessage("");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      setLoadState("error");
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

  const totalSaved = saved.length;
  const recentWithBodies = useMemo(() => saved.filter((request) => request.request_body || request.response_body), [saved]);

  return (
    <section className="mx-auto w-full max-w-[1600px] px-5 py-5">
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-xl font-semibold tracking-normal">Requests</h2>
            <p className="text-sm text-muted-foreground">Live proxied requests and recent saved traffic.</p>
          </div>
          <Button disabled={loadState === "loading"} onClick={() => void loadRequests()} type="button" variant="outline">
            {loadState === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
        </div>

        {message ? <p className="text-sm text-destructive">{message}</p> : null}

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-md border bg-card px-4 py-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Clock3 className="h-4 w-4" /> Running</div>
            <div className="mt-2 text-2xl font-semibold">{active.length}</div>
          </div>
          <div className="rounded-md border bg-card px-4 py-3">
            <div className="text-sm text-muted-foreground">Saved</div>
            <div className="mt-2 text-2xl font-semibold">{totalSaved}</div>
          </div>
          <div className="rounded-md border bg-card px-4 py-3">
            <div className="text-sm text-muted-foreground">Captured bodies</div>
            <div className="mt-2 text-2xl font-semibold">{recentWithBodies.length}</div>
          </div>
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-medium">Running</h3>
          <RequestsTable emptyText="No requests are currently running." requests={active} />
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-medium">Saved</h3>
          <RequestsTable emptyText="No saved requests yet. Send traffic through /v1/* to populate this list." requests={saved} />
        </div>

        <RequestDetails requests={saved} />
      </div>
    </section>
  );
}

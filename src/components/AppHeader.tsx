import { AppTab, VllmHealth, VllmMetrics } from "../types";
import { cn } from "../lib/utils";

function metricText(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "-";
}

function VllmStatusDot({ health }: { health: VllmHealth | null }) {
  const available = health?.available === true;
  const label = available ? "vLLM /health reachable" : health?.error || "vLLM /health unavailable";
  return (
    <span className="inline-flex items-center gap-2" title={label}>
      <span className="relative flex h-2.5 w-2.5">
        <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-30", available ? "bg-emerald-500" : "bg-red-500")} />
        <span className={cn("relative inline-flex h-2.5 w-2.5 rounded-full opacity-80 shadow-sm", available ? "bg-emerald-500 shadow-emerald-500/50" : "bg-red-500 shadow-red-500/50")} />
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function VllmMetricsDisplay({ metrics, health }: { metrics: VllmMetrics | null; health: VllmHealth | null }) {
  const available = metrics?.available !== false;
  return (
    <div
      className="inline-flex h-10 items-center overflow-hidden rounded-md border bg-card text-xs shadow-sm"
      title={available ? "vLLM live request metrics" : metrics?.error || "vLLM metrics unavailable"}
    >
      <div className="flex h-full items-center gap-2 border-r bg-muted/50 px-3 font-medium text-foreground">
        <VllmStatusDot health={health} />
        vLLM
      </div>
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

export function AppHeader({ activeTab, onTabChange, metrics, health }: { activeTab: AppTab; onTabChange: (next: AppTab) => void; metrics: VllmMetrics | null; health: VllmHealth | null }) {
  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-3 px-5 py-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">LLM Night Watch</h1>
          <p className="text-sm text-muted-foreground">Document extraction review</p>
        </div>
        <VllmMetricsDisplay metrics={metrics} health={health} />
      </div>
      <nav className="mx-auto flex w-full max-w-[1600px] gap-1 px-5" aria-label="Primary">
        <button
          className={cn("border-b-2 px-3 py-2 text-sm font-medium", activeTab === "config" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
          type="button"
          onClick={() => onTabChange("config")}
        >
          Config
        </button>
        <button
          className={cn("border-b-2 px-3 py-2 text-sm font-medium", activeTab === "manual-request" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
          type="button"
          onClick={() => onTabChange("manual-request")}
        >
          Manual request
        </button>
      </nav>
    </header>
  );
}

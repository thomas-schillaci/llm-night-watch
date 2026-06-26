import { ConfigStatus } from "../types";
import { cn } from "../lib/utils";

function StatusLight({ ok }: { ok: boolean }) {
  return <span className={cn("h-2.5 w-2.5 rounded-full", ok ? "bg-emerald-500" : "bg-red-500")} />;
}

function ConfigRow({ label, ok, value, detail }: { label: string; ok: boolean; value: string; detail?: string }) {
  return (
    <div className="grid gap-3 rounded-md border bg-card p-4 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-center">
      <div className="flex items-center gap-2 text-sm font-medium">
        <StatusLight ok={ok} />
        {label}
      </div>
      <div className="min-w-0">
        <div className="break-words font-mono text-sm text-foreground">{value}</div>
        {detail ? <div className="mt-1 break-words text-xs text-muted-foreground">{detail}</div> : null}
      </div>
    </div>
  );
}

export function ConfigTab({ config, error }: { config: ConfigStatus | null; error: string }) {
  const dockerDetail = config?.docker.detail || config?.docker.error || "Checking Docker...";
  const imageDetail = config?.vllm_image.detail || config?.vllm_image.error || "Checking local image...";
  const gpuNames = config?.gpu.devices.length ? config.gpu.devices.join(", ") : "No GPU detected";

  return (
    <section className="mx-auto grid w-full max-w-[1600px] gap-5 px-5 py-5">
      <div className="rounded-md border bg-card p-4">
        <h2 className="text-sm font-medium">Config</h2>
        <p className="text-xs text-muted-foreground">Runtime checks for local vLLM setup.</p>
      </div>
      {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}
      <div className="grid gap-3">
        <ConfigRow label="Docker" ok={config?.docker.available === true} value={config?.docker.available ? "Installed" : "Not installed"} detail={dockerDetail} />
        <ConfigRow label="vLLM image" ok={config?.vllm_image.pulled === true} value={config?.vllm_image.image ?? "vllm/vllm-openai:latest"} detail={imageDetail} />
        <ConfigRow label="Detected GPU" ok={config?.gpu.detected === true} value={gpuNames} detail={config?.gpu.error || undefined} />
      </div>
    </section>
  );
}

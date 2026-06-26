import { FormEvent, ReactNode, useEffect, useState } from "react";
import { AppConfig, ConfigStatus } from "../types";
import { cn } from "../lib/utils";
import { updateConfig } from "../api";
import { Button } from "./ui/button";

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


function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

const inputClass = "h-10 rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground outline-none focus:ring-2 focus:ring-ring";

function defaultAppConfig(): AppConfig {
  return {
    vllm: {
      url: "http://localhost:8000",
      model: "auto",
      api_key: "EMPTY",
      image: "vllm/vllm-openai:latest",
    },
  };
}

export function ConfigTab({ config, error, onConfigSaved }: { config: ConfigStatus | null; error: string; onConfigSaved: (config: ConfigStatus) => void }) {
  const [appConfig, setAppConfig] = useState<AppConfig>(() => config?.app_config ?? defaultAppConfig());
  const [saveError, setSaveError] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (config?.app_config) setAppConfig(config.app_config);
  }, [config?.app_config]);

  const gpuNames = config?.gpu.devices.length ? config.gpu.devices.join(", ") : "No GPU detected";
  const modelResolved = config?.model.resolved || "";
  const modelDetail = config?.model.detail || config?.model.error || "Auto-detect queries vLLM /v1/models.";

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaveError("");
    setSaveMessage("");
    try {
      const nextStatus = await updateConfig(appConfig);
      onConfigSaved(nextStatus);
      setSaveMessage("Saved");
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "Could not save config");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mx-auto grid w-full max-w-[1600px] gap-5 px-5 py-5">
      <form className="grid gap-4 rounded-md border bg-card p-4" onSubmit={save}>
        <div>
          <h2 className="text-sm font-medium">Config</h2>
          <p className="text-xs text-muted-foreground">Runtime connection settings and local vLLM checks.</p>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <Field label="vLLM URL">
            <input
              className={inputClass}
              value={appConfig.vllm.url}
              onChange={(event) => setAppConfig({ ...appConfig, vllm: { ...appConfig.vllm, url: event.target.value } })}
            />
            <div className="text-xs text-muted-foreground">Relative URLs resolve from the backend.</div>
          </Field>
          <Field label="Model">
            <select
              className={inputClass}
              value={appConfig.vllm.model}
              onChange={(event) => setAppConfig({ ...appConfig, vllm: { ...appConfig.vllm, model: event.target.value } })}
            >
              <option value="auto">auto</option>
              {config?.model.models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
            <div className={cn("text-xs", modelResolved ? "text-muted-foreground" : "text-destructive")}>
              {modelResolved ? `Resolved: ${modelResolved}` : modelDetail}
            </div>
          </Field>
          <Field label="API key">
            <input
              className={inputClass}
              type="password"
              value={appConfig.vllm.api_key}
              onChange={(event) => setAppConfig({ ...appConfig, vllm: { ...appConfig.vllm, api_key: event.target.value } })}
            />
          </Field>
          <Field label="vLLM image">
            <input
              className={inputClass}
              value={appConfig.vllm.image}
              onChange={(event) => setAppConfig({ ...appConfig, vllm: { ...appConfig.vllm, image: event.target.value } })}
            />
          </Field>
        </div>


        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save config"}</Button>
          {saveMessage ? <span className="text-xs text-emerald-600">{saveMessage}</span> : null}
          {saveError ? <span className="text-xs text-destructive">{saveError}</span> : null}
        </div>
      </form>

      {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}
      <div className="grid gap-3">
        <ConfigRow label="Detected GPU" ok={config?.gpu.detected === true} value={gpuNames} detail={config?.gpu.error || undefined} />
      </div>
    </section>
  );
}

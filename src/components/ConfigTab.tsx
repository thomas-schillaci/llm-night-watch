import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Eye, EyeOff, Loader2, RefreshCw, Save, TestTube2, XCircle } from "lucide-react";
import { Button } from "./ui/button";

const API_BASE = "";

type VllmConfig = {
  url: string;
  model: string;
  api_key: string;
  image: string;
};

type ProxyConfig = {
  base_url: string;
  api_key: string;
  capture_bodies: boolean;
  max_body_bytes: number;
  db_path: string;
};

type AppConfig = {
  vllm: VllmConfig;
  proxy: ProxyConfig;
};

type ConfigStatus = {
  app_config: AppConfig;
};

type TestResult = {
  ok: boolean;
  models: string[];
  detail: string;
  error: string;
};

type AsyncState = "idle" | "loading" | "success" | "error";

const defaultConfig: AppConfig = {
  vllm: {
    url: "http://localhost:8000",
    model: "auto",
    api_key: "EMPTY",
    image: "vllm/vllm-openai:latest",
  },
  proxy: {
    base_url: "http://localhost:8000",
    api_key: "EMPTY",
    capture_bodies: true,
    max_body_bytes: 1_000_000,
    db_path: "llm-night-watch.sqlite3",
  },
};

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function ConfigTab() {
  const [config, setConfig] = useState<AppConfig>(defaultConfig);
  const [savedConfig, setSavedConfig] = useState<AppConfig>(defaultConfig);
  const [showApiKey, setShowApiKey] = useState(false);
  const [loadState, setLoadState] = useState<AsyncState>("loading");
  const [saveState, setSaveState] = useState<AsyncState>("idle");
  const [testState, setTestState] = useState<AsyncState>("idle");
  const [message, setMessage] = useState("");
  const [models, setModels] = useState<string[]>([]);

  const isDirty = useMemo(() => JSON.stringify(config) !== JSON.stringify(savedConfig), [config, savedConfig]);

  const loadConfig = useCallback(async (signal?: AbortSignal) => {
    setLoadState("loading");
    setMessage("");
    try {
      const payload = await readJson<ConfigStatus>(await fetch(`${API_BASE}/api/config`, { signal }));
      if (signal?.aborted) {
        return;
      }
      setConfig(payload.app_config);
      setSavedConfig(payload.app_config);
      setLoadState("success");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      setLoadState("error");
      setMessage(error instanceof Error ? error.message : "Could not load config");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadConfig(controller.signal);
    return () => controller.abort();
  }, [loadConfig]);

  function updateProxyField<K extends keyof ProxyConfig>(field: K, value: ProxyConfig[K]) {
    setConfig((current) => ({
      ...current,
      proxy: {
        ...current.proxy,
        [field]: value,
      },
    }));
  }

  async function saveConfig() {
    setSaveState("loading");
    setMessage("");
    try {
      const nextConfig: AppConfig = {
        ...config,
        vllm: {
          ...config.vllm,
          url: config.proxy.base_url,
          api_key: config.proxy.api_key,
        },
      };
      const payload = await readJson<ConfigStatus>(
        await fetch(`${API_BASE}/api/config`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(nextConfig),
        }),
      );
      setConfig(payload.app_config);
      setSavedConfig(payload.app_config);
      setSaveState("success");
      setMessage("Settings saved.");
    } catch (error) {
      setSaveState("error");
      setMessage(error instanceof Error ? error.message : "Could not save settings");
    }
  }

  async function testConfig() {
    setTestState("loading");
    setMessage("");
    setModels([]);
    try {
      const result = await readJson<TestResult>(
        await fetch(`${API_BASE}/api/config/test`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ base_url: config.proxy.base_url, api_key: config.proxy.api_key }),
        }),
      );
      if (!result.ok) {
        throw new Error(result.error || "Upstream test failed");
      }
      setModels(result.models);
      setTestState("success");
      setMessage(result.models.length ? `Connected. Found ${result.models.length} model(s).` : "Connected. No models reported.");
    } catch (error) {
      setTestState("error");
      setMessage(error instanceof Error ? error.message : "Could not test upstream");
    }
  }

  const busy = saveState === "loading" || testState === "loading";
  const messageTone = saveState === "error" || testState === "error" ? "text-destructive" : "text-muted-foreground";

  if (loadState === "loading") {
    return (
      <section className="mx-auto w-full max-w-[1600px] px-5 py-5">
        <div className="max-w-3xl space-y-5">
          <div className="grid gap-2">
            <div className="h-4 w-16 animate-pulse rounded bg-muted" />
            <div className="h-10 w-full animate-pulse rounded-md bg-muted" />
          </div>
          <div className="grid gap-2">
            <div className="h-4 w-16 animate-pulse rounded bg-muted" />
            <div className="h-10 w-full animate-pulse rounded-md bg-muted" />
          </div>
          <div className="flex gap-2 pt-1">
            <div className="h-10 w-24 animate-pulse rounded-md bg-muted" />
            <div className="h-10 w-24 animate-pulse rounded-md bg-muted" />
          </div>
        </div>
      </section>
    );
  }

  if (loadState === "error") {
    return (
      <section className="mx-auto w-full max-w-[1600px] px-5 py-5">
        <div className="max-w-3xl space-y-4">
          <p className="text-sm text-destructive">{message || "Could not load config"}</p>
          <Button onClick={() => void loadConfig()} type="button" variant="outline">
            <RefreshCw className="h-4 w-4" />
            Retry
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="mx-auto w-full max-w-[1600px] px-5 py-5">
      <div className="max-w-3xl space-y-5">
        <form className="space-y-5" onSubmit={(event) => event.preventDefault()}>
          <div className="grid gap-2">
            <label className="text-sm font-medium" htmlFor="base-url">
              Base URL
            </label>
            <input
              className="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
              id="base-url"
              inputMode="url"
              onChange={(event) => updateProxyField("base_url", event.target.value)}
              placeholder="http://localhost:8000"
              spellCheck={false}
              type="url"
              value={config.proxy.base_url}
            />
          </div>

          <div className="grid gap-2">
            <label className="text-sm font-medium" htmlFor="api-key">
              API key
            </label>
            <div className="flex gap-2">
              <input
                className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
                id="api-key"
                onChange={(event) => updateProxyField("api_key", event.target.value)}
                placeholder="EMPTY"
                spellCheck={false}
                type={showApiKey ? "text" : "password"}
                value={config.proxy.api_key}
              />
              <Button
                aria-label={showApiKey ? "Hide API key" : "Show API key"}
                onClick={() => setShowApiKey((current) => !current)}
                type="button"
                variant="outline"
                size="icon"
              >
                {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button disabled={busy || !isDirty} onClick={saveConfig} type="button">
              {saveState === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save
            </Button>
            <Button disabled={busy || !config.proxy.base_url.trim()} onClick={testConfig} type="button" variant="outline">
              {testState === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : <TestTube2 className="h-4 w-4" />}
              Test
            </Button>
            {testState === "success" ? <CheckCircle2 className="h-5 w-5 text-primary" /> : null}
            {testState === "error" || saveState === "error" ? <XCircle className="h-5 w-5 text-destructive" /> : null}
          </div>
        </form>

        {message ? <p className={`text-sm ${messageTone}`}>{message}</p> : null}

        {models.length ? (
          <div className="space-y-2 border-t pt-4">
            <h3 className="text-sm font-medium">Models</h3>
            <div className="flex flex-wrap gap-2">
              {models.map((model) => (
                <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground" key={model}>
                  {model}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

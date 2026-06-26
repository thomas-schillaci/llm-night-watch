import { AppConfig, ConfigStatus, ExtractionParams, ExtractionResult, VllmHealth, VllmMetrics } from "./types";
import { stringify } from "./extractionUtils";


function errorMessageFromPayload(payload: unknown): string {
  if (payload && typeof payload === "object" && "detail" in payload) {
    const detail = (payload as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object" && "message" in detail) return String((detail as { message: unknown }).message);
    return stringify(detail);
  }
  return typeof payload === "string" ? payload : stringify(payload);
}

export async function extract(file: File, params: ExtractionParams, prompt: string, responseFormat: string): Promise<ExtractionResult> {
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

export async function fetchVllmMetrics(): Promise<VllmMetrics> {
  const response = await fetch("/api/vllm-metrics");
  if (!response.ok) throw new Error(`Metrics request failed: ${response.status}`);
  return (await response.json()) as VllmMetrics;
}

export async function fetchVllmHealth(): Promise<VllmHealth> {
  const response = await fetch("/api/vllm");
  if (!response.ok) throw new Error(`vLLM check failed: ${response.status}`);
  return (await response.json()) as VllmHealth;
}

export async function fetchConfigStatus(): Promise<ConfigStatus> {
  const response = await fetch("/api/config");
  if (!response.ok) throw new Error(`Config request failed: ${response.status}`);
  return (await response.json()) as ConfigStatus;
}

export async function updateConfig(config: AppConfig): Promise<ConfigStatus> {
  const response = await fetch("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    throw new Error(errorMessageFromPayload(payload));
  }

  return payload as ConfigStatus;
}

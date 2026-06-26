export type SchemaFieldType = "string" | "number" | "integer" | "boolean" | "string_array";
export type SchemaField = { id: number; name: string; type: SchemaFieldType };

export type ExtractionResult = {
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

export type PanelKey = "prompt" | "request" | "raw" | "json";
export type ResponseFormatMode = "fields" | "raw";
export type ExtractionParams = { dpi: number; first_n_pages: number };
export type AppTab = "config" | "manual-request";

export type VllmMetrics = {
  num_requests_running: number | null;
  num_requests_waiting: number | null;
  available: boolean;
  error: string;
};

export type VllmHealth = {
  available: boolean;
  error: string;
};

export type ConfigStatus = {
  docker: { available: boolean; detail: string; error: string };
  vllm_image: { image: string; images: string[]; pulled: boolean; detail: string; error: string };
  gpu: { detected: boolean; devices: string[]; error: string };
};

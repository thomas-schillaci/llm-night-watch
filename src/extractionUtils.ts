import { ExtractionResult, PanelKey, SchemaField, SchemaFieldType } from "./types";

export const defaultPrompt = "Extract these fields: {{fields}}. If a value is not present, use an empty string. Return only JSON.";
export const fastExtractionParams = { dpi: 100, first_n_pages: 1 };
export const slowExtractionParams = { dpi: 200, first_n_pages: 1 };
export const defaultSchemaFields: SchemaField[] = [{ id: 1, name: "value", type: "string" }];

export const fieldTypeLabels: Record<SchemaFieldType, string> = {
  string: "Text",
  number: "Number",
  integer: "Integer",
  boolean: "True/false",
  string_array: "Text list",
};

export const panelLabels: Record<PanelKey, string> = {
  prompt: "Prompt",
  request: "Request",
  raw: "Raw response",
  json: "JSON",
};

export function stringify(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export function schemaForFieldType(type: SchemaFieldType): Record<string, unknown> {
  if (type === "string_array") return { type: "array", items: { type: "string" } };
  return { type };
}

export function buildResponseFormat(fields: SchemaField[]) {
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

export function schemaFieldsFromResponseFormat(responseFormat: string): SchemaField[] | null {
  const properties = propertiesFromResponseFormat(responseFormat);
  if (!properties) return null;
  return Object.entries(properties).map(([name, schema], index) => ({ id: index + 1, name, type: fieldTypeFromSchema(schema) }));
}

export function fieldNamesFromResponseFormat(responseFormat: string): string[] {
  return Object.keys(propertiesFromResponseFormat(responseFormat) ?? {});
}

export function renderPromptTemplate(prompt: string, fieldNames: string[]) {
  return prompt.split("{{fields}}").join(fieldNames.join(", "));
}

export function schemaFieldErrors(fields: SchemaField[]): string[] {
  const errors: string[] = [];
  const names = fields.map((field) => field.name.trim()).filter(Boolean);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);

  if (fields.some((field) => !field.name.trim())) errors.push("Every field needs a name.");
  if (duplicates.length > 0) errors.push(`Duplicate field name: ${duplicates[0]}.`);
  return errors;
}

export function rawResponseFormatErrors(responseFormat: string): string[] {
  if (!responseFormat.trim()) return ["Response format cannot be empty."];
  try {
    const parsed = JSON.parse(responseFormat);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? [] : ["Response format must be a JSON object."];
  } catch (caught) {
    return [caught instanceof Error ? caught.message : "Response format must be valid JSON."];
  }
}

export function resultPanelContent(result: ExtractionResult, active: PanelKey) {
  return active === "prompt" ? result.prompt.text : active === "request" ? stringify(result.request) : active === "raw" ? stringify(result.raw_response) : stringify(result.extracted);
}

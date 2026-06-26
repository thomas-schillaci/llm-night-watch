import { Plus, Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import { fieldTypeLabels } from "../extractionUtils";
import { ResponseFormatMode, SchemaField, SchemaFieldType } from "../types";
import { cn } from "../lib/utils";

export function ResponseFormatBuilder({
  fields,
  onChange,
  mode,
  onModeChange,
  rawResponseFormat,
  onRawResponseFormatChange,
  errors,
}: {
  fields: SchemaField[];
  onChange: (next: SchemaField[]) => void;
  mode: ResponseFormatMode;
  onModeChange: (next: ResponseFormatMode) => void;
  rawResponseFormat: string;
  onRawResponseFormatChange: (next: string) => void;
  errors: string[];
}) {
  const updateField = (id: number, patch: Partial<SchemaField>) => {
    onChange(fields.map((field) => (field.id === id ? { ...field, ...patch } : field)));
  };

  const addField = () => {
    const nextId = Math.max(0, ...fields.map((field) => field.id)) + 1;
    onChange([...fields, { id: nextId, name: "", type: "string" }]);
  };

  const removeField = (id: number) => {
    onChange(fields.length === 1 ? [{ ...fields[0], name: "", type: "string" }] : fields.filter((field) => field.id !== id));
  };

  return (
    <section className="grid gap-3 rounded-md border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-medium">Response format</h2>
          <p className="text-xs text-muted-foreground">Build fields or paste a complete JSON schema.</p>
        </div>
        <div className="segmented">
          <button className={cn("segmented-button", mode === "fields" && "segmented-button-active")} type="button" onClick={() => onModeChange("fields")}>Fields</button>
          <button className={cn("segmented-button", mode === "raw" && "segmented-button-active")} type="button" onClick={() => onModeChange("raw")}>Raw JSON</button>
        </div>
      </div>

      {mode === "fields" ? (
        <>
          <div className="grid gap-2">
            {fields.map((field) => (
              <div key={field.id} className="grid gap-2 rounded-md border bg-background p-2 sm:grid-cols-[minmax(0,1fr)_160px_40px]">
                <label className="grid gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Name</span>
                  <input
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                    value={field.name}
                    placeholder="field_name"
                    spellCheck={false}
                    onChange={(event) => updateField(field.id, { name: event.target.value })}
                  />
                </label>
                <label className="grid gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Type</span>
                  <select
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                    value={field.type}
                    onChange={(event) => updateField(field.id, { type: event.target.value as SchemaFieldType })}
                  >
                    {(Object.keys(fieldTypeLabels) as SchemaFieldType[]).map((type) => (
                      <option key={type} value={type}>
                        {fieldTypeLabels[type]}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="grid gap-1.5">
                  <span className="invisible text-xs font-medium">Remove</span>
                  <Button type="button" variant="outline" size="icon" title="Remove field" aria-label="Remove field" onClick={() => removeField(field.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <div className="flex justify-end">
            <Button type="button" size="sm" onClick={addField}>
              <Plus className="h-4 w-4" />
              Field
            </Button>
          </div>
        </>
      ) : (
        <label className="grid gap-2">
          <span className="text-xs font-medium text-muted-foreground">JSON schema</span>
          <textarea
            className="min-h-72 resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-5 outline-none focus:ring-2 focus:ring-ring"
            value={rawResponseFormat}
            onChange={(event) => onRawResponseFormatChange(event.target.value)}
            spellCheck={false}
          />
        </label>
      )}

      {errors.length ? <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{errors[0]}</div> : null}
    </section>
  );
}


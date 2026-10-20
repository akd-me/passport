import { LlmError } from "../errors.js";
import type { JsonSchema } from "./types.js";

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Extract JSON from prose/fences, respecting nested arrays, strings, and escaped quotes. */
export function extractJson(text: string): unknown {
  const source = text.replace(/^\uFEFF/, "").trim();
  try { return JSON.parse(source) as unknown; } catch { /* Try balanced embedded values. */ }
  for (let start = 0; start < source.length; start++) {
    if (source[start] !== "{" && source[start] !== "[") continue;
    const stack: string[] = [];
    let quoted = false;
    let escaped = false;
    for (let end = start; end < source.length; end++) {
      const char = source[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") stack.push(char);
      else if (char === "}" || char === "]") {
        if (stack.pop() !== (char === "}" ? "{" : "[")) break;
        if (stack.length === 0) {
          try { return JSON.parse(source.slice(start, end + 1)) as unknown; } catch { break; }
        }
      }
    }
  }
  throw new LlmError("Model response did not contain valid JSON", "LLM_INVALID_JSON");
}

/** Validate the supported schema subset instead of trusting provider JSON mode. */
export function validateJson(value: unknown, schema: JsonSchema, path = "$"): void {
  const fail = (): never => { throw new LlmError(`Structured output does not match schema at ${path}`, "LLM_SCHEMA"); };
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) fail();
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = types.some(type => {
      if (type === "null") return value === null;
      if (type === "array") return Array.isArray(value);
      if (type === "object") return isObject(value);
      if (type === "integer") return typeof value === "number" && Number.isInteger(value);
      if (type === "number") return typeof value === "number" && Number.isFinite(value);
      return typeof value === type;
    });
    if (!matches) fail();
  }
  if (typeof value === "string" && ((schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength))) fail();
  if (typeof value === "number" && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) fail();
  if (Array.isArray(value)) {
    if ((schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems)) fail();
    if (schema.items) value.forEach((item, i) => validateJson(item, schema.items!, `${path}[${i}]`));
  }
  if (isObject(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail();
    for (const [key, item] of Object.entries(value)) {
      const child = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties?.[key] : undefined;
      if (child) validateJson(item, child, `${path}.${key}`);
      else if (schema.additionalProperties === false) fail();
    }
  }
}

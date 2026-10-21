import { ToolError } from "./presentation.js";

/** JSON Schema shared by all transports. Validation/defaults run inside the registry. */
export interface JsonSchema {
  type?:
    | "object"
    | "array"
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "null"
    | Array<"object" | "array" | "string" | "number" | "integer" | "boolean" | "null">;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
}

type Shape = Record<string, Schema<unknown>>;
export type Output<S extends Shape> = {
  [K in keyof S as undefined extends Infer<S[K]> ? never : K]: Infer<S[K]>;
} & { [K in keyof S as undefined extends Infer<S[K]> ? K : never]?: Infer<S[K]> };
type Infer<S> = S extends Schema<infer T> ? T : never;
const invalid = (message: string): never => {
  throw new ToolError("INVALID_INPUT", message);
};

/** Small immutable builder; no provider SDK, Zod or runtime dependency. */
export class Schema<T> {
  constructor(
    readonly json: JsonSchema,
    readonly parse: (input: unknown) => T,
    readonly optionalInput = false,
  ) {}
  private check(
    json: Partial<JsonSchema>,
    test: (value: T) => boolean,
    message: string,
  ): Schema<T> {
    return new Schema(
      { ...this.json, ...json },
      (input) => {
        const value = this.parse(input);
        if (!test(value)) {
          invalid(message);
        }
        return value;
      },
      this.optionalInput,
    );
  }
  optional(): Schema<T | undefined> {
    return new Schema(
      this.json,
      (input) => (input === undefined ? undefined : this.parse(input)),
      true,
    );
  }
  nullable(): Schema<T | null> {
    const types = this.json.type
      ? Array.isArray(this.json.type)
        ? this.json.type
        : [this.json.type]
      : [];
    return new Schema(
      {
        ...this.json,
        type: [...types, "null"],
        ...(this.json.enum ? { enum: [...this.json.enum, null] } : {}),
      },
      (input) => (input === null ? null : this.parse(input)),
      this.optionalInput,
    );
  }
  default(value: T): Schema<T> {
    return new Schema(
      { ...this.json, default: value },
      (input) => (input === undefined ? structuredClone(value) : this.parse(input)),
      true,
    );
  }
  describe(description: string): Schema<T> {
    return new Schema({ ...this.json, description }, this.parse, this.optionalInput);
  }
  trim(): Schema<T> {
    return new Schema(
      this.json,
      (input) => this.parse(typeof input === "string" ? input.trim() : input),
      this.optionalInput,
    );
  }
  min(min: number): Schema<T> {
    const key =
      this.json.type === "array"
        ? "minItems"
        : this.json.type === "string"
          ? "minLength"
          : "minimum";
    return this.check(
      { [key]: min },
      (value) =>
        typeof value === "number" ? value >= min : (value as string | unknown[]).length >= min,
      `Expected at least ${min}.`,
    );
  }
  max(max: number): Schema<T> {
    const key =
      this.json.type === "array"
        ? "maxItems"
        : this.json.type === "string"
          ? "maxLength"
          : "maximum";
    return this.check(
      { [key]: max },
      (value) =>
        typeof value === "number" ? value <= max : (value as string | unknown[]).length <= max,
      `Expected at most ${max}.`,
    );
  }
  int(): Schema<T> {
    return this.check({ type: "integer" }, (value) => Number.isInteger(value), "Expected integer.");
  }
  regex(pattern: RegExp, message: string): Schema<T> {
    return this.check({ pattern: pattern.source }, (value) => pattern.test(String(value)), message);
  }
  refine(test: (value: T) => boolean, message: string): Schema<T> {
    return this.check({}, test, message);
  }
}

export class ObjectSchema<S extends Shape> extends Schema<Output<S>> {
  constructor(readonly shape: S) {
    super(
      {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(shape).map(([key, child]) => [key, child.json]),
        ),
        required: Object.keys(shape).filter((key) => !shape[key]!.optionalInput),
        additionalProperties: false,
      },
      (input) => {
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          return invalid("Expected an object.");
        }
        const values = input as Record<string, unknown>;
        for (const key of Object.keys(values)) {
          if (!Object.hasOwn(shape, key)) {
            invalid(`Unknown field: ${key}.`);
          }
        }
        const output: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(shape)) {
          const value = child.parse(Object.hasOwn(values, key) ? values[key] : undefined);
          if (value !== undefined) {
            output[key] = value;
          }
        }
        return output as Output<S>;
      },
    );
  }
  partial(): ObjectSchema<{ [K in keyof S]: Schema<Infer<S[K]> | undefined> }> {
    return new ObjectSchema(
      Object.fromEntries(
        Object.entries(this.shape).map(([key, child]) => [key, child.optional()]),
      ) as { [K in keyof S]: Schema<Infer<S[K]> | undefined> },
    );
  }
}

const string = () =>
  new Schema<string>({ type: "string" }, (input) =>
    typeof input === "string" ? input : invalid("Expected string."),
  );
export const schema = {
  string,
  number: () =>
    new Schema<number>({ type: "number" }, (input) =>
      typeof input === "number" && Number.isFinite(input)
        ? input
        : invalid("Expected finite number."),
    ),
  boolean: () =>
    new Schema<boolean>({ type: "boolean" }, (input) =>
      typeof input === "boolean" ? input : invalid("Expected boolean."),
    ),
  enum: <const T extends readonly string[]>(values: T) =>
    new Schema<T[number]>({ type: "string", enum: [...values] }, (input) =>
      typeof input === "string" && values.includes(input) ? input : invalid("Invalid enum value."),
    ),
  array: <T>(item: Schema<T>) =>
    new Schema<T[]>({ type: "array", items: item.json }, (input) =>
      Array.isArray(input) ? input.map((value) => item.parse(value)) : invalid("Expected array."),
    ),
  strictObject: <S extends Shape>(shape: S) => new ObjectSchema(shape),
  email: () => string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Expected email address."),
  url: () =>
    string().refine((value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    }, "Expected URL."),
  iso: {
    datetime: () =>
      string()
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, "Expected UTC ISO timestamp.")
        .refine(
          (value) =>
            Number.isFinite(Date.parse(value)) &&
            new Date(value).toISOString().slice(0, 19) === value.slice(0, 19),
          "Invalid timestamp.",
        ),
  },
};

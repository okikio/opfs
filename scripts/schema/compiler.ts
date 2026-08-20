import type { z } from "zod";

/** One runtime schema paired with the explicit TypeScript alias generated for it. */
export interface SchemaEntryType {
  /** Runtime Zod schema that remains the validation source of truth. */
  readonly schema: z.ZodType;
  /** Stable exported TypeScript alias written to the generated module. */
  readonly name: string;
}

/** Internal Zod v4 definition fields used by the project-local type compiler. */
interface ZodDefinitionType {
  readonly type: string;
  readonly innerType?: z.ZodType;
  readonly element?: z.ZodType;
  readonly options?: readonly z.ZodType[];
  readonly values?: readonly unknown[];
  readonly entries?: Readonly<Record<string, unknown>>;
  readonly shape?: Record<string, z.ZodType> | (() => Record<string, z.ZodType>);
}

/** Reads the stable Zod v4 core definition object used by schema tooling. */
function definition(schema: z.ZodType): ZodDefinitionType {
  const value = (schema as z.ZodType & { readonly _zod?: { readonly def?: unknown } })._zod?.def;
  if (typeof value !== "object" || value === null || !("type" in value) || typeof value.type !== "string") {
    throw new TypeError("Expected a Zod v4 schema definition.");
  }
  return value as ZodDefinitionType;
}

/** Converts a JavaScript literal into its TypeScript literal-type spelling. */
function literal(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  throw new TypeError(`Unsupported Zod literal value: ${String(value)}`);
}

/** Indents a multiline type expression by one generated object level. */
function indent(value: string): string {
  return value.split("\n").map((line) => `  ${line}`).join("\n");
}

/** Returns whether a child schema makes an object property optional. */
function optional(schema: z.ZodType): boolean {
  const type = definition(schema).type;
  return type === "optional" || type === "default";
}

/**
 * Compiles the Zod constructs used by OPFS into explicit structural TypeScript.
 *
 * Unknown schema kinds throw instead of degrading to `any`. Adding a new Zod
 * construct therefore requires an intentional compiler change before generated
 * public contracts can drift.
 */
function compileType(
  schema: z.ZodType,
  names: ReadonlyMap<z.ZodType, string>,
  root: boolean,
): string {
  if (!root) {
    const name = names.get(schema);
    if (name !== undefined) return name;
  }

  const def = definition(schema);
  switch (def.type) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "never":
      return "never";
    case "literal": {
      const values = def.values ?? [];
      if (values.length === 0) throw new TypeError("Zod literal has no values.");
      return values.map(literal).join(" | ");
    }
    case "enum": {
      const values = Object.values(def.entries ?? {});
      if (values.length === 0) throw new TypeError("Zod enum has no entries.");
      return values.map(literal).join(" | ");
    }
    case "optional":
    case "default": {
      if (def.innerType === undefined) throw new TypeError(`Zod ${def.type} has no inner type.`);
      return compileType(def.innerType, names, false);
    }
    case "readonly": {
      if (def.innerType === undefined) throw new TypeError("Zod readonly schema has no inner type.");
      const inner = compileType(def.innerType, names, false);
      if (definition(def.innerType).type === "array") return `readonly ${inner}`;
      return `Readonly<${inner}>`;
    }
    case "array": {
      if (def.element === undefined) throw new TypeError("Zod array has no element schema.");
      const element = compileType(def.element, names, false);
      return `${element.includes(" | ") ? `(${element})` : element}[]`;
    }
    case "union": {
      const options = def.options ?? [];
      if (options.length === 0) throw new TypeError("Zod union has no options.");
      return options.map((option) => compileType(option, names, false)).join(" | ");
    }
    case "object": {
      const rawShape = def.shape;
      const shape = typeof rawShape === "function" ? rawShape() : rawShape;
      if (shape === undefined) throw new TypeError("Zod object has no shape.");
      const fields = Object.entries(shape).map(([name, child]) => {
        const value = compileType(child, names, false);
        const suffix = optional(child) ? "?" : "";
        const type = optional(child) && !value.includes("undefined") ? `${value} | undefined` : value;
        return `  ${JSON.stringify(name)}${suffix}: ${type};`;
      });
      return `{\n${fields.join("\n")}\n}`;
    }
    default:
      throw new TypeError(`Unsupported Zod schema kind '${def.type}'.`);
  }
}

/** Generates the complete checked-in schema-derived type module. */
export function compileSchemas(entries: readonly SchemaEntryType[]): string {
  const names = new Map<z.ZodType, string>();
  for (const entry of entries) names.set(entry.schema, entry.name);

  const declarations = entries.map((entry) => {
    const type = compileType(entry.schema, names, true);
    return `export type ${entry.name} = ${type};`;
  });

  return [
    "// @generated by scripts/schema.ts. DO NOT EDIT.",
    "// Zod schemas are the runtime source of truth. Regenerate with `deno task schema`.",
    "",
    declarations.join("\n\n"),
    "",
  ].join("\n");
}

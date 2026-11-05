/** Bounded RFC9651 field admission for the HTTP upload draft; not a public serializer. @module */

/** Preserve numeric kind: a decimal or date is never an upload integer merely because its Number is integral. */
export type FieldType =
  | { readonly kind: "integer" | "decimal" | "date"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "string" | "token" | "display"; readonly value: string }
  | { readonly kind: "bytes"; readonly value: Uint8Array }
  | { readonly kind: "inner"; readonly value: readonly FieldType[] };

/** Unknown parameter values still need complete grammar validation; quoted commas/semicolons cannot be split safely. */
class Fields {
  readonly text: string;
  at = 0;
  #nodes = 0;
  constructor(text: string) {
    if (text.length > 8192) throw new RangeError("Upload structured field exceeds 8 KiB.");
    for (let at = 0; at < text.length; at++) if (text.charCodeAt(at) > 127) this.fail();
    this.text = text;
  }
  fail(): never {
    throw new SyntaxError("Malformed RFC9651 upload field.");
  }
  node(): void {
    if (++this.#nodes > 64) throw new RangeError("Upload field exceeds 64 members, items or parameters.");
  }
  space(): void {
    while (this.text[this.at] === " ") this.at++;
  }
  ows(): void {
    while (this.text[this.at] === " " || this.text[this.at] === "\t") this.at++;
  }
  key(): string {
    const start = this.at;
    if (!/[a-z*]/.test(this.text[this.at] ?? "")) this.fail();
    this.at++;
    while (/[a-z0-9_.*-]/.test(this.text[this.at] ?? "")) this.at++;
    return this.text.slice(start, this.at);
  }
  parameters(): void {
    while (this.text[this.at] === ";") {
      this.node();
      this.at++;
      this.space();
      this.key();
      if (this.text[this.at] === "=") {
        this.at++;
        this.bare();
      }
    }
  }
  number(date = false): FieldType {
    const start = this.at;
    if (this.text[this.at] === "-") this.at++;
    const digits = this.at;
    while (/[0-9]/.test(this.text[this.at] ?? "")) this.at++;
    const count = this.at - digits;
    if (count === 0 || count > 15) this.fail();
    let kind: "integer" | "decimal" | "date" = date ? "date" : "integer";
    if (this.text[this.at] === ".") {
      if (date || count > 12) this.fail();
      kind = "decimal";
      this.at++;
      const fraction = this.at;
      while (/[0-9]/.test(this.text[this.at] ?? "")) this.at++;
      if (this.at - fraction < 1 || this.at - fraction > 3) this.fail();
    }
    return { kind, value: Number(this.text.slice(start, this.at)) };
  }
  bare(): FieldType {
    const first = this.text[this.at];
    if (first === "-" || /[0-9]/.test(first ?? "")) return this.number();
    if (first === "?") {
      this.at++;
      const value = this.text[this.at++];
      if (value !== "0" && value !== "1") this.fail();
      return { kind: "boolean", value: value === "1" };
    }
    if (first === "@") {
      this.at++;
      return this.number(true);
    }
    if (first === '"') {
      this.at++;
      let value = "";
      while (this.at < this.text.length) {
        let c = this.text[this.at++]!;
        if (c === '"') return { kind: "string", value };
        if (c === "\\") {
          c = this.text[this.at++] ?? "";
          if (c !== '"' && c !== "\\") this.fail();
        }
        if (c.length !== 1 || c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126) this.fail();
        value += c;
      }
      this.fail();
    }
    if (first === "%" && this.text[this.at + 1] === '"') {
      this.at += 2;
      const bytes: number[] = [];
      while (this.at < this.text.length) {
        const c = this.text[this.at++]!;
        if (c === '"') {
          try {
            return {
              kind: "display",
              value: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes)),
            };
          } catch {
            this.fail();
          }
        }
        if (c === "%") {
          const hex = this.text.slice(this.at, this.at + 2);
          if (!/^[0-9a-f]{2}$/.test(hex)) this.fail();
          bytes.push(parseInt(hex, 16));
          this.at += 2;
        } else {
          const n = c.charCodeAt(0);
          if (n < 32 || n > 126) this.fail();
          bytes.push(n);
        }
      }
      this.fail();
    }
    if (first === ":") {
      this.at++;
      const start = this.at;
      while (this.at < this.text.length && this.text[this.at] !== ":") this.at++;
      if (this.text[this.at++] !== ":") this.fail();
      const encoded = this.text.slice(start, this.at - 1);
      if (!/^[A-Za-z0-9+/=]*$/.test(encoded)) this.fail();
      let binary: string;
      try {
        binary = atob(encoded);
      } catch {
        this.fail();
      }
      return { kind: "bytes", value: Uint8Array.from(binary, (c) => c.charCodeAt(0)) };
    }
    if (/[A-Za-z*]/.test(first ?? "")) {
      const start = this.at++;
      while (/[!#$%&'*+\-.^_`|~A-Za-z0-9:/]/.test(this.text[this.at] ?? "")) this.at++;
      return { kind: "token", value: this.text.slice(start, this.at) };
    }
    return this.fail();
  }
  item(): FieldType {
    this.node();
    const value = this.bare();
    this.parameters();
    return value;
  }
  member(): FieldType {
    if (this.text[this.at] !== "(") return this.item();
    this.node();
    this.at++;
    const value: FieldType[] = [];
    while (this.at < this.text.length) {
      this.space();
      if (this.text[this.at] === ")") {
        this.at++;
        this.parameters();
        return { kind: "inner", value };
      }
      value.push(this.item());
      if (this.text[this.at] !== " " && this.text[this.at] !== ")") this.fail();
    }
    return this.fail();
  }
  end(): void {
    this.space();
    if (this.at !== this.text.length) this.fail();
  }
}
/** Full item consumption matters: two combined header lines are not one offset or boolean. */
export function readField(text: string): FieldType {
  const parser = new Fields(text);
  parser.space();
  const value = parser.item();
  parser.end();
  return value;
}
/** RFC9651 dictionaries retain the final duplicate value; every occurrence still consumes bounded parser work. */
export function readDictionary(text: string): ReadonlyMap<string, FieldType> {
  const parser = new Fields(text);
  const out = new Map<string, FieldType>();
  parser.space();
  while (parser.at < text.length) {
    parser.node();
    const key = parser.key();
    let value: FieldType;
    if (text[parser.at] === "=") {
      parser.at++;
      value = parser.member();
    } else {
      parser.parameters();
      value = { kind: "boolean", value: true };
    }
    out.set(key, value);
    parser.ows();
    if (parser.at === text.length) return out;
    if (text[parser.at++] !== ",") parser.fail();
    parser.ows();
    if (parser.at === text.length) parser.fail();
  }
  return out;
}

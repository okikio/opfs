import { parse } from "@std/xml/parse";
import { stringify } from "@std/xml/stringify";
import type { XmlElement, XmlNode, XmlTextNode } from "@std/xml/types";

/**
 * Parses one small provider control document into an XML element tree.
 *
 * S3 and Azure use XML for control-plane responses such as list pages,
 * multipart upload state, and structured service failures. File payload bytes
 * never pass through this parser. `@std/xml` therefore owns XML syntax,
 * entity decoding, and malformed-document rejection while provider modules own
 * the meaning of individual elements.
 *
 * The parser keeps DOCTYPE rejection enabled. Provider control documents do
 * not require a DTD, so accepting one would add parser work without adding a
 * valid storage protocol use case.
 */
export function parseXmlRoot(value: string): XmlElement {
  // The byte owner bounds network input. Bound direct parser callers too, and
  // let the upstream parser reject depth before constructing the next element.
  if (value.length > 8 * 1024 * 1024) throw new RangeError("Provider XML exceeds the control text ceiling.");
  const root = parse(value, { trackPosition: false, maxDepth: 64, maxAttributes: 128 }).root;
  const stack: XmlNode[] = [root];
  let nodes = 0;
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (++nodes > 100_000) throw new RangeError("Provider XML exceeds the control node ceiling.");
    if (node.type === "element") {
      for (const child of node.children) stack.push(child);
    }
  }
  return root;
}

/**
 * Creates one XML text node for a provider request document.
 *
 * The text remains unescaped here. `@std/xml/stringify` performs entity
 * escaping when the document is serialized, which avoids protocol modules
 * maintaining their own partial XML escaping rules.
 */
export function createXmlText(text: string): XmlTextNode {
  return { type: "text", text };
}

/**
 * Creates one namespace-free XML element for a provider control document.
 *
 * S3 multipart request bodies and Azure block-list request bodies use ordinary
 * element names without namespace prefixes. Keeping this constructor in one
 * place makes those request builders structural and lets `@std/xml` own the
 * actual serialization rules.
 */
export function createXmlElement(
  name: string,
  children: readonly XmlNode[] = [],
  attributes: Readonly<Record<string, string>> = {},
): XmlElement {
  return {
    type: "element",
    name: { raw: name, local: name },
    attributes,
    children,
  };
}

/**
 * Serializes one provider control element as compact XML.
 *
 * The provider APIs do not require an XML declaration or pretty-printing.
 * Compact output reduces request bytes and, more importantly, delegates text
 * and attribute escaping to `@std/xml` instead of protocol-specific string
 * templates.
 */
export function stringifyXml(root: XmlElement): string {
  return stringify(root, { declaration: false });
}

/** Returns one element's decoded text, including text nested below child elements. */
function getText(node: XmlNode): string {
  const stack: XmlNode[] = [node];
  const text: string[] = [];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.type === "text" || item.type === "cdata") text.push(item.text);
    else if (item.type === "element") {
      for (let index = item.children.length - 1; index >= 0; index--) stack.push(item.children[index]!);
    }
  }
  return text.join("");
}

/**
 * Finds descendant XML elements by local name.
 *
 * Provider response namespaces can vary between compatible services. Matching
 * the local element name lets the S3/Azure response readers keep the semantic
 * element contract without depending on a particular namespace prefix.
 */
export function getXmlElements(node: XmlNode, name: string): XmlElement[] {
  const output: XmlElement[] = [];
  const stack: XmlNode[] = [node];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.type !== "element") continue;
    if (item.name.local === name) output.push(item);
    for (let index = item.children.length - 1; index >= 0; index--) stack.push(item.children[index]!);
  }
  return output;
}

/** Returns trimmed text from the first descendant element with one local name. */
export function getXmlValue(node: XmlNode, name: string): string | undefined {
  const value = getXmlElements(node, name)[0];
  if (value === undefined) return undefined;
  const text = getText(value).trim();
  return text.length === 0 ? undefined : text;
}

/** Returns decoded identity text without trimming or collapsing an empty element. */
export function getXmlText(node: XmlNode, name: string): string | undefined {
  const value = getXmlElements(node, name)[0];
  return value === undefined ? undefined : getText(value);
}

/** Reads one protocol-required direct scalar child. Descendant lookup cannot
 * authorize a publication: repeated, nested or empty fields are ambiguous.
 */
export function getXmlScalar(node: XmlElement, name: string): string {
  const values = getXmlElements(node, name);
  const value = values[0];
  if (
    values.length !== 1 || value === undefined || !node.children.includes(value) ||
    value.children.some((child) => child.type === "element")
  ) {
    throw new SyntaxError(`Acknowledgement requires exactly one direct scalar ${name}.`);
  }
  const text = getText(value).trim();
  if (text.length === 0) throw new SyntaxError(`Acknowledgement requires a nonempty ${name}.`);
  return text;
}

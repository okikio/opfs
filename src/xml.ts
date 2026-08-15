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
  return parse(value, { trackPosition: false }).root;
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
  if (node.type === "text" || node.type === "cdata") return node.text;
  if (node.type === "comment") return "";
  return node.children.map(getText).join("");
}

/**
 * Finds descendant XML elements by local name.
 *
 * Provider response namespaces can vary between compatible services. Matching
 * the local element name lets the S3/Azure response readers keep the semantic
 * element contract without depending on a particular namespace prefix.
 */
export function getXmlElements(node: XmlNode, name: string): XmlElement[] {
  if (node.type !== "element") return [];
  const output: XmlElement[] = node.name.local === name ? [node] : [];
  for (const child of node.children) output.push(...getXmlElements(child, name));
  return output;
}

/** Returns trimmed text from the first descendant element with one local name. */
export function getXmlValue(node: XmlNode, name: string): string | undefined {
  const value = getXmlElements(node, name)[0];
  if (value === undefined) return undefined;
  const text = getText(value).trim();
  return text.length === 0 ? undefined : text;
}

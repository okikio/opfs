import { FileSystemError } from "./error.ts";
import type { PathType } from "./schema.ts";

export type { PathType } from "./schema.ts";

/** Canonical virtual filesystem root. */
export const ROOT_PATH = "/";

/** Creates the package error used when virtual-path normalization cannot continue safely. */
function failPath(path: string, message: string): never {
  throw new FileSystemError("invalid-path", "path", path, message);
}

/**
 * Normalizes one application path into the adapter-independent path format.
 *
 * Both `a/b` and `/a/b` become `/a/b`. The function resolves `.` and `..`, but
 * rejects traversal above `/`. Backslashes are rejected instead of being
 * interpreted as separators. This keeps the same virtual path on Windows,
 * Unix, OPFS, databases, and key-value stores.
 *
 * @example
 * ```ts
 * normalizePath("reports/../cache/data.bin"); // "/cache/data.bin"
 * ```
 */
export function normalizePath(path: string): PathType {
  if (typeof path !== "string") throw new TypeError("Filesystem paths must be strings.");
  if (path.includes("\0")) failPath(path, "Filesystem paths cannot contain NUL characters.");
  if (path.includes("\\")) failPath(path, "Filesystem paths cannot contain backslashes.");

  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) failPath(path, "Filesystem paths cannot escape above the virtual root.");
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length === 0 ? ROOT_PATH : `/${parts.join("/")}`;
}

/** Splits a validated path into entry names. */
export function splitPath(path: string): string[] {
  const normalized = normalizePath(path);
  return normalized === ROOT_PATH ? [] : normalized.slice(1).split("/");
}

/** Joins path fragments and normalizes the result. */
export function joinPath(...parts: string[]): PathType {
  return parts.length === 0 ? ROOT_PATH : normalizePath(parts.join("/"));
}

/** Returns the canonical parent path. The root is its own parent. */
export function dirname(path: string): PathType {
  const parts = splitPath(path);
  return parts.length <= 1 ? ROOT_PATH : `/${parts.slice(0, -1).join("/")}`;
}

/** Returns the final entry name, or an empty string for the root. */
export function basename(path: string): string {
  return splitPath(path).at(-1) ?? "";
}

/** Returns true when `ancestor` strictly contains `path`. */
export function isAncestorPath(ancestor: string, path: string): boolean {
  const parent = normalizePath(ancestor);
  const child = normalizePath(path);
  if (parent === child) return false;
  return parent === ROOT_PATH || child.startsWith(`${parent}/`);
}

/**
 * Validates one File System API entry name.
 *
 * Directory and file handle methods accept one name, not a path. `/`, `.` and
 * `..` therefore fail before an adapter receives them.
 */
export function validateName(name: string): string {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new TypeError(`'${name}' is not a valid filesystem entry name.`);
  }
  return name;
}

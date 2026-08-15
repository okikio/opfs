import { SEPARATOR, resolve } from "@std/path";
import { normalizePath } from "../path.ts";

/**
 * Maps canonical virtual paths below one configured host directory.
 *
 * The class exists so the mapping operation has one named implementation
 * instead of a closure hidden inside {@link createLocalPath}. The configured
 * root is resolved once. Every later path is normalized through the virtual
 * path contract and then checked against the resolved host-root prefix.
 */
class LocalPath {
  /** Absolute host directory represented by virtual `/`. */
  readonly #root: string;
  /** Root plus the native path separator, used for descendant checks. */
  readonly #prefix: string;

  /** Resolves the configured host root once for all later mappings. */
  constructor(root: string) {
    this.#root = resolve(root);
    this.#prefix = this.#root.endsWith(SEPARATOR) ? this.#root : `${this.#root}${SEPARATOR}`;
  }

  /**
   * Converts one virtual path to its native host path.
   *
   * `normalizePath()` rejects virtual root escape before native resolution.
   * The second prefix check is still required because host path rules can
   * differ from the portable virtual namespace, especially on Windows.
   */
  get(path: string): string {
    const virtual = normalizePath(path);
    if (virtual === "/") return this.#root;

    const output = resolve(this.#root, `.${virtual}`);
    if (output !== this.#root && !output.startsWith(this.#prefix)) {
      throw new TypeError(`Virtual path '${path}' resolved outside host root '${this.#root}'.`);
    }
    return output;
  }
}

/**
 * Creates the host-path mapper shared by the Deno, Node, and Bun adapters.
 *
 * `@std/path` selects the current operating-system path rules. The mapper then
 * applies the OPFS virtual-path invariant on every conversion, so a virtual
 * path can never expose a host path outside `root`.
 *
 * The returned function is bound to one immutable {@link LocalPath} instance.
 * Callers therefore keep the compact function API without placing the actual
 * mapping implementation inside this factory.
 *
 * @example
 * ```ts
 * const getHostPath = createLocalPath("./data");
 * const path = getHostPath("/cache/result.bin");
 * ```
 */
export function createLocalPath(root: string): (path: string) => string {
  const mapper = new LocalPath(root);
  return mapper.get.bind(mapper);
}

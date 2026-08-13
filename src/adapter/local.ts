import { resolve, sep } from "node:path";
import { normalizePath } from "../path.ts";

/** Internal validated host-root mapping shared by Deno, Node, and Bun adapters. */
export function createLocalPath(root: string): (path: string) => string {
  const absoluteRoot = resolve(root);
  const rootPrefix = absoluteRoot.endsWith(sep) ? absoluteRoot : `${absoluteRoot}${sep}`;
  return (path: string): string => {
    const virtual = normalizePath(path);
    if (virtual === "/") return absoluteRoot;
    const output = resolve(absoluteRoot, `.${virtual}`);
    if (output !== absoluteRoot && !output.startsWith(rootPrefix)) {
      throw new TypeError(`Virtual path '${path}' resolved outside host root '${absoluteRoot}'.`);
    }
    return output;
  };
}

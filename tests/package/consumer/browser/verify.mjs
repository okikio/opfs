/** Execute the generated memory-only bundle and retire its owned filesystem. */
import { smoke } from "./browser-bundle.js";
const [fileSystem] = smoke();
try {
  await fileSystem.writeFile("/bundle.txt", "memory-only");
  if (new TextDecoder().decode(await fileSystem.readFile("/bundle.txt")) !== "memory-only") {
    throw new Error("Memory-only bundle behavior changed");
  }
} finally {
  await fileSystem[Symbol.asyncDispose]();
}

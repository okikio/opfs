/** Record the native Node image tool as data; no candidate or downloaded setup is imported. */
import { createHash } from "node:crypto";
import { constants, copyFileSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { execPath, version } from "node:process";

const license = "/usr/local/LICENSE";
const files: Record<string, string> = {};
for (const path of [realpathSync(execPath), license]) {
  if (!statSync(path).isFile() || statSync(path).size > 160 * 1024 * 1024) {
    throw new Error("Native image tool or license exceeds admission policy.");
  }
  files[path] = createHash("sha256").update(readFileSync(path)).digest("hex");
}
copyFileSync(license, "/receipts/licenses/node-image-LICENSE.txt", constants.COPYFILE_EXCL);
writeFileSync(
  "/receipts/node.json",
  JSON.stringify({ version, executable: realpathSync(execPath), files }, null, 2) + "\n",
  { flag: "wx" },
);

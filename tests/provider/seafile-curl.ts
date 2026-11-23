import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";

/**
 * Native curl supplies HTTP and multipart framing independently of the candidate.
 * This small authored recipe is not a replay of the former Python SDK oracle.
 * Only the disposable server's exact authority can receive credentials or bytes.
 */
export function seafileCurl(endpoint: string, token: string, operation: string, args: readonly string[]): unknown {
  const origin = new URL(endpoint).origin;
  function request(url: URL, options: readonly string[] = [], input?: Buffer, authenticated = true): Buffer {
    if (url.origin !== origin || url.username || url.password || url.hash) {
      throw new Error("Native Seafile fixture URL escaped its authority.");
    }
    try {
      return execFileSync("curl", [
        "--disable",
        "--globoff",
        "--silent",
        "--show-error",
        "--fail",
        "--max-time",
        "30",
        "--connect-timeout",
        "5",
        "--proto",
        "=http",
        "--noproxy",
        "*",
        ...(authenticated ? ["--header", `Authorization: Token ${token}`] : []),
        ...options,
        "--url",
        url.href,
      ], { input, timeout: 35_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      // child_process errors contain argv, including the fixture token and capability.
      throw new Error("Native Seafile curl request failed or exceeded its deadline/output bound.");
    }
  }
  function json(url: URL, options: readonly string[] = [], input?: Buffer): unknown {
    return JSON.parse(request(url, options, input).toString("utf8")) as unknown;
  }
  if (operation === "create") {
    if (args.length < 1 || args.length > 2) throw new TypeError("Native create requires a name and optional password.");
    const created = json(new URL("api2/repos/", endpoint), [
      "--data-urlencode",
      `name=${args[0]}`,
      ...(args[1] === undefined ? [] : ["--data-urlencode", `passwd=${args[1]}`]),
    ]);
    if (
      typeof created !== "object" || created === null || !("repo_id" in created) || typeof created.repo_id !== "string"
    ) {
      throw new Error("Native Seafile create response omitted its library identity.");
    }
    return { id: created.repo_id };
  }
  const [library, value] = args;
  if (
    args.length !== 2 || typeof library !== "string" || typeof value !== "string" || !/^[a-f0-9-]{36}$/u.test(library)
  ) {
    throw new TypeError("Native file operations require a library identity and value.");
  }
  const path = operation === "upload" ? "upload-link" : operation === "read" ? "file" : null;
  if (path === null) throw new TypeError("Unknown native Seafile operation.");
  const link = new URL(`api2/repos/${library}/${path}/`, endpoint);
  link.search = new URLSearchParams({ p: operation === "upload" ? "/" : value, reuse: "0" }).toString();
  const capability = json(link);
  if (typeof capability !== "string") throw new Error("Native Seafile omitted its capability URL.");
  const url = new URL(capability);
  if (url.origin !== origin || !url.pathname.startsWith("/seafhttp/")) {
    throw new Error("Native Seafile capability escaped the owned file service.");
  }
  if (operation === "read") return { bytes: request(url, [], undefined, false).toString("base64") };
  if (value.length > 65536) throw new Error("Native fixture input exceeds 48 KiB.");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > 49152 || bytes.toString("base64") !== value) {
    throw new Error("Native fixture upload requires canonical base64 for at most 48 KiB.");
  }
  url.searchParams.set("ret-json", "1");
  return json(url, ["--form-string", "parent_dir=/", "--form", "file=@-;filename=oracle-input"], bytes);
}

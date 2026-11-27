export interface CliIo {
  readonly stdout: WritableStream<Uint8Array>;
  readonly stderr: WritableStream<Uint8Array>;
}

const encoder = new TextEncoder();

async function write(
  stream: WritableStream<Uint8Array>,
  value: string,
): Promise<void> {
  const writer = stream.getWriter();
  try {
    await writer.write(encoder.encode(value));
  } finally {
    writer.releaseLock();
  }
}

export async function main(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  if (args.includes("--help")) {
    await write(io.stdout, "Usage: example [--help]\n");
    return 0;
  }

  if (args.length > 0) {
    await write(io.stderr, `Unknown argument: ${args[0]}\n`);
    return 2;
  }

  await write(io.stdout, "ok\n");
  return 0;
}

if (import.meta.main) {
  Deno.exit(
    await main(Deno.args, {
      stdout: Deno.stdout.writable,
      stderr: Deno.stderr.writable,
    }),
  );
}

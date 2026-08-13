import { bench, do_not_optimize, group, run } from 'mitata';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileSystem } from '../mod.ts';
import { createMemoryAdapter } from '../src/adapter/memory.ts';
import { createNodeAdapter } from '../src/adapter/node.ts';

const chunk = new Uint8Array(64 * 1024);

/** Writes one native file through a single long-lived positional resource. */
async function native(bytes: number): Promise<number> {
  const root = await mkdtemp(join(tmpdir(), 'opfs-bench-'));
  const fileSystem = createFileSystem(createNodeAdapter({ root }), { coordination: 'local' });
  try {
    await fileSystem.ensureFile('/output.bin');
    const file = await fileSystem.openWritableFile('/output.bin');
    try {
      for (let at = 0; at < bytes; at += chunk.byteLength) await file.write(chunk, { at });
      await file.flush();
      await file.close();
    } catch (error) {
      await file.abort(error);
      throw error;
    }
    const stat = await fileSystem.stat('/output.bin');
    return stat.kind === 'file' ? stat.size : 0;
  } finally {
    await fileSystem.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** Exercises the intentionally expensive record-update path as a pathological comparison. */
async function record(bytes: number): Promise<number> {
  const fileSystem = createFileSystem(createMemoryAdapter(), { coordination: 'local' });
  try {
    for (let at = 0; at < bytes; at += chunk.byteLength) {
      await fileSystem.writeFile('/output.bin', chunk, { mode: 'update', at, parents: true });
    }
    const stat = await fileSystem.stat('/output.bin');
    return stat.kind === 'file' ? stat.size : 0;
  } finally {
    await fileSystem.close();
  }
}

group('@okikio/opfs positional output', () => {
  bench('Node positional 16 MiB', async () => do_not_optimize(await native(16 * 1024 * 1024))).gc('once');
  bench('record update 1 MiB pathological', async () => do_not_optimize(await record(1024 * 1024))).gc('once');
});

await run();

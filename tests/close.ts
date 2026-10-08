/**
 * Attempts every fixture-owned release in the supplied order.
 *
 * A drain or database close failure cannot skip later facade closes/deletions.
 * The caller passes its original failure separately, including undefined.
 */
export async function close(
  releases: readonly (() => void | Promise<unknown>)[],
  primary: readonly unknown[] = [],
): Promise<void> {
  const failures = [...primary];
  for (const release of releases) {
    try {
      await release();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Fixture release failed.", { cause: failures[0] });
  }
}

/** Protects acquisitions inside the body, then closes their owners in reverse order. */
export async function withReleases<T>(
  action: (releases: Array<() => void | Promise<unknown>>) => Promise<T>,
): Promise<T> {
  const releases: Array<() => void | Promise<unknown>> = [];
  let failed = false;
  let primary: unknown;
  try {
    return await action(releases);
  } catch (error) {
    failed = true;
    primary = error;
    throw error;
  } finally {
    await close(releases.toReversed(), failed ? [primary] : []);
  }
}

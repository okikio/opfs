/**
 * Release owned resources in reverse order while retaining the original failure first.
 * @param {readonly (() => Promise<unknown>)[]} releases Cleanup in acquisition order.
 * @param {unknown[]} [failures] The primary failure precedes any retirement failures.
 * @returns {Promise<void>} Rejects after every cleanup has been attempted.
 */
export async function finish(releases, failures = []) {
  for (const release of releases.toReversed()) {
    try {
      await release();
    } catch (reason) {
      failures.push(reason);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Package fixture and owned cleanup failed.", {
      cause: failures[0],
    });
  }
}

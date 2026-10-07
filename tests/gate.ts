/** Bounds a test gate while always clearing its watchdog; the delay is not a performance assertion. */
export async function within<Value>(promise: Promise<Value>, operation: string, timeout = 5000): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${operation}.`)), timeout);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

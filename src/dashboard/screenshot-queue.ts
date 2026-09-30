// Each screenshot opens a provider review. Serialize visible rows instead of
// bursting requests as the IntersectionObserver discovers them together.
// Canceled/unmounted rows never start a queued request. No evidence is cached.
export function createScreenshotQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(
    load: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const result = tail.then(() => {
      signal.throwIfAborted();
      return load();
    });
    tail = result.catch(() => {});
    return result;
  };
}

export const screenshotQueue = createScreenshotQueue();

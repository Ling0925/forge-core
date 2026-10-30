/**
 * Ordered releases for a service assembled from several owned resources.
 * If assembly fails part-way, `unwind` releases what was already opened in
 * reverse order; every release runs even when an earlier one throws, and
 * release failures never mask the original startup error.
 */
export function createStartupCleanup() {
  const releases: (() => unknown)[] = [];
  return {
    /** Register a release for a resource that has just been opened. */
    defer(release: () => unknown): void {
      releases.push(release);
    },
    async unwind(): Promise<void> {
      for (let release = releases.pop(); release; release = releases.pop()) {
        try {
          await release();
        } catch {
          /* The startup error is the one worth reporting. */
        }
      }
    },
  };
}

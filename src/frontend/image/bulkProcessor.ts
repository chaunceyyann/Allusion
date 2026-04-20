/**
 * Generic bulk processing utility that iterates over a list of items,
 * calls a processing function for each, catches individual errors,
 * and tracks progress.
 *
 * Used by AutoTagger.bulkAutoTag to ensure all files are attempted
 * even when some fail during inference.
 */
export async function bulkProcess<T>(
  items: readonly T[],
  processItem: (item: T) => Promise<void>,
  onProgress?: (processed: number, total: number) => void,
): Promise<{ attempted: number; errors: number }> {
  let attempted = 0;
  let errors = 0;
  for (const item of items) {
    try {
      await processItem(item);
    } catch {
      errors++;
    }
    attempted++;
    onProgress?.(attempted, items.length);
  }
  return { attempted, errors };
}

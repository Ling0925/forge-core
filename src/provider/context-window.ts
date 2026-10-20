const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;

/** Optional catalog metadata, not a guess from the model's name or output cap.
 * Gateways sometimes encode integer token counts as strings. Invalid optional
 * fields must not make an otherwise usable model catalog fail to load. */
export function readModelContextWindow(model: unknown): number | null {
  const fields = record(model);
  if (!fields) return null;
  const topProvider = record(fields.top_provider);
  for (const raw of [fields.context_length, fields.context_window, fields.max_model_len,
    fields.max_input_tokens, topProvider?.context_length]) {
    const value = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
    if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 10000000) return value;
  }
  return null;
}

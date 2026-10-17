import { toolCallPreviewSchema, type ToolCallPreview } from "../shared/schemas";

/** Bounded, display-only snapshots: first sight is immediate, updates are coalesced. */
export function createToolPreviewStream(
  prefix: string,
  emit: (previewId: string, preview: ToolCallPreview) => void,
) {
  const latest = new Map<number, ToolCallPreview>();
  const pending = new Set<number>();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const id = (index: number) => `${prefix}:${index}`;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    for (const index of pending) {
      const preview = latest.get(index);
      if (preview) emit(id(index), preview);
    }
    pending.clear();
  };
  return {
    push(raw: ToolCallPreview) {
      if (closed) return;
      const parsed = toolCallPreviewSchema.safeParse(raw);
      if (!parsed.success) return;
      const preview = parsed.data;
      const previous = latest.get(preview.index);
      if (previous?.name === preview.name && previous.argumentsChars === preview.argumentsChars) return;
      latest.set(preview.index, preview);
      if (!previous) emit(id(preview.index), preview);
      else {
        pending.add(preview.index);
        timer ??= setTimeout(flush, 80);
      }
    },
    close() {
      closed = true;
      flush();
    },
    id(index: number): string | undefined {
      return latest.has(index) ? id(index) : undefined;
    },
    get size() { return latest.size; },
  };
}

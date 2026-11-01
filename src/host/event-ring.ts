import type { RunEvent } from "../shared";

export class EventRing {
  private readonly entries = new Map<
    number,
    { cursor: number; json: string; bytes: number }
  >();
  private bytes = 0;
  cursor = 0;

  constructor(
    private readonly maxEvents: number,
    private readonly maxBytes: number,
  ) {}

  get oldest(): number {
    return this.entries.keys().next().value ?? this.cursor + 1;
  }

  append(data: RunEvent) {
    const json = JSON.stringify(data);
    const entry = {
      cursor: ++this.cursor,
      json,
      bytes: Buffer.byteLength(json),
    };
    this.entries.set(entry.cursor, entry);
    this.bytes += entry.bytes;
    for (const [cursor, oldest] of this.entries) {
      if (this.entries.size <= this.maxEvents && this.bytes <= this.maxBytes)
        break;
      this.entries.delete(cursor);
      this.bytes -= oldest.bytes;
    }
    return entry;
  }

  after(cursor: number, through = this.cursor) {
    return [...this.entries.values()].filter(
      (entry) => entry.cursor > cursor && entry.cursor <= through,
    );
  }
}

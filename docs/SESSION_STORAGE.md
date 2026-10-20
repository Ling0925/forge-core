# Incremental session persistence

The optional `SessionStore.incremental` port is implemented by the disk store. Legacy and in-memory adapters can continue implementing `get`/`save`. `createSessionWriter` uses the incremental port in runtime checkpoints, locked session mutations and asynchronous title updates.

## Contract and recovery

- `read(id)` returns a validated snapshot and an opaque durable revision.
- `commit(id, mutation)` requires the existing session lock and a matching `baseRevision`. Metadata is a complete replacement. Each record array explicitly keeps a prefix and appends a validated tail; a shorter prefix replaces/truncates history. A stale token is rejected with `busy`, never silently rebased.
- `changesSince(id, revision)` returns an ordered chain of changes from a retained revision, an empty list for the current revision, or an explicit full snapshot after a generation/checkpoint change. Forks have independent identity and revisions. Applying each change requires checking its `before` token against the current token.
- v2 journal records hash the previous record hash and new payload, not the complete accumulated transcript. v1 journals remain readable and retain their original full-snapshot integrity checks. Generation IDs and atomic rename/fsync remain the commit boundary. Temporary files are ignored.
- Warm reads check base identity and every committed record's inode, size, mtime and ctime, rather than trusting directory mtime alone. Unchanged records are reused; newly committed records are parsed and validated. In-place tampering forces revalidation and integrity rejection. Cross-process changes and checkpoint replacement are visible.
- Native tool-call/result pairing is tracked incrementally across appended messages. Replaced message history deliberately rechecks pairing. Event/session relationships, array bounds and metadata validation still apply.
- Full checkpoints are retained at terminal transitions or terminal body changes, legacy migration, 64 journal records or 4 MiB of journal payload. Later metadata-only edits to a completed session may use the journal. Old generations remain recovery material. Summary-list indexing is unchanged.
- The cache retains four sessions and a maximum of 64 records per active generation. The disk store does not create another transcript copy for each version.

## Cost boundaries

Warm metadata commits and revision reads avoid re-serializing, re-hashing and revalidating historical message bodies. Reads still perform bounded filesystem metadata checks. Appending/replacing arrays copies record references, and the runtime writer finds shared prefixes by reference identity; this is not an O(1) persistent-vector implementation. First loads, checkpoints, explicit replacements and legacy v1 replays may process complete history. Compatibility `save(snapshot)` intentionally retains whole-input validation. HTTP snapshot encoding still has its separate fingerprint cost; these benchmarks do not measure browser rendering or end-to-end HTTP latency.

## Reproducible synthetic benchmark

Run `node scripts/benchmark-session-store.mjs` from the repository after installing dependencies. An optional argument selects a baseline checkout with its dependencies available, for example `node scripts/benchmark-session-store.mjs /path/to/baseline`.

Measured on Linux / Node v22.23.1 using baseline `86478a4`, five reads per case and the median in milliseconds. Fixtures use alternating user/assistant messages with 1,000-character content, approximately 0.98/4.92 MiB total snapshot size. Each case starts with a complete checkpoint and 0/8/16/32 metadata-only records. “Warm” reuses one store, “cold” opens a new store per sample; writes use the incremental port when supported and legacy `save` otherwise. Each write sample has a different title. Fixture directories are isolated and removed afterward. Measurements are local synthetic evidence, not production SLOs; filesystem and concurrent load can affect timings. No timing thresholds are unit-test assertions.

| Messages | Records | Warm get before → after (ms) | Cold get before → after (ms) | Metadata write before → after (ms) |
|---:|---:|---:|---:|---:|
| 1,000 | 0 | 33.58 → 0.4 | 21.23 → 46.22 | 12.49 → 4.18 |
| 1,000 | 8 | 69.2 → 0.58 | 61.83 → 31.44 | 14.52 → 2.82 |
| 1,000 | 16 | 98.87 → 0.96 | 96.07 → 29.56 | 13.16 → 2.73 |
| 1,000 | 32 | 183.39 → 1.89 | 181.65 → 42.87 | 13.69 → 3.55 |
| 5,000 | 0 | 80.22 → 0.3 | 77.97 → 90 | 50.72 → 2.98 |
| 5,000 | 8 | 234.69 → 0.44 | 247.67 → 126.79 | 60.94 → 3.2 |
| 5,000 | 16 | 503.94 → 0.65 | 660.07 → 114.9 | 59.68 → 6.06 |
| 5,000 | 32 | 1039.65 → 1.59 | 1031.59 → 122.16 | 78.44 → 4.7 |

Old and new executables must not write the same state directory concurrently. Older executables do not understand v2 journals; terminal base checkpoints remain ordinary v1 snapshots, but downgrading while a v2 generation is active requires explicit migration/recovery rather than discarding the journal.

### Concurrent read prefixes and writer ownership

The incremental reader preserves the concurrent-read contract introduced by
`1e83855`: immutable, hash-validated records from a captured generation form a
consistent prefix even while a writer appends, rotates a checkpoint, or creates
a temporary file. `get`, versioned `read`, `changesSince`, and summary fallback
need not wait for a quiet interval. A captured record's replacement or corruption
still invalidates the read; temporary files are never committed records.

A prefix whose base/directory changed is never installed as the writer cache or
written to the summary index. Writes retain stable-head validation and revision
CAS. Reading a valid older prefix does not grant permission to commit against an
advanced head. Old generations remain available for readers of that prefix.

### Recheck against master `6bcb776` (2026-10-20)

Linux / Node 22.23.1, five local synthetic samples, median milliseconds; no production SLO.

| Messages | Journal records | Warm get, master → updated | Cold get, master → updated | Metadata write, master → updated |
|---:|---:|---:|---:|---:|
| 1000 | 0 | 30.61 → 0.31 | 20.07 → 36.99 | 20.29 → 1.82 |
| 1000 | 8 | 86.18 → 0.37 | 59.57 → 25.17 | 13.18 → 1.17 |
| 1000 | 16 | 92.59 → 0.61 | 104.78 → 24.95 | 12.26 → 3 |
| 1000 | 32 | 136.68 → 4.69 | 161.39 → 58.53 | 9.63 → 3.15 |
| 5000 | 0 | 50.92 → 0.23 | 57.38 → 90.13 | 52.86 → 3.65 |
| 5000 | 8 | 247.66 → 0.4 | 212.7 → 92.6 | 48.77 → 4 |
| 5000 | 16 | 375.64 → 0.57 | 359.17 → 92.11 | 50.9 → 2.01 |
| 5000 | 32 | 663.77 → 1.1 | 632.58 → 88.64 | 45.69 → 3.47 |

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

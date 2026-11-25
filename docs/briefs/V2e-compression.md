# V2e — Recoverable compression, `ei_retrieve` (agent brief, DRAFT)

Start with Round 0 (`README.md`). Read `docs/briefs/V2-README.md`, then `docs/DESIGN.md` §6.4, §7.6, §11, §12.

**Branch:** `v2e-compression` from `v1.0.0`.

## Goal

Large tool outputs (test logs, build output, large JSON) take less context, and the agent can always get the exact original back. 100% byte-exact recovery is a hard gate. When anything goes wrong, the original passes through unchanged.

## Round 0 additions — decides whether this module can exist

Read the installed OMP extension API and record, with file and line: is there a hook that sees **another tool's result** before it reaches the model, and can it replace that result? Record also what OMP's own compaction does and when.

- If such a hook exists, Rounds 1–3 build it as below.
- If it does not, compression can only apply to this library's own outputs, which are already budgeted. Then **stop after Round 0** and report: the module is not buildable as designed. The owner decides whether to close it or to ask OMP for the hook. Do not build a wrapper tool that re-runs commands to compress them.

## Round 1 — store and codecs (`src/core/compression/`)

- CAS: original bytes written to `<cache>/cas/<sha256>` (file `0600`), fsync, read back and hash-checked **before** any compressed view is produced. A failed write or check → pass the original through.
- Codecs, each tested for exact round trip on recorded fixtures: repeated-line folding with counts; test-runner output kept to failures and summary; JSON arrays summarised by length and first/last items with key sets. The visible view always says it is compressed and gives the handle.
- Never compress: source code, diffs, error output the agent must act on (non-zero exit output keeps its last 200 lines verbatim), anything matching secret patterns (those are redacted, not stored), outputs under 8 KB.
- Retention: objects referenced by the current session are never evicted; others age out after 7 days; a cap on total size evicts oldest unreferenced first.

Risky cases, one test each:
- Property test over random byte strings and recorded outputs: retrieve(handle) == original, byte for byte, including invalid UTF-8 and CRLF.
- Disk full or read-only cache → original passes through, one warning in `ei_status`.
- A handle for an evicted object → clear `not-found`, never a different object.
- An output containing a token-like secret → never written to CAS in clear.

## Round 2 — hook, `ei_retrieve`, measurement

- The hook from Round 0, behind `compression.enabled: false` by default, with the size threshold and tool allowlist in config.
- `ei_retrieve` (`approval: 'read'`): handle, optional line range; returns the exact original (or the range), with the size and hash.
- **Value check (replaces the gate):** with OMP compaction on, 5 long sessions from the dogfood log replayed through `omp -p` with the module off and on: tokens used, number of compactions, and whether the agent still found the failing test. A saving with any lost failure is a fail.

## Round 3 — review (different vendor), then fix

**Review focus:** any path where the compressed view is shown without a verified stored original; non-exact recovery; secrets stored; compression of errors or code; behaviour when disabled.

## Do not

- Compress source code or error output the agent must act on.
- Add a compression dependency.

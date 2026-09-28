## Why

`startBridge` in `src/proxy/bridge.ts` has grown into a ~200-line function with nested helpers and inline handlers. A maintainer cannot see the startup algorithm at a glance, and the project owner explicitly asked for same-file extraction with descriptive names — readability first, without adding modules or paying performance costs. This change makes the bridge read as a sequence of named steps and records the readability/performance balance as a maintained convention.

## What Changes

- Refactor `startBridge` so its body reads as an **ordered sequence of descriptively named steps**; extract every nested helper into a top-level function in the same file. No new files, modules, or classes; no dependency changes.
- Preserve behavior exactly: the existing suite (46 tests) passes with unchanged assertions; protocol surface, correlation, log fields, exit codes, and process hygiene are untouched.
- Update the Spanish block-by-block mirror `docs/code-tours/bridge.md` to the new structure.
- Add the readability/performance balance convention to `AGENTS.md` (mirrored in `openspec/project.md`): readability first in the main algorithm, same-file helpers by default, performance measured (NFR-3), no micro-optimization.

## Capabilities

### New Capabilities

- `maintainability`: code-structure contract for the proxy — the startup entry reads as named steps, helpers are same-file and descriptively named, interception phases are named, hot paths add no overhead, and behavior is preserved by the existing suite.

### Modified Capabilities

(none — no product behavior changes)

## Impact

- **Code**: `src/proxy/bridge.ts` only (structure; no behavior change).
- **Docs/governance**: `docs/code-tours/bridge.md`, `AGENTS.md`, `openspec/project.md`.
- **Unchanged**: CLI surface, log format, protocol behavior, dependencies, exit codes. No architecture/flow/component change, so the living architecture diagram does not need regeneration (documented in tasks).

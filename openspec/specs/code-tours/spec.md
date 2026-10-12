# code-tours Specification

## Purpose

The study-guide catalog contract: `docs/code-tours/` mirrors key source files block-by-block (real code + Spanish explanation, source and mirrored commit in each header), the first wave covers the six ranked files (bridge, transports, replay-run, sqlite-queue, retry pipeline, store) with an index stating the ranking and the deferred wave, and every tour is updated in the same change that touches its source.
## Requirements
### Requirement: Tour mirror format

Every tour in `docs/code-tours/` SHALL mirror its source file block-by-block: the real code (English identifiers, convention of the repo) with a Spanish explanation per block covering what it does, why it exists, and what would break without it. Each tour SHALL carry a header naming the source, declaring itself a mirror (not the source of truth) with the mirrored commit, and closing with a glossary and a suggested next file. Code blocks SHALL match the mirrored source; any elision SHALL be explicitly marked and explained.

#### Scenario: Format present

- **WHEN** a maintainer opens any tour
- **THEN** the header names the source file and mirrored commit, blocks pair real code with the qué/por qué/si no estuviera explanation, and the glossary and next-stop sections close the document

#### Scenario: Blocks match the source

- **WHEN** a block's code is compared with the mirrored source at the recorded commit
- **THEN** it matches — or its elisions are explicitly marked and explained

### Requirement: Ranked coverage of the key files

The catalog SHALL cover, as its first wave, the files ranked by their role in the product: `src/proxy/bridge.ts` (interception spine), `src/proxy/transports.ts` (wire), `src/replay/replay-run.ts` (redrive engine), `src/queue/sqlite-queue.ts` (DLQ persistence), the retry pipeline (`src/pipeline/retry.ts` + `src/pipeline/classify.ts`), and `src/store/sqlite-store.ts` (audit/metrics). The index SHALL record the ranking rationale and the deferred next wave.

#### Scenario: Catalog present and indexed

- **WHEN** a reader opens `docs/code-tours/README.md`
- **THEN** the catalog lists every tour with its source, the ranking rationale, and the deferred files

#### Scenario: Bridge tour is current

- **WHEN** the bridge tour is compared with `src/proxy/bridge.ts`
- **THEN** it reflects the current interception shape (credential gate, policy gate, retry-wrapped execution, outcome helpers) and no longer teaches superseded M1 code

### Requirement: Drift discipline

Tours SHALL be updated in the same change that alters their mirrored source (the AGENTS convention), and each header SHALL record the mirrored commit so drift is detectable. (Markdown formatting is not machine-gated: `docs/` sits outside the prettier ignore scope; fidelity is enforced by spot-check and review.)

#### Scenario: Source change carries its tour

- **WHEN** a change modifies a file that has a tour
- **THEN** the tour is updated in that same change and its header records the new commit

#### Scenario: Mirror commit recorded

- **WHEN** a tour's header is read
- **THEN** it names the commit the tour mirrors, and a diff against the source at that commit shows only marked elisions


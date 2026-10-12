# Code tours — guía de lectura del código

> **Qué es esto:** tours bloque-por-bloque del código real de mcprelay. Cada tour es un **espejo** de su fuente (código en inglés, explicación en español: qué hace, por qué existe, qué pasaría si no estuviera) con el commit espejado en su cabecera. La fuente de verdad siempre es el código.
>
> **Regla de drift:** cuando una fuente cambia, su tour se actualiza **en el mismo change** y la cabecera registra el nuevo commit (convención de `AGENTS.md`). `docs/` está fuera del gate de prettier: la fidelidad se verifica por spot-check contra la fuente y por review — no por `format:check`.
>
> **Espejo de:** `cefe854` (primera ola, 2026-10-12).

## Catálogo — primera ola

| # | Tour | Fuente | Líneas | Por qué este puesto |
|---|---|---|---|---|
| 1 | [bridge](bridge.md) | [`src/proxy/bridge.ts`](../../src/proxy/bridge.ts) | 955 | La **espina**: todos los subsistemas (identidad, policy, retry, DLQ, métricas) se enchufan aquí. Su tour era el único existente y espejaba código de M1. |
| 2 | [transports](transports.md) | [`src/proxy/transports.ts`](../../src/proxy/transports.ts) | 372 | El **cable** del que depende cada sesión; el historial con más bugs (framing, orden, microtasks); era el "next stop" del tour original. |
| 3 | [replay-run](replay-run.md) | [`src/replay/replay-run.ts`](../../src/replay/replay-run.ts) | 548 | El **motor del diferenciador** (§5: "DLQ+replay is the product"): redrive, dedup, claims, outcome al audit. |
| 4 | [sqlite-queue](sqlite-queue.md) | [`src/queue/sqlite-queue.ts`](../../src/queue/sqlite-queue.ts) | 351 | La **persistencia del DLQ** y el adaptador de referencia del puerto `QueueProvider` (captura-antes-del-error, `claim`/`resolve` atómicos). |
| 5 | [retry-pipeline](retry-pipeline.md) | [`src/pipeline/retry.ts`](../../src/pipeline/retry.ts) + [`classify.ts`](../../src/pipeline/classify.ts) | 69 + 95 | "**Classify failures honestly**": la taxonomía D4 que decide qué llega al DLQ y qué se reintenta. |
| 6 | [sqlite-store](sqlite-store.md) | [`src/store/sqlite-store.ts`](../../src/store/sqlite-store.ts) | 334 | El **substrato de historia**: audit (donde vive el outcome de un replay) + call events (el `report`). |

**Orden de lectura sugerido:** 1 → 2 → 3 → 4 → 5 → 6 (la cadena de "next stop" de cada tour); o en orden de dependencia del flujo §1: 1 → 2 (wrap) → 5 (fail) → 4 (captura) → 3 (replay) → 6 (report).

## Segunda ola — diferida (con razones)

| Archivo | Líneas | Por qué se difiere |
|---|---|---|
| `src/policy/policy.ts` | 159 | Superficie fina y completamente especificada en [ADR-0006](../adr/0006-policy-engine.md); el tour añadiría poco sobre el ADR. |
| `src/config/config.ts` | 617 | Superficie churn-prone (cada milestone la toca); mejor tour cuando el schema se estabilice. |
| `src/cli/run.ts` | 332 | Entry point: se lee bien con el CLI surface del PRD §12 delante. |
| `src/identity/identity.ts` | 51 | Pequeño y con ADR-0010 que lo explica de punta a punta. |
| `src/replay/replay-cli.ts` + `guards.ts` + `command-line.ts` | 371 + 50 + 60 | Delgados y cross-referenciados desde el tour 3. |
| `src/queue/rabbitmq-queue.ts` | 149 | Espejo del contrato del tour 4 con el broker como almacén (ADR-0008). |

## Estructura de cada tour

1. **Cabecera** — qué es, fuentes + commit espejado, contexto y ADRs.
2. **Bloques** — código verbatim del fuente + *qué hace / por qué / si no estuviera*.
3. **Glosario** — los términos que el archivo introduce o usa en serio.
4. **Siguiente parada** — el tour que continúa la historia.

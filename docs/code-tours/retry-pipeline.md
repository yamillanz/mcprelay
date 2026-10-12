# Guía de estudio — `src/pipeline/retry.ts` + `src/pipeline/classify.ts`

> **Qué es este archivo:** una copia comentada del código real, bloque por bloque. Arriba el código (idéntico al fuente), debajo la explicación en español: **qué hace**, **por qué existe** y **qué pasaría si no estuviera**.
>
> El código y los identificadores se mantienen en inglés (convención del repo); la explicación va en español.
>
> **Fuentes:** [`src/pipeline/retry.ts`](../../src/pipeline/retry.ts) (69 líneas) y [`src/pipeline/classify.ts`](../../src/pipeline/classify.ts) (95 líneas) — **espejo de** `cefe854`. Si el código cambia, esta guía debe actualizarse en el mismo change (es un espejo, no la fuente de verdad). Son **un solo pipeline** repartido en dos archivos por tamaño: el bucle y la taxonomía.
>
> **Contexto:** aquí vive el principio del proyecto "classify failures honestly before retrying them" (M2). El bucle reintenta; la taxonomía **D4** decide si puede. La regla de oro: un reintento solo es seguro si (a) el fallo ocurrió **antes** de que la llamada pudiera ejecutar (pre-send), o (b) el tool está marcado `idempotent: true`. Todo lo demás se captura al DLQ y se decide fuera. Decisiones en [`docs/adr/0003-failure-classification.md`](../adr/0003-failure-classification.md).

---

## Bloque A — El contrato del pipeline (retry.ts)

```ts
import type { AttemptOutcome, ClassifiedAttempt } from './classify.js';

export interface RetryPolicy {
  maxAttempts: number;
  baseMs: number;
  jitter: boolean;
}

export interface RunWithRetryOptions {
  attempt(attemptNumber: number): Promise<AttemptOutcome>;
  classify(outcome: AttemptOutcome): ClassifiedAttempt;
  policy: RetryPolicy;
  sleep?(ms: number): Promise<void>;
  random?(): number;
}

export interface RetryResult {
  attempts: number;
  outcome: AttemptOutcome;
  classification: ClassifiedAttempt;
}

/** Backoff ceiling; documented in ADR-0003. */
export const BACKOFF_CAP_MS = 30000;
```

**Qué hace:** define el contrato: `attempt(n)` ejecuta **un** intento y devuelve un `AttemptOutcome` (`result` o `error` con fase); `classify(outcome)` lo clasifica; `policy` fija el techo de intentos y el backoff. `sleep` y `random` son inyectables (con defaults reales) para que los tests sean deterministas. `RetryResult` devuelve cuántos intentos hubo, el outcome final y su clasificación.

**Por qué:** el bucle no sabe **nada** de tools, MCP ni DLQ: recibe dos funciones y una política. Esa pureza es lo que permite testear la taxonomía con casos sintéticos y reutilizar el pipeline en el bridge sin acoplarlo. `attemptNumber` (1-based) existe porque el backoff depende de cuántos fallos llevas, no de la lógica del caller.

**Si no estuviera:** cada caller (hoy: el bridge) tendría su propio bucle de retry con su propia idea de qué es reintentable — exactamente el "hopeful retry" que el PRD prohíbe.

---

## Bloque B — El cálculo del backoff

```ts
/** Delay before the next attempt after `failedAttempt` (1-based). */
export function backoffDelayMs(
  policy: Pick<RetryPolicy, 'baseMs' | 'jitter'>,
  failedAttempt: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(policy.baseMs * 2 ** (failedAttempt - 1), BACKOFF_CAP_MS);
  if (!policy.jitter) return exponential;
  return Math.floor(random() * (exponential + 1));
}
```

**Qué hace:** backoff exponencial (`baseMs × 2^(n−1)`), con techo de 30 s. Con `jitter: false` devuelve el valor exacto (útil para tests de timing); con jitter reparte uniformemente **entre 0 y** el valor exponencial (full jitter).

**Por qué:** el `math.min` con el cap está separado del cálculo para que el techo sea una constante documentada (ADR-0003) y no un número mágico. Full jitter (en vez de jitter "a la mitad") es la recomendación clásica contra el thundering herd: cuando un backend se cae, los reintentos de todos los clientes se dispersan en el rango completo.

**Si no estuviera:** reintentos a intervalos fijos — todos los clientes golpeando el servidor caído al mismo tiempo, y sin techo, esperas de minutos.

---

## Bloque C — `runWithRetry`: el bucle

```ts
/**
 * Runs one logical call attempt-by-attempt, stopping when the classification
 * says stop, the call is cancelled, or the attempt bound is reached.
 */
export async function runWithRetry(options: RunWithRetryOptions): Promise<RetryResult> {
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const random = options.random ?? Math.random;

  let attempts = 0;
  let outcome: AttemptOutcome | undefined;
  let classification: ClassifiedAttempt | undefined;

  while (attempts < options.policy.maxAttempts) {
    attempts += 1;
    outcome = await options.attempt(attempts);
    classification = options.classify(outcome);

    if (!classification.retry) break;
    if (attempts >= options.policy.maxAttempts) break;
    await sleep(backoffDelayMs(options.policy, attempts, random));
  }

  return {
    attempts,
    outcome: outcome as AttemptOutcome,
    classification: classification as ClassifiedAttempt,
  };
}
```

**Qué hace:** el bucle: incrementa el contador, ejecuta un intento, clasifica, y decide — `!retry` → parar; techo alcanzado → parar; si no, dormir el backoff y repetir. Devuelve el outcome y la clasificación del **último** intento (haya sido éxito, cancelación o fallo final).

**Por qué:** el `classification.retry` es la única puerta de continuación: el pipeline nunca decide "una más" por su cuenta — la política D4 es la que manda. Las dos salidas del `while` (retry=false, techo) están explícitas para que el bucle se lea sin aritmética mental. Los casts finales son seguros: el bucle solo termina después de al menos un `attempt`+`classify` (la condición inicial `0 < maxAttempts` lo garantiza — maxAttempts ≥ 1 es validado en config).

**Si no estuviera:** el bridge tendría que llevar su propio contador, su propio sleep y su propia condición de parada — y cada bug de "reintenté una vez de más" sería un side effect duplicado.

---

## Bloque D — La taxonomía D4 (classify.ts, tipos)

```ts
import { ProtocolError, SdkError, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/server';

/** D4 failure classes (design D2, ADR-0003). */
export type FailureClass =
  | 'ok'
  | 'transport_pre_execution'
  | 'transport_post_execution'
  | 'timeout'
  | 'upstream_error'
  | 'non_retryable'
  | 'tool_error'
  | 'input_required'
  | 'cancelled';

/** Where an attempt failed; the attempt wrapper decides this from the error. */
export type FailurePhase = 'pre_send' | 'post_send' | 'timeout' | 'cancelled';

export type AttemptOutcome =
  { kind: 'result'; result: unknown } | { kind: 'error'; error: unknown; phase: FailurePhase };

export interface ClassifiedAttempt {
  class: FailureClass;
  retry: boolean;
}

export interface ClassificationPolicy {
  idempotent: boolean;
}

/** Structural JSON-RPC errors where a retry cannot help. */
const NON_RETRYABLE_PROTOCOL_CODES = new Set([-32700, -32600, -32601, -32602]);
```

**Qué hace:** define el vocabulario D4 completo: las **9 clases** de desenlace, las 4 fases de un intento (`pre_send`/`post_send`/`timeout`/`cancelled` — la fase la decide el wrapper del intento, no el clasificador), el `AttemptOutcome` y el par clasificación+decisión. `NON_RETRYABLE_PROTOCOL_CODES` fija los errores JSON-RPC estructurales que no mejoran reintentando (parse, request inválido, método no encontrado, params inválidos).

**Por qué:** separar **fase** (hecho observado por quien intentó: ¿llegó a enviarse?) de **clase+retry** (decisión pura) es lo que hace la taxonomía testeable y honesta: `classifyAttempt` es una función pura de (outcome, idempotent). Las clases existentes no son decorativas: `failureClassFromD4` (en `queue/failure-record.ts`) decide cuáles van al DLQ, y `report`/`replay` las muestran.

**Si no estuviera:** "retry" sería un booleano sin justificación y la captura al DLQ no podría distinguir un timeout reintentable de un `isError` final.

---

## Bloque E — `classifyAttempt`: la decisión

```ts
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function numericErrorCode(error: unknown): number | undefined {
  if (error instanceof ProtocolError) return error.code;
  if (isRecord(error) && typeof error.code === 'number') return error.code;
  return undefined;
}

function sdkErrorCode(error: unknown): SdkErrorCode | undefined {
  return error instanceof SdkError ? error.code : undefined;
}

/**
 * Classifies one attempt per the D4 taxonomy and decides whether it may be
 * retried. Pure function: the attempt wrapper owns phase detection.
 */
export function classifyAttempt(
  outcome: AttemptOutcome,
  policy: ClassificationPolicy,
): ClassifiedAttempt {
  if (outcome.kind === 'result') {
    const result = outcome.result;
    if (isRecord(result) && result.isError === true) return { class: 'tool_error', retry: false };
    if (isRecord(result) && result.resultType === 'input_required') {
      return { class: 'input_required', retry: false };
    }
    return { class: 'ok', retry: false };
  }

  if (outcome.phase === 'cancelled') return { class: 'cancelled', retry: false };
  if (outcome.phase === 'timeout') return { class: 'timeout', retry: policy.idempotent };
  if (outcome.phase === 'pre_send') {
    return { class: 'transport_pre_execution', retry: true };
  }

  const code = numericErrorCode(outcome.error);
  if (code !== undefined) {
    return NON_RETRYABLE_PROTOCOL_CODES.has(code)
      ? { class: 'non_retryable', retry: false }
      : { class: 'upstream_error', retry: policy.idempotent };
  }

  const sdkCode = sdkErrorCode(outcome.error);
  if (sdkCode === SdkErrorCode.NotConnected || sdkCode === SdkErrorCode.SendFailed) {
    return { class: 'transport_pre_execution', retry: true };
  }
  if (sdkCode === SdkErrorCode.ConnectionClosed) {
    // Ambiguous mid-call crash: it may have executed; conservative gate.
    return { class: 'transport_post_execution', retry: policy.idempotent };
  }

  if (outcome.error instanceof SdkHttpError) {
    // The request reached the server; a 4xx auth rejection will not fix itself.
    if (outcome.error.status === 401 || outcome.error.status === 403) {
      return { class: 'non_retryable', retry: false };
    }
    return { class: 'transport_post_execution', retry: policy.idempotent };
  }

  return { class: 'non_retryable', retry: false };
}
```

**Qué hace:** la tabla D4 en código, en orden de decisión:

1. **Resultado**: `isError: true` → `tool_error` (nunca reintenta — el tool respondió, y reintentar un error de negocio es duplicar efectos); `resultType: 'input_required'` → `input_required` (no es un fallo: el server pide más input); si no, `ok`.
2. **Fases**: `cancelled` → nunca; `timeout` → **solo si idempotent**; `pre_send` → siempre (la llamada no llegó a ejecutarse).
3. **Códigos JSON-RPC estructurales** → `non_retryable`; otros códigos de protocolo → `upstream_error` (gated en idempotent).
4. **Códigos del SDK**: `NotConnected`/`SendFailed` → pre-execution (retry directo); `ConnectionClosed` → **ambiguo** (pudo ejecutarse) → `transport_post_execution`, gated.
5. **HTTP**: 401/403 → `non_retryable` (una credencial rechazada no mejora sola); el resto → `transport_post_execution`, gated.
6. Todo lo demás → `non_retryable` (default conservador).

**Por qué:** el orden importa y está pensado para ser conservador en cada duda: lo desconocido nunca reintenta; lo ambiguo (conexión cortada a mitad) solo con `idempotent`; las credenciales rechazadas son definitivas. La regla transversal: `retry: true` solo cuando **prueba** de que el efecto no ocurrió (pre_send) o cuando el humano declaró el tool seguro de repetir (`idempotent`). El comentario de `ConnectionClosed` ("pudo haber ejecutado; gate conservador") es el ejemplo perfecto de por qué la taxonomía existe.

**Si no estuviera:** los reintentos serían una apuesta — y en un mundo de side effects, la apuesta se llama doble escritura.

---

## Glosario rápido

| Término | Significado |
|---|---|
| **D4** | La taxonomía de clases de fallo del PRD/ADR-0003; el corazón del retry honesto. |
| **fase** | Dónde falló el intento: `pre_send` (no llegó), `post_send` (pudo ejecutarse), `timeout`, `cancelled`. |
| **`idempotent`** | Declaración por tool (`per_tool.idempotent: true`) de que repetirlo no duplica efectos; habilita retries post-ejecución. |
| **full jitter** | Backoff aleatorio en `[0, exponencial]` — dispersa reintentos y evita thundering herd. |
| **`BACKOFF_CAP_MS`** | Techo de backoff: 30 s (ADR-0003). |
| **`attemptNumber`** | Contador 1-based del intento; el backoff crece con él. |
| **injectable `sleep`/`random`** | Puntos de inyección que hacen deterministas los tests de timing. |
| **`input_required`** | El server pide input interactivo: no es un fallo, no se reintenta, no va al DLQ. |
| **`transport_pre_execution`** | Fallo de transporte antes de ejecutar: el único retry incondicional. |

---

## Siguiente parada sugerida

[`sqlite-store.md`](sqlite-store.md): el último eslabón del ciclo — donde el audit registra cada denegación/captura/replay y donde nacen las métricas que `report` renderiza.

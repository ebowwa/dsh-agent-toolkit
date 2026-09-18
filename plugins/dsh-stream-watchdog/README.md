# dsh-stream-watchdog

Turns a **stalled model stream** from an eternal silent hang into one
automatic retry round, using dsh's own retry policy.

## The failure

A provider SSE stream occasionally opens (HTTP 200 + headers) and then
delivers **zero chunks, forever**. Nothing in the dsh LLM stack bounds that:

- the openai SDK's `timeout` only covers time-to-headers (openai-node v6
  clears the timer the moment `fetch` resolves — `fetchWithTimeout`);
- pi-ai forwards a `timeoutMs` only when the profile sets one, and it lands
  on the same header-bounded SDK timer anyway;
- the retry policy (`dsh-llm-retry`) fires only on a **thrown** failure —
  a silent open stream never throws.

So the step hangs inside `for await` forever. The chat looks like it
randomly stopped mid-turn: pressing Stop journals `aborted/user`; not
pressing it leaves the session frozen indefinitely (observed: a FleetTower
turn hung 12 hours at 2026-09-17 10:48 with an empty socket table and no
journal event after `step/start`; the same day, five turns across two other
chats ended `aborted/user`, each with an `assistant/attempt` carrying an
**empty stream** — the user stopping a chat that had gone silent on them).

## The fix

An outermost `llm/stream` waterfall listener (`global` + `prepend`, so it
wraps the final stream every consumer sees — plain `llm.stream` and
prepared one-shot `prepareCall().stream` calls alike). The wrapper races
each `next()` against **two budgets**; every chunk from any inner
middleware resets the running one:

- `firstTokenTimeoutMs` (default **300s**) bounds the silence before the
  FIRST chunk. dsh resends the whole chat history on every step, so a long
  prompt's server-side prefill can legitimately take minutes before token
  one. (Lesson from the first build, 2026-09-17: a flat 60s budget killed
  healthy long-prefill streams and turned recovery into a retry storm —
  each 60s kill + 60s backoff re-queued the same giant request. The
  first-token window must be prefill-scale.)
- `idleTimeoutMs` (default **120s**) bounds each later gap, where silence
  is far more likely a genuinely dead stream.

On a budget win it closes the underlying stream and yields the stream
protocol's error finish chunk:

```js
{ type: "finish", reason: { kind: "error",
    failure: { message: "stream idle: no first token within 300000ms",  // pre-first-token tier
             // | "stream idle: no model output for 120000ms",          // mid-stream tier
               code: "TIMEOUT" } } }
```

That is byte-for-byte the shape `adapterStream` produces for a failed
adapter call, so the loop's existing machinery takes over unchanged:
`assistant/attempt` settles durably, the `agent/request-error` waterfall
fires, `dsh-llm-retry` finds `TIMEOUT` in `retryableCodes` and re-issues
the step (its backoff, its max-retries cap). The journal shows the same
`assistant/attempt` + `llm/retry` + `llm/retry-started` sequence as any
other recovered transport error. Only after the provider's retries exhaust
does the turn end with a visible error — never a spinner.

A plain throw from the wrapper was deliberately avoided: mid-iteration
throws bypass the `agent/request-error` waterfall entirely and would end
the turn un-retried.

Guarding is per provider route (default `["zai"]`, where the stalls were
observed; `"*"` guards everything). Already-aborted requests and
non-stream `next()` results pass through untouched. Each firing logs one
`stream-watchdog:` warn line.

## Install (persistent web install, mounted by hand)

```sh
cp -R plugins/dsh-stream-watchdog <runtime>/node_modules/@local/dsh-stream-watchdog
ln -s <runtime>/node_modules/@local/dsh-stream-watchdog <profiles>/node_modules/@local/dsh-stream-watchdog
```

Patch row in the web profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: stream-watchdog
      name: "<runtime>/node_modules/@local/dsh-stream-watchdog/lib/hot2.js"
      config:
        firstTokenTimeoutMs: 300000
        idleTimeoutMs: 120000
        providers: ["zai"]
        disabled: false
```

The patch layer is hot-watched: the listener arms without a restart, for
every running session's next step. Disable with `config.disabled: true`.
Same fresh-URL rule as the other patch rows: future code changes go to a
NEW file URL (`lib/hot2.js`, full copy) with the two-write row flip —
`lib/hot.js`'s module is cached by URL after first import.

## Test

Offline, touches no dsh process (run from the installed copy so
`@deepseek-ai/schemastery` resolves through the runtime tree):

```sh
node <runtime>/node_modules/@local/dsh-stream-watchdog/test/smoke.mjs
```

41 checks: pass-through (chunks, upstream finish chunks, upstream throws),
the mid-stream idle stall (underlying closed, synthetic retryable TIMEOUT
finish, iteration end), the first-token tier (distinct message, its own
budget enforced pre-first-chunk, slow-but-legal first token passing, late
first token killed), per-chunk timer reset, early consumer exit closing
the underlying stream, Config defaults, the apply() registration surface
(single global+prepend listener, disabled kill switch, provider filter,
aborted pass-through, non-stream pass-through, logger side-channel), and
the hot.js shim.

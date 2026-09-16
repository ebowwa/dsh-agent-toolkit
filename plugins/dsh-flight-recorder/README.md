# @local/dsh-flight-recorder

Records the two transcript blind spots into every session's flight-recorder
log (`session.jsonl.zstd`):

1. **Background jobs** — the registry's output cursor is single and consuming,
   so a job's stream previously entered the transcript only when an
   `job_output` read happened to return it.

   | event | when | notes |
   |---|---|---|
   | `job/spawn` | on `ctx.jobs.start` | id, kind, label, owner session, output cap |
   | `job/output` | teed around every read | agent-visible return values untouched |
   | `job/status` | non-terminal transitions via `onJobsChanged` | e.g. `stopping` |
   | `job/done` | settlement via `onJobDone` | merged producer outcome; full output for final-output kinds |

   Stream jobs' unread tails are deliberately NOT captured: the only way to
   reach them is a consuming read, which would empty the agent's own
   post-settlement readback. Changing agent-visible behavior is not an
   observer's privilege.

2. **Plugin layer** — cordis loader lifecycle had no transcript trace at all.

   | event | source |
   |---|---|
   | `plugin/lifecycle {event: "plugin-created"/"plugin-disposed"}` | `internal/plugin` |
   | `plugin/lifecycle {event: "status", from, to}` | `internal/status` (active-touching transitions by default) |
   | `plugin/lifecycle {event: "hmr-change"/"hmr-reload", ...}` | `hmr/change`, `hmr/reload` |
   | `plugin/lifecycle {event: "recorder-mounted"}` | this plugin's own mount |

   Two sinks, because the event classes have different audiences:

   - `~/.dsh/storages/flight-recorder-plugins.jsonl` — the host-level log,
     EVERY event. Session attach churns hundreds of scoped fibers
     (SubagentRuntime, AgentLoop, SandboxBashExecutor, ...) — thousands of
     events per attach — and that firehose would drown session transcripts.
   - session transcripts — the curated subset only: FlightRecorder's own
     lifecycle, HMR change/reload, mount markers. A harness shutdown
     cascades through the tree and is recorded into the transcript by the
     dying observer up to its own `status 2->5`.

   The internal listeners register `{ global: true }`: internal events are
   emitted on the emitting fiber's own context and dispatch filters
   non-global listeners through that fiber's scope filter, which does not
   include a sibling plugin's context. Writer targets are the scope view of
   `ctx.sessions` PLUS every session observed through job ownership
   (`knownSessions`) — the store view can be scope-proxied for host-level
   plugins, so job-observed refs are the reliable transcript path. The
   plugin instantiates PER SESSION-SCOPE (every composition mounts its own
   FlightRecorder fiber; the service name is isolate-filtered, so this is
   legal). Fiber-create events are structurally unhearable when no instance
   is already mounted (creation precedes listener registration); disposals
   and status transitions land reliably.

## Install

```sh
~/.dsh/runtime/node_modules/.bin/dsh plugin --profile web add \
  "file:$HOME/Developer/dsh-flight-recorder"
# then mount via ~/.dsh/profiles/web/cordis.patch.yml (see the flight-recorder row)
```

## COUPLING — LOCAL HOTFIX required

`job/*` and `plugin/*` are out-of-repo event types. The installed
`@deepseek-ai/dsh-session` carries a LOCAL HOTFIX adding them to
`KNOWN_SESSION_EVENT_TYPES` (`dsh-session/lib/index.js`, beside the earlier
`web/search-browser-request` precedent). `assertEventsSupported` **refuses**
logs containing unknown non-ignorable types, so the hotfix must be re-applied
after any harness upgrade for as long as logs written with this plugin
mounted are ever re-read. Disabling the plugin (config.disabled) stops new
events but does not lift the requirement for logs that already carry them.

## Reload semantics

- `FLIGHT_RECORDER_INNER` chains each mount's tee to the ORIGINAL
  `jobs.start`, so remounts replace rather than stack.
- `ctx.effect`-registered cleanup uninstalls the tee on disposal, but only if
  the installed tee is still ours (identity check) — a disposed fiber never
  leaves a zombie wrap behind, and never clobbers a successor's.

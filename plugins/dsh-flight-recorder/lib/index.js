import { appendFileSync } from "node:fs";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

/**
 * Flight-recorder extension for the two observational blind spots.
 *
 * 1. Background jobs: the registry's output cursor is single and consuming —
 *    a job's stream output previously entered the transcript only when the
 *    agent's own job_output read happened to return it. This plugin wraps
 *    `ctx.jobs.start` (the same service-shadowing style as
 *    @local/dsh-model-alternator) to tee, without altering any value the
 *    agent sees:
 *
 *      - `job/spawn`  — id, kind, label, owner session, output cap.
 *      - `job/output` — every delta any read returns (tee; the read's return
 *        value is untouched).
 *      - `job/status` — non-terminal transitions seen via onJobsChanged
 *        (registration is spawn's job, settlement is done's).
 *      - `job/done`   — terminal snapshot merged with the producer's
 *        JobOutcome (status, detail, and the full output for final-output
 *        kinds). Stream jobs' unread tails stay unrecorded by design: the
 *        only alternative is a consuming read that would empty the agent's
 *        own post-settlement readback, and changing agent-visible behavior
 *        is not an observer's privilege.
 *
 *    Listeners register from this plugin's host-level (unscoped) context, so
 *    per the JobRegistry scope contract they see every owner — every session
 *    and every subagent composition in this process.
 *
 * 2. Plugin layer: the loader's lifecycle previously left no transcript
 *    trace at all. This subscribes to cordis's own internal events and
 *    appends `plugin/lifecycle` to every live session:
 *
 *      - `internal/plugin` — plugin fiber created (uid set) / disposed (uid
 *        cleared).
 *      - `internal/status` — fiber state transitions touching the active
 *        state (2) by default; all transitions with
 *        `pluginStatusActiveOnly: false`.
 *      - `hmr/change` / `hmr/reload` — watched-file changes and the reload
 *        set they produced.
 *
 * Every append is contained: an observer must never break the observed.
 *
 * COUPLING: `job/*` and `plugin/*` are out-of-repo event types. The installed
 * @deepseek-ai/dsh-session KNOWN_SESSION_EVENT_TYPES Set carries a matching
 * LOCAL HOTFIX (see the comment beside that Set in dsh-session/lib/index.js);
 * assertEventsSupported refuses logs containing unknown types that are not
 * marked ignorable, so the hotfix must survive for as long as logs written
 * with this plugin mounted are ever re-read.
 */
var FlightRecorder = class extends Service {
	config;
	static inject = ["jobs"];
	static Config = z.object({
		/** Kill switch: mount the row but record nothing. */
		disabled: z.boolean().default(false),
		/** Per-event cap for recorded output text (bytes of UTF-8). */
		outputChunkMaxBytes: z.number().default(65536),
		/** Maximum `job/output` events recorded per job before truncation flags set in. */
		maxOutputEventsPerJob: z.number().default(500),
		/** Subscribe to the loader/HMR plugin layer. */
		pluginLayer: z.boolean().default(true),
		/** Record only fiber status transitions touching the active state (2). */
		pluginStatusActiveOnly: z.boolean().default(true),
		/** Host-level plugin log (every heard event). Relative to $DSH_HOME's storages dir when not absolute. */
		pluginLogFile: z.string().default("/Users/ebowwa/.dsh/storages/flight-recorder-plugins.jsonl")
	});
	constructor(ctx, config) {
		super(ctx, "flightRecorder");
		this.config = config;
		/** job id -> { outputEvents, outcome } telemetry accumulated through the start tee. */
		this.telemetry = new Map();
		/** ownerKey -> Map<jobId, last non-terminal status> for onJobsChanged diffs. */
		this.lastStatus = new Map();
		/** sessionId -> Session, observed through job ownership (writer targets
		 * that do not depend on the scope view of ctx.sessions). */
		this.knownSessions = new Map();
		if (config.disabled) return;
		this.observeJobs(ctx);
		if (config.pluginLayer) this.observePluginLayer(ctx);
		/* Mount marker: every (re)mount of this plugin is itself a recorded
		 * fact — and the transcript-visible proof that a reload re-ran us. */
		try {
			const sessions = ctx.sessions;
			if (sessions?.list) {
				for (const session of sessions.list()) {
					this.append(session, "plugin/lifecycle", { event: "recorder-mounted" });
				}
			}
		} catch {
			/* contained */
		}
		this.selfTest(ctx);
	}

	/**
	 * Diagnostic: prove registration + dispatch on this exact context object.
	 * Emits a NON-internal event name (nothing shipped listens to it, and the
	 * dispatch meta-event it produces is tracing-only), so no loader machinery
	 * can observe or misinterpret it. Mount facts go to the logger.
	 */
	selfTest(ctx) {
		try {
			const logger = ctx.logger;
			const log = (message) => {
				try {
					if (logger?.warn) logger.warn(`[flight-recorder] ${message}`);
					else console.warn(`[flight-recorder] ${message}`);
				} catch {
					/* contained */
				}
			};
			let received = false;
			ctx.on("flight-recorder/selftest", () => {
				received = true;
			});
			ctx.emit("flight-recorder/selftest");
			log(`mounted; selftest=${received ? "received" : "DEAF"}; jobs=${!!ctx.jobs}; sessions=${!!ctx.sessions}; ctxKeys=${Object.getOwnPropertyNames(ctx).length}`);
		} catch {
			/* contained */
		}
	}

	/**
	 * Dispose hygiene: uninstall the start-tee when this fiber goes away, but
	 * only if the installed tee is still OURS — a remount may already have
	 * installed a successor, and clobbering that would drop the fresh wrap.
	 * Registered through ctx.effect, the mechanism the runtime collects.
	 */
	uninstallTee(jobs, teeStart, inner) {
		try {
			if (jobs && jobs.start === teeStart) jobs.start = inner;
			this.telemetry.clear();
			this.lastStatus.clear();
		} catch {
			/* contained */
		}
	}

	/** Guarded session append: an observer must never break the observed. */
	append(session, type, data) {
		try {
			if (!session || typeof session.append !== "function") return;
			session.append(type, data);
		} catch {
			/* contained: projection/serialization problems never propagate */
		}
	}

	/** Owner session of a job spec/snapshot, or undefined for unowned work. */
	ownerSession(owner) {
		try {
			return owner?.session ?? undefined;
		} catch {
			return undefined;
		}
	}

	capText(text) {
		if (typeof text !== "string") return undefined;
		return text.length > this.config.outputChunkMaxBytes
			? text.slice(0, this.config.outputChunkMaxBytes)
			: text;
	}

	observeJobs(ctx) {
		const jobs = ctx.jobs;
		if (!jobs || typeof jobs.start !== "function") return;
		const self = this;

		/* Reload-safe handover: an HMR reload of this plugin disposes the old
		 * fiber (its listeners detach) but leaves the previous tee installed on
		 * the persistent registry instance. Chain to the ORIGINAL start, never
		 * to a previous tee, so each mount replaces the last instead of
		 * stacking wraps — and never early-return on a stale flag, which would
		 * leave a disposed fiber's tee in place with no live listeners. */
		let inner = jobs.start;
		if (typeof inner !== "function") return;
		if (inner[FLIGHT_RECORDER_INNER]) inner = inner[FLIGHT_RECORDER_INNER];
		const innerStart = inner.bind(jobs);

		const teeStart = function teeStart(spec) {
			const entry = { outputEvents: 0, truncated: false, outcome: undefined };
			const innerRun = spec.run;
			if (typeof innerRun === "function") {
				spec.run = function teeRun() {
					const hooks = innerRun();
					try {
						if (typeof hooks?.readOutput === "function") {
							const innerRead = hooks.readOutput.bind(hooks);
							hooks.readOutput = function teeReadOutput() {
								const text = innerRead();
								try {
									if (text) self.recordOutputChunk(entry, text);
								} catch {
									/* contained */
								}
								return text;
							};
						}
						if (hooks?.done && typeof hooks.done.then === "function") {
							hooks.done.then(
								(outcome) => {
									entry.outcome = outcome;
								},
								() => {
									/* rejection path: registry already force-fails the record */
								}
							);
						}
					} catch {
						/* contained: producer hooks stay exactly as the producer returned them */
					}
					return hooks;
				};
			}
			const id = innerStart(spec);
			try {
				const session = self.ownerSession(spec.owner);
				self.rememberSession(session);
				/* No read can precede start's return — the id does not exist before
				 * it — so attaching identity here races nothing. */
				entry.currentId = id;
				entry.session = session;
				self.telemetry.set(id, entry);
				const data = {
					id,
					kind: spec.kind,
					label: typeof spec.label === "string" ? spec.label : ""
				};
				if (session) data.ownerSession = session.id;
				if (typeof spec.outputLimitBytes === "number") data.outputLimitBytes = spec.outputLimitBytes;
				self.append(session, "job/spawn", data);
			} catch {
				/* contained */
			}
			return id;
		};
		teeStart[FLIGHT_RECORDER_INNER] = inner;
		jobs.start = teeStart;
		try {
			ctx.effect(() => () => self.uninstallTee(jobs, teeStart, inner));
		} catch {
			/* contained: an effect registration failure must not break the mount */
		}

		/** Terminal settlement: outcome detail + (final-output kinds) full output. */
		ctx.jobs.onJobDone?.((snapshot, owner) => {
			try {
				const entry = this.telemetry.get(snapshot.id);
				this.telemetry.delete(snapshot.id);
				const data = {
					id: snapshot.id,
					kind: snapshot.kind,
					label: snapshot.label,
					status: snapshot.status,
					startedAt: snapshot.startedAt
				};
				const session = this.ownerSession(owner);
				this.rememberSession(session);
				if (session) data.ownerSession = session.id;
				if (typeof snapshot.finishedAt === "number") data.finishedAt = snapshot.finishedAt;
				if (typeof snapshot.detail === "string") data.detail = snapshot.detail;
				if (entry?.outcome && typeof entry.outcome === "object") {
					if (typeof entry.outcome.detail === "string" && data.detail === undefined) {
						data.detail = entry.outcome.detail;
					}
					const output = this.capText(entry.outcome.output);
					if (output) data.output = output;
				}
				if (entry?.truncated) data.outputTruncated = true;
				this.append(session ?? this.anyLiveSession(), "job/done", data);
			} catch {
				/* contained */
			}
		});

		/** Non-terminal transitions (registration = spawn, settlement = done). */
		ctx.jobs.onJobsChanged?.((owner) => {
			try {
				const key = owner?.session?.id ?? "(unowned)";
				const snapshots = ctx.jobs.list(owner ?? undefined);
				const previous = this.lastStatus.get(key) ?? new Map();
				const next = new Map();
				for (const snapshot of snapshots) {
					if (snapshot.status !== "running" && snapshot.status !== "stopping") continue;
					next.set(snapshot.id, snapshot.status);
					const before = previous.get(snapshot.id);
					if (before !== snapshot.status && before !== undefined) {
						const data = { id: snapshot.id, kind: snapshot.kind, status: snapshot.status };
						const session = this.ownerSession(owner);
						this.rememberSession(session);
						if (session) data.ownerSession = session.id;
						if (typeof snapshot.detail === "string") data.detail = snapshot.detail;
						this.append(session ?? this.anyLiveSession(), "job/status", data);
					}
				}
				this.lastStatus.set(key, next);
			} catch {
				/* contained */
			}
		});
	}

	recordOutputChunk(entry, text) {
		if (!entry || entry.outputEvents >= this.config.maxOutputEventsPerJob) {
			if (entry) entry.truncated = true;
			return;
		}
		entry.outputEvents += 1;
		if (entry.outputEvents === this.config.maxOutputEventsPerJob) entry.truncated = true;
		const capped = this.capText(text);
		if (!capped) return;
		const id = entry.currentId;
		/* Reads cannot precede start's return, so currentId is always set here
		 * in practice; the guard keeps a theoretical fast path honest. */
		if (id === undefined) return;
		const data = { id, text: capped };
		if (entry.truncated && entry.outputEvents === this.config.maxOutputEventsPerJob) {
			data.truncated = true;
		}
		this.append(entry.session ?? this.anyLiveSession(), "job/output", data);
	}

	anyLiveSession() {
		try {
			const sessions = this.ctx.sessions;
			if (!sessions || typeof sessions.list !== "function") return undefined;
			return sessions.list()[0];
		} catch {
			return undefined;
		}
	}

	observePluginLayer(ctx) {
		const self = this;
		const activeOnly = this.config.pluginStatusActiveOnly;
		/* All four listeners register { global: true }: internal events are
		 * emitted on the emitting fiber's own context, and dispatch filters
		 * non-global listeners through that fiber's scope filter — which does
		 * not include a sibling plugin's context. Global listeners bypass the
		 * filter (the hooks dict itself is shared through extend()'s
		 * prototype chain), so this is what makes the layer audible. */
		try {
			ctx.on("internal/plugin", function pluginFiber(fiber) {
				try {
					const created = fiber?.uid !== undefined && fiber.uid !== null;
					self.recordPluginEvent(created ? "plugin-created" : "plugin-disposed", fiber);
				} catch {
					/* contained */
				}
			}, { global: true });
			ctx.on("internal/status", function fiberStatus(fiber, oldValue) {
				try {
					if (activeOnly && oldValue !== 2 && fiber?.state !== 2) return;
					self.recordPluginEvent("status", fiber, { from: oldValue, to: fiber?.state });
				} catch {
					/* contained */
				}
			}, { global: true });
			ctx.on("hmr/change", function hmrChange(url) {
				self.recordPluginEvent("hmr-change", undefined, { url: String(url) });
			}, { global: true });
			ctx.on("hmr/reload", function hmrReload(reloads) {
				try {
					const names = [];
					if (reloads && typeof reloads.forEach === "function") {
						reloads.forEach((_reload, plugin) => {
							names.push(String(plugin?.name ?? plugin ?? "?"));
						});
					}
					self.recordPluginEvent("hmr-reload", undefined, { plugins: names });
				} catch {
					/* contained */
				}
			}, { global: true });
		} catch {
			/* contained: event names may shift across cordis versions */
		}
	}

	recordPluginEvent(event, fiber, extra) {
		const data = { event };
		const name = fiber?.name;
		if (name !== undefined) data.name = String(name);
		if (extra) {
			for (const [key, value] of Object.entries(extra)) {
				if (value !== undefined) data[key] = value;
			}
		}
		/* Sink 1 — the host-level plugin log: EVERY event. Session attach
		 * churns hundreds of fibers (SubagentRuntime, AgentLoop, …); that
		 * firehose belongs in the per-host log, not in session transcripts. */
		this.writePluginLog(data);
		/* Sink 2 — session transcripts: the curated subset only. Proven to
		 * land when the writing instance has a job-observed session cached. */
		const curated =
			name === "FlightRecorder" ||
			event === "hmr-change" ||
			event === "hmr-reload";
		if (!curated) return;
		try {
			/* Writer targets: the scope view of ctx.sessions PLUS every session
			 * this process has observed through job ownership — the store view
			 * may be scope-proxied to nothing for a host-level plugin, so
			 * job-observed refs are the reliable path. */
			const targets = new Map();
			try {
				const sessions = this.ctx.sessions;
				if (sessions && typeof sessions.list === "function") {
					for (const session of sessions.list()) targets.set(session.id, session);
				}
			} catch {
				/* contained */
			}
			for (const [id, session] of this.knownSessions) {
				if (!targets.has(id)) targets.set(id, session);
			}
			for (const session of targets.values()) {
				this.append(session, "plugin/lifecycle", data);
			}
		} catch {
			/* contained */
		}
	}

	/** Sink 1 writer: the host-level plugin log, one JSON line per event. */
	writePluginLog(data) {
		try {
			const path = this.config.pluginLogFile?.startsWith("/")
				? this.config.pluginLogFile
				: `${process.env.HOME ?? "/tmp"}/.dsh/storages/flight-recorder-plugins.jsonl`;
			appendFileSync(path, `${JSON.stringify({ t: Date.now(), ...data })}\n`);
		} catch {
			/* contained: the log must never break recording */
		}
	}

	/** Remember a session observed through job ownership. */
	rememberSession(session) {
		try {
			if (!session?.id) return;
			this.knownSessions.set(session.id, session);
			if (this.knownSessions.size > 100) {
				const oldest = this.knownSessions.keys().next().value;
				this.knownSessions.delete(oldest);
			}
		} catch {
			/* contained */
		}
	}
};

/** Tag on the installed tee pointing at the unwrapped original start, so a
 * remount replaces the previous tee instead of stacking onto it. */
const FLIGHT_RECORDER_INNER = Symbol("dsh-flight-recorder.inner");

export { FlightRecorder };
export default FlightRecorder;

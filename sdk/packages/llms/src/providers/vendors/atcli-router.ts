/**
 * atcli Smart Router
 *
 * An OmniRoute-inspired multi-provider routing engine built natively in atcli.
 * Routes LLM requests across multiple user-configured API slots with:
 *
 *  - 4 routing strategies: priority, round-robin, cost-optimized, random
 *  - Auto-fallback on 429, ECONNRESET, timeouts, 5xx errors
 *  - Per-slot circuit breakers (open after 3 consecutive failures, probe after 5min)
 *  - Rate-limit cooldown (429 → back off that slot for 60 seconds)
 *  - All OpenAI-compatible providers supported (OpenAI, DeepSeek, Groq, Cerebras,
 *    Sambanova, NVIDIA NIM, Fireworks, Mistral, any local/self-hosted endpoint)
 *
 * Configuration is stored in VS Code settings under `atcli.smartRouter.*`.
 * Slots are injected through GatewayResolvedProviderConfig.options.slots.
 */

import type {
	AgentModelEvent,
	AgentModelFinishReason,
	GatewayProviderContext,
	GatewayProviderFactory,
	GatewayResolvedProviderConfig,
	GatewayStreamRequest,
} from "@cline/shared";

// ---------------------------------------------------------------------------
// Public types (re-exported so VS Code extension can type-check slot configs)
// ---------------------------------------------------------------------------

/** Routing strategy for picking which slot to try first */
export type RouterStrategy =
	| "priority" // Slots tried in ascending priority order (default)
	| "round-robin" // Cycle through slots evenly
	| "cost-optimized" // Cheapest healthy slot first
	| "random"; // Random healthy slot

/** One provider+model combination the router can route to */
export interface RouterSlot {
	/** Human-readable label for this slot (shown in status/errors) */
	label: string;
	/** Base URL of the OpenAI-compatible endpoint (e.g. "https://api.deepseek.com/v1") */
	baseUrl: string;
	/** API key for this slot */
	apiKey: string;
	/** Model ID to send in the request body */
	modelId: string;
	/** Priority (lower = higher priority). Used by the "priority" strategy. */
	priority?: number;
	/**
	 * Approximate cost per million output tokens in USD.
	 * Used by the "cost-optimized" strategy.
	 * 0 = free tier (lowest cost, preferred last in cost-optimized mode).
	 */
	costPerMToken?: number;
	/** Request timeout for this slot in milliseconds (default: 60_000) */
	timeoutMs?: number;
}

/** The full options object injected via GatewayResolvedProviderConfig.options */
export interface AtcliRouterOptions {
	strategy?: RouterStrategy;
	slots?: RouterSlot[];
}

// ---------------------------------------------------------------------------
// Per-slot health tracking (in-memory, reset on restart)
// ---------------------------------------------------------------------------

interface SlotHealth {
	/** Timestamp (Date.now()) until which this slot is in 429-cooldown */
	cooldownUntil: number;
	/** Number of consecutive non-rate-limit failures */
	consecutiveFailures: number;
	/** If true, circuit is open; won't attempt until probeAfter */
	circuitOpen: boolean;
	/** Timestamp after which we probe the circuit-open slot again */
	probeAfter: number;
	/** Index used for round-robin state */
	lastUsedAt: number;
}

// Keyed by "baseUrl|modelId|apiKey-prefix" to survive slot reordering
const HEALTH = new Map<string, SlotHealth>();

const CIRCUIT_OPEN_THRESHOLD = 3; // failures before circuit opens
const CIRCUIT_PROBE_DELAY_MS = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000; // 60 seconds

function slotKey(slot: RouterSlot): string {
	// Use only first 8 chars of API key to avoid leaking secrets in logs
	const keyPrefix = slot.apiKey.slice(0, 8);
	return `${slot.baseUrl}|${slot.modelId}|${keyPrefix}`;
}

function getHealth(slot: RouterSlot): SlotHealth {
	const key = slotKey(slot);
	if (!HEALTH.has(key)) {
		HEALTH.set(key, {
			cooldownUntil: 0,
			consecutiveFailures: 0,
			circuitOpen: false,
			probeAfter: 0,
			lastUsedAt: 0,
		});
	}
	return HEALTH.get(key)!;
}

function isSlotAvailable(slot: RouterSlot): boolean {
	const h = getHealth(slot);
	const now = Date.now();

	// Rate-limit cooldown
	if (h.cooldownUntil > now) {
		return false;
	}

	// Circuit open — check probe window
	if (h.circuitOpen) {
		if (h.probeAfter > now) {
			return false;
		}
		// Half-open: allow one probe attempt
	}

	return true;
}

function recordSuccess(slot: RouterSlot): void {
	const h = getHealth(slot);
	h.consecutiveFailures = 0;
	h.circuitOpen = false;
	h.cooldownUntil = 0;
	h.lastUsedAt = Date.now();
}

function recordRateLimit(slot: RouterSlot, retryAfterSeconds?: number): void {
	const h = getHealth(slot);
	const cooldownMs = retryAfterSeconds
		? retryAfterSeconds * 1000
		: RATE_LIMIT_COOLDOWN_MS;
	h.cooldownUntil = Date.now() + cooldownMs;
}

function recordFailure(slot: RouterSlot): void {
	const h = getHealth(slot);
	h.consecutiveFailures += 1;
	if (h.consecutiveFailures >= CIRCUIT_OPEN_THRESHOLD) {
		h.circuitOpen = true;
		h.probeAfter = Date.now() + CIRCUIT_PROBE_DELAY_MS;
	}
}

// ---------------------------------------------------------------------------
// Slot selection strategies
// ---------------------------------------------------------------------------

let roundRobinIndex = 0;

function selectSlots(
	slots: RouterSlot[],
	strategy: RouterStrategy,
): RouterSlot[] {
	const available = slots.filter(isSlotAvailable);

	if (available.length === 0) {
		// All slots unavailable — return full list so we get a meaningful error
		return [...slots];
	}

	switch (strategy) {
		case "priority": {
			// Sort by priority ascending (lower number = higher priority)
			return available.sort(
				(a, b) => (a.priority ?? 999) - (b.priority ?? 999),
			);
		}

		case "round-robin": {
			// Rotate the starting index across calls
			const idx = roundRobinIndex % available.length;
			roundRobinIndex = (roundRobinIndex + 1) % available.length;
			return [...available.slice(idx), ...available.slice(0, idx)];
		}

		case "cost-optimized": {
			// Cheapest first; free (0) goes last so paid tiers absorb load first
			return available.sort((a, b) => {
				const ca = a.costPerMToken ?? 999;
				const cb = b.costPerMToken ?? 999;
				if (ca === 0 && cb !== 0) return 1;
				if (cb === 0 && ca !== 0) return -1;
				return ca - cb;
			});
		}

		case "random": {
			const shuffled = [...available];
			for (let i = shuffled.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
			}
			return shuffled;
		}

		default:
			return available;
	}
}

// ---------------------------------------------------------------------------
// OpenAI-compatible streaming request
// ---------------------------------------------------------------------------

/** Converts a GatewayStreamRequest message array to the OpenAI messages wire format */
type OAIRole = "system" | "user" | "assistant" | "tool";

interface OAIMessage {
	role: OAIRole;
	content: unknown;
	tool_call_id?: string;
	name?: string;
}

interface OAIToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

function buildMessages(
	request: GatewayStreamRequest,
): OAIMessage[] {
	const msgs: OAIMessage[] = [];

	if (request.systemPrompt) {
		msgs.push({ role: "system", content: request.systemPrompt });
	}

	for (const msg of request.messages) {
		const role = msg.role as OAIRole;
		if (typeof msg.content === "string") {
			msgs.push({ role, content: msg.content });
			continue;
		}

		if (Array.isArray(msg.content)) {
			// Flatten parts into the OpenAI-compatible array format
			const parts: unknown[] = [];
			for (const part of msg.content) {
				const p = part as unknown as Record<string, unknown>;
				if (p.type === "text") {
					parts.push({ type: "text", text: p.text as string });
				} else if (p.type === "image") {
					// image_url format
					parts.push({
						type: "image_url",
						image_url: { url: p.url as string },
					});
				} else if (p.type === "tool_use" || p.type === "tool-use") {
					// assistant tool_calls
					const existingMsg = msgs[msgs.length - 1];
					const toolCall: OAIToolCall = {
						id: (p.id as string) ?? `tc_${Date.now()}`,
						type: "function",
						function: {
							name: p.name as string,
							arguments:
								typeof p.input === "string"
									? p.input
									: JSON.stringify(p.input),
						},
					};
					if (
						existingMsg?.role === "assistant" &&
						Array.isArray(
							(existingMsg as unknown as Record<string, unknown>).tool_calls,
						)
					) {
						(
							(
								existingMsg as unknown as Record<string, unknown>
							).tool_calls as OAIToolCall[]
						).push(toolCall);
					} else {
						msgs.push({
							role: "assistant",
							content: null,
							...(({ tool_calls: [toolCall] }) as unknown as object),
						} as OAIMessage & { tool_calls: OAIToolCall[] });
					}
					continue;
				} else if (
					p.type === "tool_result" ||
					p.type === "tool-result"
				) {
					msgs.push({
						role: "tool",
						tool_call_id: p.tool_use_id as string,
						content:
							typeof p.content === "string"
								? p.content
								: JSON.stringify(p.content),
					});
					continue;
				}
			}
			if (parts.length > 0) {
				msgs.push({ role, content: parts });
			}
		} else {
			msgs.push({ role, content: JSON.stringify(msg.content) });
		}
	}

	return msgs;
}

function buildTools(request: GatewayStreamRequest): unknown[] | undefined {
	if (!request.tools || request.tools.length === 0) return undefined;
	return request.tools.map((t) => ({
		type: "function",
		function: {
			name: t.name,
			description: t.description,
			parameters: t.inputSchema,
		},
	}));
}

// ---------------------------------------------------------------------------
// SSE stream parser
// ---------------------------------------------------------------------------

interface OAIDelta {
	content?: string | null;
	reasoning_content?: string | null;
	tool_calls?: Array<{
		index: number;
		id?: string;
		function?: { name?: string; arguments?: string };
	}>;
	finish_reason?: string | null;
}

interface OAIChunk {
	choices?: Array<{
		delta: OAIDelta;
		finish_reason?: string | null;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
}

async function* parseSSEStream(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<OAIChunk> {
	const decoder = new TextDecoder();
	let buffer = "";

	const reader = body.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("data:")) continue;
				const data = trimmed.slice(5).trim();
				if (data === "[DONE]") return;
				if (!data) continue;
				try {
					yield JSON.parse(data) as OAIChunk;
				} catch {
					// Ignore malformed chunks
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}

// ---------------------------------------------------------------------------
// Stream a single slot
// ---------------------------------------------------------------------------

class SlotError extends Error {
	constructor(
		public readonly slot: RouterSlot,
		public readonly statusCode: number | null,
		message: string,
	) {
		super(message);
		this.name = "SlotError";
	}
}

async function* streamSlot(
	slot: RouterSlot,
	request: GatewayStreamRequest,
	signal?: AbortSignal,
): AsyncGenerator<AgentModelEvent> {
	const messages = buildMessages(request);
	const tools = buildTools(request);

	const body: Record<string, unknown> = {
		model: slot.modelId,
		messages,
		stream: true,
		stream_options: { include_usage: true },
	};

	if (tools && tools.length > 0) {
		body.tools = tools;
		body.tool_choice = "auto";
	}

	if (request.maxTokens && !request.defaultedMaxTokens) {
		body.max_tokens = request.maxTokens;
	}

	if (request.temperature !== undefined) {
		body.temperature = request.temperature;
	}

	if (request.reasoning?.enabled) {
		// DeepSeek / other providers that support reasoning_effort
		body.reasoning_effort =
			request.reasoning.effort ?? "medium";
	}

	const timeoutMs = slot.timeoutMs ?? 120_000;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const combinedSignal = signal
		? anySignal(signal, controller.signal)
		: controller.signal;

	let response: Response;
	try {
		const url = slot.baseUrl.endsWith("/")
			? `${slot.baseUrl}chat/completions`
			: `${slot.baseUrl}/chat/completions`;

		response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${slot.apiKey}`,
				"User-Agent": "atcli/1.0",
			},
			body: JSON.stringify(body),
			signal: combinedSignal,
		});
	} catch (err) {
		clearTimeout(timer);
		const msg =
			err instanceof Error ? err.message : String(err);
		throw new SlotError(slot, null, `Network error: ${msg}`);
	}

	clearTimeout(timer);

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		if (response.status === 429) {
			// Try to read Retry-After header
			const retryAfter = response.headers.get("Retry-After");
			const retryAfterSeconds = retryAfter
				? Number.parseInt(retryAfter, 10)
				: undefined;
			recordRateLimit(
				slot,
				Number.isFinite(retryAfterSeconds)
					? retryAfterSeconds
					: undefined,
			);
			throw new SlotError(
				slot,
				429,
				`Rate limited (429): ${text.slice(0, 200)}`,
			);
		}
		throw new SlotError(
			slot,
			response.status,
			`HTTP ${response.status}: ${text.slice(0, 200)}`,
		);
	}

	if (!response.body) {
		throw new SlotError(slot, null, "Empty response body");
	}

	// Track active tool calls by index
	const toolCallState = new Map<
		number,
		{ id: string; name: string; args: string }
	>();

	let hasContent = false;
	let finishReason: AgentModelFinishReason = "stop";

	try {
		for await (const chunk of parseSSEStream(response.body)) {
			// Usage chunk
			if (chunk.usage) {
				yield {
					type: "usage",
					usage: {
						inputTokens: chunk.usage.prompt_tokens ?? 0,
						outputTokens: chunk.usage.completion_tokens ?? 0,
					},
				};
			}

			for (const choice of chunk.choices ?? []) {
				const delta = choice.delta;

				// Finish reason
				if (choice.finish_reason) {
					finishReason =
						choice.finish_reason === "tool_calls"
							? "tool-calls"
							: choice.finish_reason === "stop"
								? "stop"
								: choice.finish_reason === "length"
									? "max-tokens"
									: "stop";
				}

				// Text content
				if (delta.content) {
					hasContent = true;
					yield { type: "text-delta", text: delta.content };
				}

				// Reasoning / thinking content (DeepSeek R1, etc.)
				if (delta.reasoning_content) {
					yield {
						type: "reasoning-delta",
						text: delta.reasoning_content,
					};
				}

				// Tool calls (streamed in fragments by index)
				for (const tc of delta.tool_calls ?? []) {
					const idx = tc.index;
					let state = toolCallState.get(idx);

					if (!state) {
						state = {
							id: tc.id ?? `tc_${idx}_${Date.now()}`,
							name: tc.function?.name ?? "",
							args: "",
						};
						toolCallState.set(idx, state);
					}

					if (tc.id && !state.id.startsWith("tc_")) {
						state.id = tc.id;
					}
					if (tc.function?.name) {
						state.name = tc.function.name;
					}
					if (tc.function?.arguments) {
						state.args += tc.function.arguments;
						yield {
							type: "tool-call-delta",
							index: idx,
							toolCallId: state.id,
							toolName: state.name,
							inputText: tc.function.arguments,
						};
					}
				}
			}
		}
	} catch (err) {
		if (err instanceof SlotError) throw err;
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("ECONNRESET") || msg.includes("aborted")) {
			throw new SlotError(slot, null, `Connection error: ${msg}`);
		}
		throw new SlotError(slot, null, `Stream error: ${msg}`);
	}

	// Flush any complete tool calls as finish events
	if (toolCallState.size > 0) {
		finishReason = "tool-calls";
	}

	yield { type: "finish", reason: finishReason };

	void hasContent; // suppress unused warning
}

// ---------------------------------------------------------------------------
// AbortSignal helpers
// ---------------------------------------------------------------------------

function anySignal(...signals: AbortSignal[]): AbortSignal {
	const controller = new AbortController();
	for (const signal of signals) {
		if (signal.aborted) {
			controller.abort(signal.reason);
			return controller.signal;
		}
		signal.addEventListener("abort", () =>
			controller.abort(signal.reason),
		);
	}
	return controller.signal;
}

// ---------------------------------------------------------------------------
// Main router generator — tries slots in strategy order with fallback
// ---------------------------------------------------------------------------

async function* atcliRouterStream(
	request: GatewayStreamRequest,
	context: GatewayProviderContext,
): AsyncGenerator<AgentModelEvent> {
	// Read options injected by cline-session-factory.ts
	const opts = context.config.options as AtcliRouterOptions | undefined;
	const strategy: RouterStrategy = opts?.strategy ?? "priority";
	const allSlots: RouterSlot[] = opts?.slots ?? [];

	if (allSlots.length === 0) {
		yield {
			type: "finish",
			reason: "error",
			error:
				"atcli Smart Router: No provider slots configured. " +
				"Please add at least one slot in Settings → atcli → Smart Router.",
		};
		return;
	}

	const orderedSlots = selectSlots(allSlots, strategy);
	const errors: string[] = [];

	for (const slot of orderedSlots) {
		// Check if user aborted before starting next slot
		if (request.signal?.aborted) {
			yield { type: "finish", reason: "aborted" };
			return;
		}

		context.logger?.log(
			`[atcli Router] Trying slot "${slot.label}" (${slot.modelId} @ ${slot.baseUrl})`,
		);

		try {
			const gen = streamSlot(slot, request, request.signal);
			let hasYieldedContent = false;

			for await (const event of gen) {
				hasYieldedContent = true;
				yield event;

				// If it's a finish event with no error, mark success and stop
				if (event.type === "finish") {
					if (event.reason !== "error") {
						recordSuccess(slot);
					} else {
						recordFailure(slot);
					}
					return;
				}
			}

			// Generator exhausted without finish event
			if (hasYieldedContent) {
				recordSuccess(slot);
				yield { type: "finish", reason: "stop" };
				return;
			}
		} catch (err) {
			if (err instanceof SlotError) {
				const isRateLimit = err.statusCode === 429;
				const errMsg = `[${slot.label}] ${err.message}`;
				errors.push(errMsg);

				context.logger?.log(
					`[atcli Router] Slot "${slot.label}" failed: ${err.message}`,
					{ severity: "warn" },
				);

				if (!isRateLimit) {
					recordFailure(slot);
				}
				// Continue to next slot
				continue;
			}

			// Unknown error — re-throw
			throw err;
		}
	}

	// All slots failed
	const summary = errors.join("\n  • ");
	yield {
		type: "finish",
		reason: "error",
		error:
			`atcli Smart Router: All ${allSlots.length} slot(s) failed.\n` +
			`Strategy: ${strategy}\n\nErrors:\n  • ${summary}`,
	};
}

// ---------------------------------------------------------------------------
// Factory (exported as the GatewayProviderFactory)
// ---------------------------------------------------------------------------

/**
 * Creates the atcli Smart Router provider.
 * Called by the GatewayRegistry when the "atcli" provider is used.
 */
export const createAtcliRouterProvider: GatewayProviderFactory = async (
	config: GatewayResolvedProviderConfig,
) => {
	return {
		stream: async (
			request: GatewayStreamRequest,
			context: GatewayProviderContext,
		): Promise<AsyncIterable<AgentModelEvent>> => {
			// Merge config-level options into context so the router can read them
			const mergedContext: GatewayProviderContext = {
				...context,
				config,
			};
			return atcliRouterStream(request, mergedContext);
		},
	};
};

/**
 * atcli Browser Provider
 *
 * A GatewayProviderFactory that routes LLM requests through browser automation
 * instead of an HTTP API. Navigates to the user's selected AI website
 * (ChatGPT, DeepSeek, Gemini, Kimi, Qwen) and interacts with it as a human
 * would — sending messages, reading responses, and streaming them back.
 *
 * Tool calls are extracted from the plain-text response using AtcliStreamParser,
 * then emitted as AgentModelEvent values so the rest of the agent runtime works
 * identically to API-key providers.
 *
 * The browser is controlled through the BrowserSessionBridge interface, which
 * is injected via GatewayResolvedProviderConfig.options.browserBridge. In the
 * VS Code extension this is wired to the existing Playwright BrowserSession.
 */

import type {
	AgentModelEvent,
	AgentModelFinishReason,
	GatewayProviderContext,
	GatewayProviderFactory,
	GatewayResolvedProviderConfig,
	GatewayStreamRequest,
} from "@cline/shared";
import { AtcliStreamParser } from "./atcli-tool-parser";
import { buildAtcliSystemPrompt } from "./atcli-tool-prompt";

// ---------------------------------------------------------------------------
// Ambient DOM type stubs (for evaluate() callbacks that run in browser context)
// These functions run inside browser pages via Playwright's evaluate() —
// they are NOT executed in Node.js. We declare minimal stubs so TypeScript
// compiles without requiring the "dom" lib in the SDK package.
// ---------------------------------------------------------------------------
type BrowserDoc = {
	querySelector(
		sel: string,
	): { textContent?: string | null; focus?: () => void } | null;
	querySelectorAll(sel: string): ArrayLike<{ textContent?: string | null }>;
};
type BrowserGlobal = typeof globalThis & {
	document: BrowserDoc;
	__atcliGenSelector?: string;
};
const asBG = (): BrowserGlobal => globalThis as unknown as BrowserGlobal;

// ---------------------------------------------------------------------------
// Browser bridge interface
// ---------------------------------------------------------------------------

/**
 * Minimal browser control surface that the AtcliBrowserProvider needs.
 * The VS Code extension wires this to Playwright's Page API.
 * This allows the SDK package to remain environment-agnostic.
 */
export interface BrowserSessionBridge {
	/** Navigate to a URL. Waits for network idle. */
	goto(url: string): Promise<void>;

	/** Type text into a selector. */
	type(selector: string, text: string): Promise<void>;

	/** Click a selector. */
	click(selector: string): Promise<void>;

	/** Press a key on a selector. */
	press(selector: string, key: string): Promise<void>;

	/**
	 * Wait for a selector to appear in the DOM.
	 * Returns false if it times out instead of throwing.
	 */
	waitForSelector(selector: string, timeoutMs?: number): Promise<boolean>;

	/**
	 * Evaluate a function in the browser page context with optional arguments.
	 * Returns the result serialized to JSON.
	 */
	evaluate<T, A extends unknown[] = []>(
		fn: (...args: A) => T,
		...args: A
	): Promise<T>;

	/**
	 * Poll a function until it returns a non-empty string or signal aborts.
	 * Used for pseudo-streaming the AI's response.
	 */
	pollText(
		getTextFn: () => string,
		onDelta: (delta: string) => void,
		signal: AbortSignal,
	): Promise<string>;

	/** Check if the page is currently at a given URL pattern. */
	isAtUrl(urlPattern: string): Promise<boolean>;

	/** Take a screenshot for debugging. Returns base64 PNG. */
	screenshot?(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Site adapter interface
// ---------------------------------------------------------------------------

export interface AtcliBrowserSiteConfig {
	siteId: string;
	displayName: string;
	url: string;
	/** CSS selector for the chat input textarea */
	inputSelector: string;
	/** CSS selector for the send button (alternative to Enter key) */
	sendButtonSelector?: string;
	/** CSS selector for the last assistant message container */
	responseSelector: string;
	/** CSS selector to detect if a response is still generating */
	generatingIndicatorSelector?: string;
	/** How to detect if the user is logged in */
	loginCheck: (bridge: BrowserSessionBridge) => Promise<boolean>;
	/** How to clear the current chat (start fresh) */
	clearChat?: (bridge: BrowserSessionBridge) => Promise<void>;
	/** How to submit a message (some sites need custom logic) */
	submitMessage?: (bridge: BrowserSessionBridge, text: string) => Promise<void>;
	/** Extract the current assistant response text */
	extractResponseText: (bridge: BrowserSessionBridge) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Site adapters
// ---------------------------------------------------------------------------

const DEEPSEEK_ADAPTER: AtcliBrowserSiteConfig = {
	siteId: "deepseek",
	displayName: "DeepSeek",
	url: "https://chat.deepseek.com",
	inputSelector: "textarea#chat-input, textarea[placeholder*='Send']",
	responseSelector:
		".ds-markdown:last-of-type, .chat-message-item:last-child .markdown-body",
	generatingIndicatorSelector: ".chat-loading, .generating",
	loginCheck: async (bridge) => {
		return bridge.evaluate(() => {
			// Runs in browser page context
			const doc = asBG().document;
			return (
				!doc.querySelector(".login-btn") &&
				!!doc.querySelector(".chat-input-area, #chat-input")
			);
		});
	},
	clearChat: async (bridge) => {
		const newChatBtn = ".new-chat-btn, [data-testid='new-chat']";
		const exists = await bridge.waitForSelector(newChatBtn, 2000);
		if (exists) {
			await bridge.click(newChatBtn);
			await new Promise((r) => setTimeout(r, 500));
		}
	},
	extractResponseText: async (bridge) => {
		return bridge.evaluate(() => {
			const doc = asBG().document;
			const msgs = doc.querySelectorAll(
				".ds-markdown, .chat-message-item .markdown-body",
			);
			const last = msgs[msgs.length - 1];
			return last?.textContent?.trim() ?? "";
		});
	},
};

const CHATGPT_ADAPTER: AtcliBrowserSiteConfig = {
	siteId: "chatgpt",
	displayName: "ChatGPT",
	url: "https://chatgpt.com",
	inputSelector: "#prompt-textarea",
	sendButtonSelector: "[data-testid='send-button']",
	responseSelector: "[data-message-author-role='assistant']:last-of-type",
	generatingIndicatorSelector: "[data-testid='stop-button']",
	loginCheck: async (bridge) => {
		return bridge.evaluate(() => {
			const doc = asBG().document;
			return (
				!doc.querySelector("[data-testid='login-button']") &&
				!!doc.querySelector("#prompt-textarea")
			);
		});
	},
	clearChat: async (bridge) => {
		// Navigate to a fresh chat
		await bridge.goto("https://chatgpt.com");
		await bridge.waitForSelector("#prompt-textarea", 5000);
	},
	submitMessage: async (bridge, text) => {
		await bridge.type("#prompt-textarea", text);
		await new Promise((r) => setTimeout(r, 300));
		const sendBtn = await bridge.waitForSelector(
			"[data-testid='send-button']",
			3000,
		);
		if (sendBtn) {
			await bridge.click("[data-testid='send-button']");
		} else {
			await bridge.press("#prompt-textarea", "Enter");
		}
	},
	extractResponseText: async (bridge) => {
		return bridge.evaluate(() => {
			const doc = asBG().document;
			const msgs = doc.querySelectorAll(
				"[data-message-author-role='assistant']",
			);
			const last = msgs[msgs.length - 1];
			return last?.textContent?.trim() ?? "";
		});
	},
};

const GEMINI_ADAPTER: AtcliBrowserSiteConfig = {
	siteId: "gemini",
	displayName: "Gemini",
	url: "https://gemini.google.com",
	inputSelector: ".ql-editor[contenteditable='true'], rich-textarea .ql-editor",
	responseSelector: "message-content:last-of-type, model-response:last-of-type",
	generatingIndicatorSelector: ".loading-indicator, .thinking-indicator",
	loginCheck: async (bridge) => {
		return bridge.evaluate(() => {
			const doc = asBG().document;
			return (
				!doc.querySelector("[data-action='login']") &&
				!!doc.querySelector(".ql-editor, rich-textarea")
			);
		});
	},
	clearChat: async (bridge) => {
		await bridge.goto("https://gemini.google.com");
		await bridge.waitForSelector(".ql-editor, rich-textarea", 5000);
	},
	submitMessage: async (bridge, text) => {
		const selector = ".ql-editor[contenteditable='true']";
		await bridge.evaluate(() => {
			const doc = asBG().document;
			const el = doc.querySelector(".ql-editor[contenteditable='true']");
			if (
				el &&
				typeof (el as unknown as { focus?: () => void }).focus === "function"
			) {
				(el as unknown as { focus: () => void }).focus();
			}
		});
		await bridge.type(selector, text);
		await new Promise((r) => setTimeout(r, 400));
		await bridge.press(selector, "Enter");
	},
	extractResponseText: async (bridge) => {
		return bridge.evaluate(() => {
			const doc = asBG().document;
			const msgs = doc.querySelectorAll(
				"message-content, model-response .markdown",
			);
			const last = msgs[msgs.length - 1];
			return last?.textContent?.trim() ?? "";
		});
	},
};

const KIMI_ADAPTER: AtcliBrowserSiteConfig = {
	siteId: "kimi",
	displayName: "Kimi",
	url: "https://kimi.moonshot.cn",
	inputSelector: ".editor-input-box textarea, [contenteditable='true']",
	responseSelector:
		".chat-message.assistant:last-child .message-content, .segment-content:last-child",
	generatingIndicatorSelector: ".stop-btn, .generating-icon",
	loginCheck: async (bridge) => {
		return bridge.evaluate(() => {
			const doc = asBG().document;
			return (
				!doc.querySelector(".login-page") &&
				!!doc.querySelector(".editor-input-box, .chat-input")
			);
		});
	},
	clearChat: async (bridge) => {
		await bridge.goto("https://kimi.moonshot.cn");
		await bridge.waitForSelector(".editor-input-box, .chat-input", 5000);
	},
	extractResponseText: async (bridge) => {
		return bridge.evaluate(() => {
			const doc = asBG().document;
			const msgs = doc.querySelectorAll(
				".chat-message.assistant .message-content, .segment-content",
			);
			const last = msgs[msgs.length - 1];
			return last?.textContent?.trim() ?? "";
		});
	},
};

const QWEN_ADAPTER: AtcliBrowserSiteConfig = {
	siteId: "qwen",
	displayName: "Qwen (Tongyi)",
	url: "https://tongyi.aliyun.com/qianwen",
	inputSelector: "textarea.ant-input, textarea[placeholder]",
	sendButtonSelector:
		"button[type='submit'], .send-btn, [aria-label='Send message']",
	responseSelector: ".bubble-text:last-of-type, .answer-content:last-of-type",
	generatingIndicatorSelector: ".loading-mask, .typing-indicator",
	loginCheck: async (bridge) => {
		return bridge.evaluate(() => {
			const doc = asBG().document;
			return (
				!doc.querySelector(".login-page, .sign-in-btn") &&
				!!doc.querySelector("textarea, .chat-input")
			);
		});
	},
	clearChat: async (bridge) => {
		await bridge.goto("https://tongyi.aliyun.com/qianwen");
		await bridge.waitForSelector("textarea", 5000);
	},
	extractResponseText: async (bridge) => {
		return bridge.evaluate(() => {
			const doc = asBG().document;
			const msgs = doc.querySelectorAll(".bubble-text, .answer-content");
			const last = msgs[msgs.length - 1];
			return last?.textContent?.trim() ?? "";
		});
	},
};

export const ATCLI_SITE_ADAPTERS: Record<string, AtcliBrowserSiteConfig> = {
	deepseek: DEEPSEEK_ADAPTER,
	chatgpt: CHATGPT_ADAPTER,
	gemini: GEMINI_ADAPTER,
	kimi: KIMI_ADAPTER,
	qwen: QWEN_ADAPTER,
};

export type AtcliSiteId = keyof typeof ATCLI_SITE_ADAPTERS;

// ---------------------------------------------------------------------------
// Model definitions per site
// ---------------------------------------------------------------------------

export const ATCLI_SITE_MODELS: Record<
	string,
	Array<{ id: string; name: string }>
> = {
	deepseek: [
		{ id: "deepseek-chat", name: "DeepSeek Chat (Browser)" },
		{ id: "deepseek-r2", name: "DeepSeek R2 (Browser)" },
	],
	chatgpt: [
		{ id: "gpt-4o-browser", name: "GPT-4o (Browser)" },
		{ id: "o3-browser", name: "o3 (Browser)" },
		{ id: "gpt-4.1-browser", name: "GPT-4.1 (Browser)" },
	],
	gemini: [
		{ id: "gemini-2.5-pro-browser", name: "Gemini 2.5 Pro (Browser)" },
		{ id: "gemini-2.0-flash-browser", name: "Gemini 2.0 Flash (Browser)" },
	],
	kimi: [
		{ id: "kimi-k2-browser", name: "Kimi K2 (Browser)" },
		{ id: "kimi-k1.5-browser", name: "Kimi K1.5 (Browser)" },
	],
	qwen: [
		{ id: "qwen3-235b-browser", name: "Qwen3 235B (Browser)" },
		{ id: "qwq-32b-browser", name: "QwQ 32B (Browser)" },
	],
};

// ---------------------------------------------------------------------------
// Session state — tracks priming per site so we only prime once per session
// ---------------------------------------------------------------------------

const primedSessions = new Set<string>();

function getSessionKey(
	siteId: string,
	config: GatewayResolvedProviderConfig,
): string {
	return `${siteId}::${config.metadata?.sessionId ?? "default"}`;
}

// ---------------------------------------------------------------------------
// Core provider implementation
// ---------------------------------------------------------------------------

/**
 * AtcliBrowserProvider — implements the GatewayProviderFactory stream function.
 *
 * This is what gets registered as the factory for the "atcli-browser" family.
 * It handles:
 * 1. Site selection from request/config options
 * 2. Browser navigation and session priming (system prompt injection)
 * 3. Message submission
 * 4. Response streaming with tool call extraction
 * 5. Emitting AgentModelEvent values for the agent runtime
 */
async function* atcliBrowserStream(
	request: GatewayStreamRequest,
	context: GatewayProviderContext,
): AsyncIterable<AgentModelEvent> {
	const config = context.config;
	const bridge = config.options?.browserBridge as
		| BrowserSessionBridge
		| undefined;

	if (!bridge) {
		yield {
			type: "finish",
			reason: "error",
			error:
				"atcli provider: BrowserSessionBridge not configured. " +
				"Ensure the VS Code extension is active and has browser automation enabled.",
		};
		return;
	}

	// Resolve which site to use
	const siteId = (
		(config.options?.atcliSite as string | undefined) ??
		(request.metadata?.atcliSite as string | undefined) ??
		"deepseek"
	).toLowerCase();

	const adapter = ATCLI_SITE_ADAPTERS[siteId];
	if (!adapter) {
		yield {
			type: "finish",
			reason: "error",
			error: `atcli provider: Unknown site "${siteId}". Valid options: ${Object.keys(ATCLI_SITE_ADAPTERS).join(", ")}`,
		};
		return;
	}

	const signal = request.signal;

	try {
		// --- 1. Navigate to site if not already there ---
		const alreadyAtSite = await bridge.isAtUrl(adapter.url);
		if (!alreadyAtSite) {
			yield {
				type: "text-delta",
				text: `[atcli] Opening ${adapter.displayName}...\n`,
			};
			await bridge.goto(adapter.url);
		}

		// --- 2. Check login ---
		const isLoggedIn = await adapter.loginCheck(bridge);
		if (!isLoggedIn) {
			yield {
				type: "finish",
				reason: "error",
				error:
					`Not logged in to ${adapter.displayName}. ` +
					`Please open ${adapter.url} in your browser and sign in first, then try again.`,
			};
			return;
		}

		// --- 3. Prime the session (inject system prompt) ---
		const sessionKey = getSessionKey(siteId, config);
		const isPrimed = primedSessions.has(sessionKey);

		if (!isPrimed) {
			yield {
				type: "text-delta",
				text: `[atcli] Setting up ${adapter.displayName} session...\n`,
			};

			// Clear any existing chat first
			if (adapter.clearChat) {
				await adapter.clearChat(bridge);
				await new Promise((r) => setTimeout(r, 800));
			}

			// Build the system prompt from available tools
			const systemPrompt = buildAtcliSystemPrompt(
				request.tools ?? [],
				adapter.displayName,
			);
			const primingMessage =
				`[ATCLI SYSTEM CONTEXT — READ CAREFULLY AND ACKNOWLEDGE]\n\n` +
				`${systemPrompt}\n\n` +
				`Reply ONLY with: "atcli ready. Waiting for task." — ` +
				`then I will send you the actual task.`;

			await sendMessage(bridge, adapter, primingMessage);

			// Wait for acknowledgement
			let ackText = "";
			let ackAttempts = 0;
			while (!ackText.includes("atcli ready") && ackAttempts < 30) {
				await new Promise((r) => setTimeout(r, 1000));
				ackText = await adapter.extractResponseText(bridge);
				ackAttempts++;
			}

			primedSessions.add(sessionKey);
			yield {
				type: "text-delta",
				text: `[atcli] ${adapter.displayName} ready.\n\n`,
			};
		}

		// --- 4. Build the user message from request ---
		const userMessageParts: string[] = [];

		// System prompt (for first real turn)
		if (request.systemPrompt) {
			userMessageParts.push(`[Task Context]\n${request.systemPrompt}`);
		}

		// Conversation history (last few messages for context)
		const messages = request.messages ?? [];
		const recentMessages = messages.slice(-6); // Last 6 messages for context
		for (const msg of recentMessages) {
			if (msg.role === "user") {
				const textParts = msg.content
					.filter((p) => p.type === "text")
					.map((p) => (p as { type: "text"; text: string }).text)
					.join("\n");
				if (textParts) {
					userMessageParts.push(`User: ${textParts}`);
				}
			} else if (msg.role === "tool") {
				// Format tool results
				const toolResults = msg.content
					.filter((p) => p.type === "tool-result")
					.map((p) => {
						const r = p as {
							type: "tool-result";
							toolName: string;
							toolCallId: string;
							output: unknown;
							isError?: boolean;
						};
						const outputStr =
							typeof r.output === "string"
								? r.output
								: JSON.stringify(r.output, null, 2);
						return `[Tool Result: ${r.toolName}]\n${outputStr}`;
					})
					.join("\n\n---\n\n");
				if (toolResults) {
					userMessageParts.push(toolResults);
				}
			}
		}

		// The actual current user message (last user message)
		const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
		if (lastUserMsg) {
			const userText = lastUserMsg.content
				.filter((p) => p.type === "text")
				.map((p) => (p as { type: "text"; text: string }).text)
				.join("\n");
			if (userText && !userMessageParts.join("").includes(userText)) {
				userMessageParts.push(userText);
			}
		}

		const finalMessage = userMessageParts.join("\n\n");

		// --- 5. Send message to AI website ---
		yield { type: "text-delta", text: "" }; // Trigger streaming start

		await sendMessage(bridge, adapter, finalMessage);

		// --- 6. Stream and parse the response ---
		const parser = new AtcliStreamParser();
		let fullResponse = "";
		let prevLength = 0;

		// Wait for response to start
		await bridge.waitForSelector(adapter.responseSelector, 10000);

		// Poll for new text
		const maxPollTime = 180_000; // 3 minutes
		const pollInterval = 300; // ms
		const startTime = Date.now();

		let sawGenerating = false;
		while (Date.now() - startTime < maxPollTime) {
			if (signal?.aborted) {
				yield { type: "finish", reason: "aborted" };
				return;
			}

			const currentText = await adapter.extractResponseText(bridge);

			if (currentText.length > prevLength) {
				const newChunk = currentText.slice(prevLength);
				prevLength = currentText.length;
				fullResponse = currentText;

				const events = parser.feed(newChunk);
				for (const event of events) {
					yield event;
				}
			}

			// Check if still generating
			const stillGenerating = await isStillGenerating(bridge, adapter);
			if (stillGenerating) {
				sawGenerating = true;
			} else if (sawGenerating && currentText.length > 0) {
				// Wait for any remaining late tokens before breaking
				await new Promise((r) => setTimeout(r, 1000));
				const finalText = await adapter.extractResponseText(bridge);
				if (finalText.length > prevLength) {
					const remaining = finalText.slice(prevLength);
					const events = parser.feed(remaining);
					for (const event of events) {
						yield event;
					}
					fullResponse = finalText;
				}
				break;
			}

			await new Promise((r) => setTimeout(r, pollInterval));
		}

		// Flush any remaining buffered parser state
		const flushEvents = parser.flush();
		for (const event of flushEvents) {
			yield event;
		}

		// Emit usage (approximate — browser-based has no token counts)
		yield {
			type: "usage",
			usage: {
				inputTokens: estimateTokens(finalMessage),
				outputTokens: estimateTokens(fullResponse),
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			},
		};

		// Determine finish reason
		const hasToolCalls = fullResponse.includes("<tool_call>");
		yield {
			type: "finish",
			reason: (hasToolCalls ? "tool-calls" : "stop") as AgentModelFinishReason,
		};
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		yield {
			type: "finish",
			reason: "error",
			error: `atcli browser provider error: ${errorMsg}`,
		};
	}
}

/**
 * Send a text message to the AI website via the adapter's input.
 */
async function sendMessage(
	bridge: BrowserSessionBridge,
	adapter: AtcliBrowserSiteConfig,
	text: string,
): Promise<void> {
	// Wait for input to be ready
	const inputReady = await bridge.waitForSelector(adapter.inputSelector, 10000);
	if (!inputReady) {
		throw new Error(
			`Could not find input field on ${adapter.displayName}. ` +
				`Selector: ${adapter.inputSelector}`,
		);
	}

	if (adapter.submitMessage) {
		await adapter.submitMessage(bridge, text);
	} else {
		await bridge.type(adapter.inputSelector, text);
		await new Promise((r) => setTimeout(r, 200));
		await bridge.press(adapter.inputSelector, "Enter");
	}

	// Wait a moment for the message to register
	await new Promise((r) => setTimeout(r, 500));
}

/**
 * Check if the AI is still generating a response.
 */
async function isStillGenerating(
	bridge: BrowserSessionBridge,
	adapter: AtcliBrowserSiteConfig,
): Promise<boolean> {
	if (!adapter.generatingIndicatorSelector) {
		return false;
	}
	const selector = adapter.generatingIndicatorSelector;
	return bridge.evaluate((sel) => {
		const doc = asBG().document;
		return !!doc.querySelector(sel);
	}, selector);
}

/**
 * Rough token estimator (4 chars ≈ 1 token).
 */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Factory function (exported as the GatewayProviderFactory)
// ---------------------------------------------------------------------------

/**
 * Creates the atcli browser provider.
 * Called by the GatewayRegistry when the "atcli" provider is used.
 */
export const createAtcliBrowserProvider: GatewayProviderFactory = async (
	_config: GatewayResolvedProviderConfig,
) => {
	return {
		stream: async (
			request: GatewayStreamRequest,
			context: GatewayProviderContext,
		): Promise<AsyncIterable<AgentModelEvent>> => {
			return atcliBrowserStream(request, context);
		},
	};
};

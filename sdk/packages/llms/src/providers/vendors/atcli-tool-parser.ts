/**
 * atcli Browser Provider — Tool Call Parser
 *
 * Parses plain-text responses from AI websites for structured tool call blocks.
 * The AI is instructed (via system prompt) to emit tool calls in this XML format:
 *
 *   <tool_call>
 *   {"name": "read_file", "input": {"path": "src/index.ts"}}
 *   </tool_call>
 *
 * This parser produces AgentModelEvent values that the agent runtime consumes
 * identically to how it processes tool calls from API providers.
 */

import type { AgentModelEvent } from "@cline/shared";
import { nanoid } from "nanoid";

export const TOOL_CALL_OPEN_TAG = "<tool_call>";
export const TOOL_CALL_CLOSE_TAG = "</tool_call>";

export interface ParsedToolCall {
	toolCallId: string;
	toolName: string;
	input: unknown;
	rawJson: string;
}

export interface ToolCallParseError {
	rawJson: string;
	error: string;
}

/**
 * Try to parse a raw JSON string extracted from a <tool_call> block.
 * Returns either a ParsedToolCall or a ToolCallParseError.
 */
export function parseToolCallJson(
	rawJson: string,
): ParsedToolCall | ToolCallParseError {
	const trimmed = rawJson.trim();
	try {
		const parsed = JSON.parse(trimmed) as Record<string, unknown>;
		const toolName = typeof parsed.name === "string" ? parsed.name.trim() : "";
		if (!toolName) {
			return {
				rawJson: trimmed,
				error: 'Tool call JSON missing required "name" field.',
			};
		}
		const input =
			parsed.input !== undefined
				? parsed.input
				: parsed.parameters !== undefined
					? parsed.parameters
					: parsed.args !== undefined
						? parsed.args
						: {};
		return {
			toolCallId: `atcli_${nanoid()}`,
			toolName,
			input,
			rawJson: trimmed,
		};
	} catch (err) {
		return {
			rawJson: trimmed,
			error: `Failed to parse tool call JSON: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

/**
 * Result of streaming parse — classifies each chunk of the growing response.
 */
export type StreamParseResult =
	| { kind: "text"; text: string }
	| { kind: "tool-call-start"; toolCallId: string }
	| {
			kind: "tool-call-complete";
			toolCallId: string;
			toolName: string;
			input: unknown;
			inputText: string;
	  }
	| { kind: "tool-call-error"; rawJson: string; error: string };

/**
 * Stateful streaming parser.
 *
 * Feed growing response text via `feed(newChunk)` and receive a list of
 * AgentModelEvent objects to yield to the agent runtime. The parser buffers
 * text between tool call tags and emits events when complete tool call blocks
 * are detected.
 *
 * Usage:
 *   const parser = new AtcliStreamParser();
 *   for await (const chunk of browserStream) {
 *     const events = parser.feed(chunk);
 *     for (const event of events) yield event;
 *   }
 *   const finalEvents = parser.flush();
 *   for (const event of finalEvents) yield event;
 */
export class AtcliStreamParser {
	private buffer = "";
	private insideToolCall = false;
	private currentToolCallId: string | null = null;

	/**
	 * Feed a new chunk of text (delta from the AI website).
	 * Returns AgentModelEvent[] to immediately yield.
	 */
	feed(chunk: string): AgentModelEvent[] {
		this.buffer += chunk;
		return this.process();
	}

	/**
	 * Signal end-of-stream. Returns any remaining events from buffered text.
	 */
	flush(): AgentModelEvent[] {
		const events: AgentModelEvent[] = [];

		if (this.insideToolCall && this.currentToolCallId) {
			// Incomplete tool call block at end of stream — emit as error text
			events.push({
				type: "text-delta",
				text: `${TOOL_CALL_OPEN_TAG}${this.buffer}`,
			});
		} else if (this.buffer.trim()) {
			// Remaining text before any tool call
			events.push({ type: "text-delta", text: this.buffer });
		}

		this.buffer = "";
		this.insideToolCall = false;
		this.currentToolCallId = null;
		return events;
	}

	private process(): AgentModelEvent[] {
		const events: AgentModelEvent[] = [];

		while (this.buffer.length > 0) {
			if (!this.insideToolCall) {
				// Look for opening tag
				const openIdx = this.buffer.indexOf(TOOL_CALL_OPEN_TAG);

				if (openIdx === -1) {
					// No opening tag found yet — but keep potential partial tag suffix
					const suffix = longestTagSuffix(this.buffer, TOOL_CALL_OPEN_TAG);
					const safeText = this.buffer.slice(0, this.buffer.length - suffix);
					if (safeText) {
						events.push({ type: "text-delta", text: safeText });
					}
					this.buffer = this.buffer.slice(this.buffer.length - suffix);
					break;
				}

				// Emit text before the opening tag
				if (openIdx > 0) {
					events.push({
						type: "text-delta",
						text: this.buffer.slice(0, openIdx),
					});
				}
				this.buffer = this.buffer.slice(openIdx + TOOL_CALL_OPEN_TAG.length);
				this.insideToolCall = true;
				this.currentToolCallId = `atcli_${nanoid()}`;

				// Emit tool-call-delta start event
				events.push({
					type: "tool-call-delta",
					toolCallId: this.currentToolCallId,
					toolName: "",
					inputText: "",
				});
			} else {
				// Inside a tool call — look for closing tag
				const closeIdx = this.buffer.indexOf(TOOL_CALL_CLOSE_TAG);

				if (closeIdx === -1) {
					// Closing tag not yet received — check for partial suffix
					const suffix = longestTagSuffix(this.buffer, TOOL_CALL_CLOSE_TAG);
					// Emit accumulated input text (minus possible partial close tag)
					const safeContent = this.buffer.slice(0, this.buffer.length - suffix);
					if (safeContent) {
						events.push({
							type: "tool-call-delta",
							toolCallId: this.currentToolCallId ?? "atcli_tool",
							inputText: safeContent,
						});
					}
					this.buffer = this.buffer.slice(this.buffer.length - suffix);
					break;
				}

				// Extract the JSON content of the tool call
				const rawJson = this.buffer.slice(0, closeIdx);
				this.buffer = this.buffer.slice(closeIdx + TOOL_CALL_CLOSE_TAG.length);
				const toolCallId = this.currentToolCallId ?? "atcli_tool";
				this.insideToolCall = false;
				this.currentToolCallId = null;

				// Parse the tool call JSON
				const result = parseToolCallJson(rawJson);
				if ("error" in result) {
					// Emit as error text — do not treat as a tool call
					events.push({
						type: "text-delta",
						text: `${TOOL_CALL_OPEN_TAG}${rawJson}${TOOL_CALL_CLOSE_TAG}`,
					});
				} else {
					// Emit complete tool-call-delta with full input
					const inputText =
						typeof result.input === "string"
							? result.input
							: JSON.stringify(result.input);
					events.push({
						type: "tool-call-delta",
						toolCallId,
						toolName: result.toolName,
						input: result.input,
						inputText,
					});
				}
			}
		}

		return events;
	}
}

/**
 * Returns the length of the longest suffix of `text` that is a prefix of `tag`.
 * Used to avoid emitting text that might be a partial opening or closing tag.
 */
function longestTagSuffix(text: string, tag: string): number {
	for (let len = Math.min(tag.length - 1, text.length); len > 0; len--) {
		if (text.endsWith(tag.slice(0, len))) {
			return len;
		}
	}
	return 0;
}

/**
 * Parse a complete (non-streaming) response string and extract all tool calls.
 * Returns text segments and tool calls in order of appearance.
 */
export function parseCompleteResponse(responseText: string): {
	textSegments: string[];
	toolCalls: (ParsedToolCall | ToolCallParseError)[];
	orderedParts: Array<
		| { type: "text"; text: string }
		| { type: "tool-call"; call: ParsedToolCall | ToolCallParseError }
	>;
} {
	const textSegments: string[] = [];
	const toolCalls: (ParsedToolCall | ToolCallParseError)[] = [];
	const orderedParts: Array<
		| { type: "text"; text: string }
		| { type: "tool-call"; call: ParsedToolCall | ToolCallParseError }
	> = [];

	let remaining = responseText;

	while (remaining.length > 0) {
		const openIdx = remaining.indexOf(TOOL_CALL_OPEN_TAG);
		if (openIdx === -1) {
			if (remaining.trim()) {
				textSegments.push(remaining);
				orderedParts.push({ type: "text", text: remaining });
			}
			break;
		}

		// Text before the tool call
		if (openIdx > 0) {
			const text = remaining.slice(0, openIdx);
			if (text.trim()) {
				textSegments.push(text);
				orderedParts.push({ type: "text", text });
			}
		}

		remaining = remaining.slice(openIdx + TOOL_CALL_OPEN_TAG.length);
		const closeIdx = remaining.indexOf(TOOL_CALL_CLOSE_TAG);
		if (closeIdx === -1) {
			// Unclosed tag — treat as text
			const text = `${TOOL_CALL_OPEN_TAG}${remaining}`;
			if (text.trim()) {
				textSegments.push(text);
				orderedParts.push({ type: "text", text });
			}
			break;
		}

		const rawJson = remaining.slice(0, closeIdx);
		remaining = remaining.slice(closeIdx + TOOL_CALL_CLOSE_TAG.length);

		const call = parseToolCallJson(rawJson);
		toolCalls.push(call);
		orderedParts.push({ type: "tool-call", call });
	}

	return { textSegments, toolCalls, orderedParts };
}

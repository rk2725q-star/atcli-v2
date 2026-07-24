/**
 * atcli Browser Provider — System Prompt Builder
 *
 * Generates the system prompt that is injected as the first user message when
 * using atcli's browser-based provider. This prompt teaches the AI website
 * (ChatGPT, DeepSeek, Gemini, etc.) to emit tool calls in the XML format that
 * AtcliStreamParser can extract and execute.
 *
 * Since web AI UIs don't natively support tool calling, we use a prompt-engineering
 * approach similar to early Cline (pre-SDK) where the model was taught to respond
 * with XML tool call blocks.
 */

import type { AgentToolDefinition } from "@cline/shared";

export const ATCLI_TOOL_CALL_OPEN = "<tool_call>";
export const ATCLI_TOOL_CALL_CLOSE = "</tool_call>";

/**
 * Generates a compact JSON schema description for a single tool.
 */
function describeToolSchema(tool: AgentToolDefinition): string {
	const schema = tool.inputSchema as Record<string, unknown>;
	const properties =
		schema?.properties && typeof schema.properties === "object"
			? (schema.properties as Record<string, unknown>)
			: {};
	const required = Array.isArray(schema?.required)
		? (schema.required as string[])
		: [];

	const params = Object.entries(properties)
		.map(([name, def]) => {
			const d = def as Record<string, unknown>;
			const typeStr = typeof d.type === "string" ? d.type : "string";
			const desc =
				typeof d.description === "string" ? ` — ${d.description}` : "";
			const req = required.includes(name) ? " (required)" : " (optional)";
			return `    ${name}: ${typeStr}${req}${desc}`;
		})
		.join("\n");

	return [
		`  • ${tool.name}: ${tool.description}`,
		params ? `    Parameters:\n${params}` : "    Parameters: none",
	].join("\n");
}

/**
 * Build the full system prompt that teaches the AI website how to emit tool calls.
 *
 * @param tools - The list of tools available in the current session
 * @param siteName - The display name of the AI website being used
 * @returns The complete system prompt string
 */
export function buildAtcliSystemPrompt(
	tools: readonly AgentToolDefinition[],
	siteName: string,
): string {
	const toolDescriptions = tools.map(describeToolSchema).join("\n\n");

	return `You are acting as the AI backend for atcli — an autonomous coding agent running inside VS Code.

atcli controls your responses through browser automation. You are running on ${siteName}.

## Your Role

You will receive coding tasks from the user. You must help complete them by using the tools listed below. You cannot run code yourself — you respond with tool calls, atcli executes them and returns the results, then you continue.

## How to Call Tools

When you need to use a tool, output EXACTLY this format (no markdown, no extra text around the tags):

${ATCLI_TOOL_CALL_OPEN}
{"name": "tool_name", "input": {"param1": "value1", "param2": "value2"}}
${ATCLI_TOOL_CALL_CLOSE}

Rules:
1. One tool call per block. Use multiple blocks if needed but wait for each result before calling the next.
2. The JSON must be valid. Use double quotes for strings.
3. Always include the "name" field (the tool name) and "input" field (the parameters object).
4. After a tool call block, stop and wait. Do NOT continue until atcli returns the result.
5. When you receive a tool result, continue the task based on that result.
6. When the task is fully complete, call "attempt_completion" with a summary of what was done.

## Available Tools

${toolDescriptions}

## Task Flow

1. Understand the user's request.
2. Plan your approach (you can write your plan as text before tool calls).
3. Call the appropriate tools, one at a time, waiting for each result.
4. When complete, call attempt_completion.

## Important Notes

- Read files before editing them to understand their current content.
- When writing files, always write the COMPLETE file content, not just the changed parts.
- If a tool call fails, try an alternative approach.
- Be precise about file paths — use relative paths from the workspace root.
- You are operating in a real development environment. Changes are permanent.

Begin when the user sends a task.`;
}

/**
 * Builds the "priming" user message that is sent first to establish the context.
 * This is necessary because some AI websites (e.g. ChatGPT) don't have a
 * system prompt field accessible from the web UI. We send this as the first
 * user message and the AI's acknowledgement as a synthetic assistant message.
 */
export function buildAtcliPrimingMessages(
	tools: readonly AgentToolDefinition[],
	siteName: string,
): { userMessage: string; expectedAck: string } {
	const systemPrompt = buildAtcliSystemPrompt(tools, siteName);

	const userMessage = `[ATCLI SYSTEM CONTEXT - READ AND ACKNOWLEDGE]

${systemPrompt}

Reply ONLY with: "atcli ready. Waiting for task." — then I will send you the actual task.`;

	const expectedAck = "atcli ready. Waiting for task.";

	return { userMessage, expectedAck };
}

/**
 * Formats a tool result to send back to the AI website as the next user message.
 */
export function formatToolResult(
	toolName: string,
	toolCallId: string,
	output: unknown,
	isError: boolean,
): string {
	const outputStr =
		typeof output === "string" ? output : JSON.stringify(output, null, 2);

	if (isError) {
		return `[Tool Error: ${toolName} (${toolCallId})]\n${outputStr}`;
	}
	return `[Tool Result: ${toolName} (${toolCallId})]\n${outputStr}`;
}

/**
 * Formats all tool results as a single user message to send back to the AI website.
 */
export function formatToolResultsMessage(
	results: Array<{
		toolName: string;
		toolCallId: string;
		output: unknown;
		isError: boolean;
	}>,
): string {
	const parts = results.map((r) =>
		formatToolResult(r.toolName, r.toolCallId, r.output, r.isError),
	);
	return parts.join("\n\n---\n\n");
}

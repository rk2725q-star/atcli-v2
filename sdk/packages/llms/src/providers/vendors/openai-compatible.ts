import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type {
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
} from "@cline/shared";
import { wrapLanguageModel } from "ai";
import { ensureFetch, resolveApiKey } from "../http";
import { splitToolImagesMiddleware } from "../middleware/split-tool-images";
import type { ProviderFactoryResult } from "./types";

type FetchInput = Parameters<typeof fetch>[0];
type FetchWithOptionalPreconnect = typeof fetch & {
	preconnect?: (...args: unknown[]) => unknown;
};

function readAzureApiVersion(
	config: GatewayResolvedProviderConfig,
): string | undefined {
	const apiVersion = config.options?.apiVersion;
	if (typeof apiVersion !== "string") {
		return undefined;
	}
	const trimmed = apiVersion.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function shouldAddAzureApiVersion(url: URL): boolean {
	return (
		url.pathname.startsWith("/openai/deployments/") &&
		!url.searchParams.has("api-version")
	);
}

function withAzureApiVersion(
	input: FetchInput,
	apiVersion: string,
): FetchInput {
	let url: URL;
	try {
		url = new URL(input instanceof Request ? input.url : input.toString());
	} catch {
		return input;
	}
	if (!shouldAddAzureApiVersion(url)) {
		return input;
	}
	url.searchParams.set("api-version", apiVersion);
	if (input instanceof Request) {
		return new Request(url.toString(), input);
	}
	return (typeof input === "string" ? url.toString() : url) as FetchInput;
}

function createAzureApiVersionFetch(
	config: GatewayResolvedProviderConfig,
): typeof fetch | undefined {
	const apiVersion = readAzureApiVersion(config);
	if (!apiVersion) {
		return config.fetch;
	}
	const baseFetch = config.fetch ?? globalThis.fetch;
	if (!baseFetch) {
		return config.fetch;
	}
	const azureFetch = ((input, init) =>
		baseFetch(withAzureApiVersion(input, apiVersion), init)) as typeof fetch;
	const baseFetchWithPreconnect = baseFetch as FetchWithOptionalPreconnect;
	(azureFetch as FetchWithOptionalPreconnect).preconnect =
		typeof baseFetchWithPreconnect.preconnect === "function"
			? baseFetchWithPreconnect.preconnect.bind(baseFetch)
			: () => undefined;
	return azureFetch;
}

type ResponseErrorHandler = (response: Response) => Promise<void> | void;

function readResponseErrorHandler(
	config: GatewayResolvedProviderConfig,
): ResponseErrorHandler | undefined {
	const handler = config.options?.onResponseError;
	return typeof handler === "function"
		? (handler as ResponseErrorHandler)
		: undefined;
}

function createResponseErrorFetch(input: {
	fetch: typeof fetch;
	onResponseError: ResponseErrorHandler;
}): typeof fetch {
	const responseErrorFetch = (async (requestInput, init) => {
		const response = await input.fetch(requestInput, init);

		await input.onResponseError(response);

		return response;
	}) as typeof fetch;

	const baseFetchWithPreconnect = input.fetch as FetchWithOptionalPreconnect;
	(responseErrorFetch as FetchWithOptionalPreconnect).preconnect =
		typeof baseFetchWithPreconnect.preconnect === "function"
			? baseFetchWithPreconnect.preconnect.bind(input.fetch)
			: () => undefined;
	return responseErrorFetch;
}

function withNvidiaNimConfig(
	input: FetchInput,
	init: Parameters<typeof fetch>[1],
): Parameters<typeof fetch>[1] {
	if (!init || !init.body || typeof init.body !== "string") {
		return init;
	}

	let url: URL;
	try {
		url = new URL(input instanceof Request ? input.url : input.toString());
	} catch {
		return init;
	}

	if (!url.hostname.includes("nvidia.com")) {
		return init;
	}

	try {
		const body = JSON.parse(init.body);
		let modified = false;

		// Convert developer role to system role for all NVIDIA NIM models
		if (Array.isArray(body.messages)) {
			for (const msg of body.messages) {
				if (msg.role === "developer") {
					msg.role = "system";
					modified = true;
				}
			}
		}

		// Normalize short model IDs to vendor-prefixed format for NVIDIA NIM
		if (typeof body.model === "string" && !body.model.includes("/")) {
			const rawModel = body.model.toLowerCase().trim();
			if (rawModel.includes("llama-3.3-70b")) {
				body.model = "meta/llama-3.3-70b-instruct";
				modified = true;
			} else if (rawModel.includes("llama-3.1-405b")) {
				body.model = "meta/llama-3.1-405b-instruct";
				modified = true;
			} else if (rawModel.includes("llama-3.1-70b")) {
				body.model = "meta/llama-3.1-70b-instruct";
				modified = true;
			} else if (rawModel.includes("llama-3.1-8b")) {
				body.model = "meta/llama-3.1-8b-instruct";
				modified = true;
			} else if (rawModel.includes("deepseek-r1")) {
				body.model = "deepseek-ai/deepseek-r1";
				modified = true;
			} else if (rawModel.includes("deepseek-v3")) {
				body.model = "deepseek-ai/deepseek-v3";
				modified = true;
			} else if (rawModel.includes("nemotron")) {
				body.model = "nvidia/llama-3.1-nemotron-70b-instruct";
				modified = true;
			} else if (rawModel.includes("qwen")) {
				body.model = "qwen/qwen2.5-coder-32b-instruct";
				modified = true;
			} else if (rawModel.includes("mistral")) {
				body.model = "mistralai/mistral-large-2411";
				modified = true;
			}
		}

		if (typeof body.model === "string" && body.model.includes("glm")) {
			// NVIDIA NIM's GLM models expect chat_template_kwargs for thinking
			const reasoningEffort = body.reasoning_effort;
			body.chat_template_kwargs = {
				enable_thinking: reasoningEffort ? reasoningEffort !== "none" : true,
			};
			modified = true;
		}

		if (modified) {
			return {
				...init,
				body: JSON.stringify(body),
			};
		}
	} catch {
		return init;
	}

	return init;
}

function createNvidiaNimFetch(baseFetch: typeof fetch): typeof fetch {
	const nvidiaFetch = (async (input, init) => {
		const modifiedInit = withNvidiaNimConfig(input, init);
		const response = await baseFetch(input, modifiedInit);

		let urlStr = "";
		try {
			urlStr = input instanceof Request ? input.url : input.toString();
		} catch {}

		if (
			response.body &&
			response.headers.get("content-type")?.includes("text/event-stream") &&
			urlStr.includes("integrate.api.nvidia.com")
		) {
			let buffer = "";
			const transformStream = new TransformStream({
				transform(chunk: Uint8Array, controller) {
					buffer += new TextDecoder().decode(chunk, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const line of lines) {
						if (line.startsWith("data: ") && line.trim() !== "data: [DONE]") {
							try {
								const jsonStr = line.slice(6);
								const data = JSON.parse(jsonStr);
								let modified = false;
								if (data.choices && data.choices.length > 0) {
									const delta = data.choices[0].delta;
									if (delta) {
										// If content is empty/missing and reasoning_content is present
										if (!delta.content && delta.reasoning_content) {
											delta.content = delta.reasoning_content;
											delete delta.reasoning_content;
											modified = true;
										}
									}
								}
								if (modified) {
									controller.enqueue(
										new TextEncoder().encode(`data: ${JSON.stringify(data)}\n`),
									);
									continue;
								}
							} catch {
								// ignore parse errors, just pass through
							}
						}
						controller.enqueue(new TextEncoder().encode(`${line}\n`));
					}
				},
				flush(controller) {
					if (buffer) {
						controller.enqueue(new TextEncoder().encode(buffer));
					}
				},
			});
			return new Response(response.body.pipeThrough(transformStream), {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		}

		return response;
	}) as typeof fetch;

	const baseFetchWithPreconnect = baseFetch as FetchWithOptionalPreconnect;
	(nvidiaFetch as FetchWithOptionalPreconnect).preconnect =
		typeof baseFetchWithPreconnect.preconnect === "function"
			? baseFetchWithPreconnect.preconnect.bind(baseFetch)
			: () => undefined;
	return nvidiaFetch;
}

export async function createOpenAICompatibleProviderModule(
	config: GatewayResolvedProviderConfig,
	context: GatewayProviderContext,
): Promise<ProviderFactoryResult> {
	// Don't preflight-check for a missing API key. If credentials are
	// missing or wrong, the provider's own response (e.g. 401) is the
	// authoritative error and is surfaced to the user as-is. This keeps
	// `llms` unopinionated about which providers do or don't need a key.
	const apiKey = await resolveApiKey(config);
	let fetch =
		createAzureApiVersionFetch(config) ?? config.fetch ?? globalThis.fetch;
	fetch = createNvidiaNimFetch(fetch);
	const onResponseError = readResponseErrorHandler(config);
	const providerFetch = onResponseError
		? createResponseErrorFetch({
				fetch: ensureFetch(fetch),
				onResponseError,
			})
		: fetch;
	const provider = createOpenAICompatible({
		name: context.provider.id,
		apiKey,
		...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
		...(config.headers ? { headers: config.headers } : {}),
		...(providerFetch ? { fetch: providerFetch } : {}),
		includeUsage: true,
	} as never);
	return {
		// Wrap each constructed model with `splitToolImagesMiddleware` so
		// `role:"tool"` messages whose `output.type === 'content'` carries
		// image-data parts get split into a placeholder text + a synthetic
		// `role:"user"` message carrying the images. The OpenAI Chat
		// Completions wire format does NOT support multimodal tool messages
		// (the `@ai-sdk/openai-compatible` chat-messages converter
		// `JSON.stringify`s the parts array, losing image bytes). The
		// middleware operates on the typed `LanguageModelV3Prompt` BEFORE
		// the converter runs, so the converter sees only text-only tool
		// messages with adjacent multimodal user messages — the wire
		// pattern that classic Cline used in production for years (see
		// `convertToOpenAiMessages` in `src/core/api/transform/openai-format.ts`
		// on origin/main).
		model: (modelId) =>
			wrapLanguageModel({
				model: provider(modelId) as LanguageModelV3,
				middleware: splitToolImagesMiddleware,
			}),
	};
}

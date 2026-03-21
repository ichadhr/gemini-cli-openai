import { Hono } from "hono";
import { Env, ChatCompletionRequest, ChatCompletionResponse, ChatMessage, ModelInfo, MessageContent } from "../types";
import { DEFAULT_MODEL, getAllModelIds } from "../config";
import { OPENAI_MODEL_OWNER } from "../config";
import { DEFAULT_THINKING_BUDGET, MIME_TYPE_MAP } from "../config";
import { MultiAccountManager } from "../services/account";
import { GeminiApiClient } from "../services";
import { createOpenAIStreamTransformer } from "../transformers";
import { isMediaTypeSupported, validateContent, validateModel } from "../utils/validation";
import { errors } from "../utils/errors";
import { Buffer } from "node:buffer";

/**
 * OpenAI-compatible API routes for models and chat completions.
 */
export const OpenAIRoute = new Hono<{ Bindings: Env }>();

/**
 * Detect if conversation is in tool-calling mode.
 *
 * Tool-calling conversations have these characteristics:
 * - Messages with role: "tool" (tool responses)
 * - Assistant messages with tool_calls array
 * - Request includes tools parameter
 *
 * This detection is used to enable sticky account mapping, ensuring
 * all turns in a multi-turn tool-calling conversation use the same
 * GCP account for consistency.
 *
 * @param messages - Array of chat messages
 * @returns boolean - True if this is a tool-calling conversation
 */
function isToolCallingConversation(messages: ChatMessage[]): boolean {
	if (!messages || messages.length === 0) {
		return false;
	}

	for (const msg of messages) {
		// Check for tool role messages (tool responses)
		if (msg.role === "tool") {
			return true;
		}

		// Check for assistant messages with tool_calls
		if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
			return true;
		}
	}

	return false;
}

/**
 * Get conversation ID for sticky session.
 * Returns undefined for non-tool-calling conversations (use round-robin).
 *
 * Priority:
 * 1. Client-provided X-Conversation-ID header (explicit)
 * 2. Hash of first user message (for tool-calling only)
 * 3. undefined (for normal chat - use round-robin)
 *
 * @param messages - Array of chat messages
 * @param headerId - Optional conversation ID from X-Conversation-ID header
 * @returns string | undefined - The conversation ID, or undefined for round-robin
 */
function getConversationId(messages: ChatMessage[], headerId?: string): string | undefined {
	// Priority 1: Use client-provided header
	if (headerId && headerId.trim().length > 0) {
		return headerId.trim();
	}

	// Priority 2: Check if this is a tool-calling conversation
	const hasToolCalls = messages.some(msg =>
		msg.role === "tool" ||
		(msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0)
	);

	if (!hasToolCalls) {
		return undefined; // Normal chat - use round-robin
	}

	// Priority 3: Generate from first user message
	const firstUserMessage = messages.find((msg) => msg.role === "user");
	if (firstUserMessage) {
		// Extract text content from message
		let content = "";
		if (typeof firstUserMessage.content === "string") {
			content = firstUserMessage.content;
		} else if (Array.isArray(firstUserMessage.content)) {
			// For array content, concatenate all text parts
			content = firstUserMessage.content
				.filter((part) => part.type === "text")
				.map((part) => part.text || "")
				.join(" ");
		}

		if (content.trim().length > 0) {
			// Use djb2 hash algorithm (consistent with account-manager)
			let hash = 5381;
			for (let i = 0; i < content.length; i++) {
				hash = ((hash << 5) + hash) + content.charCodeAt(i);
			}
			const hashHex = (hash >>> 0).toString(16);
			return `conv_${hashHex}`;
		}
	}

	// Fallback: Generate a random UUID (should rarely happen)
	return `conv_${crypto.randomUUID()}`;
}

// List available models
OpenAIRoute.get("/models", async (c) => {
	const modelData = getAllModelIds().map((modelId) => ({
		id: modelId,
		object: "model",
		created: Math.floor(Date.now() / 1000),
		owned_by: OPENAI_MODEL_OWNER
	}));

	return c.json({
		object: "list",
		data: modelData
	});
});

// Chat completions endpoint
OpenAIRoute.post("/chat/completions", async (c) => {
	try {
		console.log("Chat completions request received");
		const body = await c.req.json<ChatCompletionRequest>();
		const model = body.model || DEFAULT_MODEL;
		const messages = body.messages || [];
		// OpenAI API compatibility: stream defaults to false unless explicitly set to true
		const stream = body.stream === true;

		// Check environment settings for real thinking
		const isRealThinkingEnabled = c.env.ENABLE_REAL_THINKING === "true";
		let includeReasoning = isRealThinkingEnabled; // Automatically enable reasoning when real thinking is enabled
		let thinkingBudget = body.thinking_budget ?? DEFAULT_THINKING_BUDGET; // Default to dynamic allocation

		// Newly added parameters
		const generationOptions = {
			max_tokens: body.max_tokens,
			temperature: body.temperature,
			top_p: body.top_p,
			stop: body.stop,
			presence_penalty: body.presence_penalty,
			frequency_penalty: body.frequency_penalty,
			seed: body.seed,
			response_format: body.response_format
		};

		// Handle effort level mapping to thinking_budget (check multiple locations for client compatibility)
		const reasoning_effort =
			body.reasoning_effort || body.extra_body?.reasoning_effort || body.model_params?.reasoning_effort;
		if (reasoning_effort) {
			includeReasoning = true; // Effort implies reasoning
			const isFlashModel = model.includes("flash");
			switch (reasoning_effort) {
				case "low":
					thinkingBudget = 1024;
					break;
				case "medium":
					thinkingBudget = isFlashModel ? 12288 : 16384;
					break;
				case "high":
					thinkingBudget = isFlashModel ? 24576 : 32768;
					break;
				case "none":
					thinkingBudget = 0;
					includeReasoning = false;
					break;
			}
		}

		const tools = body.tools;
		const tool_choice = body.tool_choice;

		console.log("Request body parsed:", {
			model,
			messageCount: messages.length,
			stream,
			includeReasoning,
			thinkingBudget,
			tools,
			tool_choice
		});

		if (!messages.length) {
			return c.json(errors.missingField("messages"), 400);
		}

		// Validate model
		const modelValidation = validateModel(model);
		if (!modelValidation.isValid) {
			return c.json(errors.invalidRequest(modelValidation.error ?? "Invalid model specified", "model"), 400);
		}

		// Unified media validation
		const mediaChecks: {
			type: string;
			supportKey: keyof ModelInfo;
			name: string;
		}[] = [
			{ type: "image_url", supportKey: "supportsImages", name: "image inputs" },
			{ type: "input_audio", supportKey: "supportsAudios", name: "audio inputs" },
			{ type: "input_video", supportKey: "supportsVideos", name: "video inputs" },
			{ type: "input_pdf", supportKey: "supportsPdfs", name: "PDF inputs" }
		];

		for (const { type, supportKey, name } of mediaChecks) {
			const messagesWithMedia = messages.filter(
				(msg) => Array.isArray(msg.content) && msg.content.some((content) => content.type === type)
			);

			if (messagesWithMedia.length > 0) {
				if (!isMediaTypeSupported(model, supportKey)) {
					return c.json(
						errors.invalidRequest(`Model '${model}' does not support ${name}.`),
						400
					);
				}

				for (const msg of messagesWithMedia) {
					for (const content of msg.content as MessageContent[]) {
						if (content.type === type) {
							const { isValid, error } = validateContent(type, content);
							if (!isValid) {
								return c.json(errors.invalidRequest(error ?? `Invalid ${name}`), 400);
							}
						}
					}
				}
			}
		}

		// Extract system prompt and user/assistant messages
		let systemPrompt = "";
		const otherMessages = messages.filter((msg) => {
			if (msg.role === "system") {
				// Handle system messages with both string and array content
				if (typeof msg.content === "string") {
					systemPrompt = msg.content;
				} else if (Array.isArray(msg.content)) {
					// For system messages, only extract text content
					const textContent = msg.content
						.filter((part) => part.type === "text")
						.map((part) => part.text || "")
						.join(" ");
					systemPrompt = textContent;
				}
				return false;
			}
			return true;
		});

		// Initialize services
		const multiAccountManager = new MultiAccountManager(c.env);
		const geminiClient = new GeminiApiClient(c.env, multiAccountManager);

		/**
		 * Sticky Account for Tool-Calling Conversations
		 *
		 * Problem: Multi-turn tool calling breaks with per-request rotation because
		 * each turn may hit a different GCP account, causing inconsistent configs,
		 * unpredictable rate limits, and scattered logs.
		 *
		 * Solution: When a conversation involves tool calling, stick to ONE account
		 * for ALL turns in that conversation.
		 */
		const isToolCalling = isToolCallingConversation(messages);
		const conversationIdHeader = c.req.header("X-Conversation-ID");
		const conversationId = getConversationId(messages, conversationIdHeader);

		if (stream) {
			// Streaming response
			const { readable, writable } = new TransformStream();
			const writer = writable.getWriter();
			const openAITransformer = createOpenAIStreamTransformer(model);
			const openAIStream = readable.pipeThrough(openAITransformer);

			// Asynchronously pipe data from Gemini to transformer
			(async () => {
				try {
					console.log("Starting stream generation");
					const geminiStream = geminiClient.streamContent(model, systemPrompt, otherMessages, {
						includeReasoning,
						thinkingBudget,
						tools,
						tool_choice,
						conversationId: isToolCalling ? conversationId : undefined, // Pass conversationId for sticky account
						...generationOptions
					});

					for await (const chunk of geminiStream) {
						await writer.write(chunk);
					}
					console.log("Stream completed successfully");
					await writer.close();
				} catch (streamError: unknown) {
					const errorMessage = streamError instanceof Error ? streamError.message : String(streamError);
					console.error("Stream error:", errorMessage);
					// Try to write an error chunk before closing
					await writer.write({
						type: "text",
						data: `Error: ${errorMessage}`
					});
					await writer.close();
				}
			})();

			// Return streaming response
			console.log("Returning streaming response");
			return new Response(openAIStream, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
					"Access-Control-Allow-Headers": "Content-Type, Authorization"
				}
			});
		} else {
			// Non-streaming response
			try {
				console.log("Starting non-streaming completion");
				const completion = await geminiClient.getCompletion(model, systemPrompt, otherMessages, {
					includeReasoning,
					thinkingBudget,
					tools,
					tool_choice,
					conversationId: isToolCalling ? conversationId : undefined, // Pass conversationId for sticky account
					...generationOptions
				});

				const response: ChatCompletionResponse = {
					id: `chatcmpl-${crypto.randomUUID()}`,
					object: "chat.completion",
					created: Math.floor(Date.now() / 1000),
					model: model,
					choices: [
						{
							index: 0,
							message: {
								role: "assistant",
								content: completion.content,
								tool_calls: completion.tool_calls
							},
							finish_reason: completion.tool_calls && completion.tool_calls.length > 0 ? "tool_calls" : "stop"
						}
					]
				};

				// Add usage information if available
				if (completion.usage) {
					response.usage = {
						prompt_tokens: completion.usage.inputTokens,
						completion_tokens: completion.usage.outputTokens,
						total_tokens: completion.usage.inputTokens + completion.usage.outputTokens
					};
				}

				console.log("Non-streaming completion successful");
				return c.json(response);
			} catch (completionError: unknown) {
				const errorMessage = completionError instanceof Error ? completionError.message : String(completionError);
				console.error("Completion error:", errorMessage);
				return c.json(errors.server(errorMessage), 500);
			}
		}
	} catch (e: unknown) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		console.error("Top-level error:", e);
		return c.json(errors.server(errorMessage), 500);
	}
});

// Audio transcriptions endpoint
OpenAIRoute.post("/audio/transcriptions", async (c) => {
	try {
		console.log("Audio transcription request received");
		const body = await c.req.parseBody();
		const file = body["file"];
		const model = (body["model"] as string) || DEFAULT_MODEL;
		const prompt = (body["prompt"] as string) || "Transcribe this audio in detail.";

		if (!file || !(file instanceof File)) {
			return c.json(errors.missingField("file"), 400);
		}

		// Validate model
		const modelValidation = validateModel(model);
		if (!modelValidation.isValid) {
			return c.json(errors.invalidRequest(modelValidation.error ?? "Invalid model specified", "model"), 400);
		}

		let mimeType = file.type;

		// Fallback for application/octet-stream
		if (mimeType === "application/octet-stream" && file.name) {
			const ext = file.name.split(".").pop()?.toLowerCase();
			if (ext && MIME_TYPE_MAP[ext]) {
				mimeType = MIME_TYPE_MAP[ext];
				console.log(`Detected MIME type from extension .${ext}: ${mimeType}`);
			}
		}

		// Check for video or audio support based on MIME type
		const isVideo = mimeType.startsWith("video/");
		// gemini can generate transcriptions of videos too
		const isAudio = mimeType.startsWith("audio/");

		if (isVideo) {
			if (!isMediaTypeSupported(model, "supportsVideos")) {
				return c.json(
					errors.invalidRequest(`Model '${model}' does not support video inputs.`),
					400
				);
			}
		} else if (isAudio) {
			if (!isMediaTypeSupported(model, "supportsAudios")) {
				return c.json(
					errors.invalidRequest(`Model '${model}' does not support audio inputs.`),
					400
				);
			}
		} else {
			return c.json(
				errors.invalidRequest(`Unsupported media type: ${mimeType}. Only audio and video files are supported.`),
				400
			);
		}

		// Convert File to base64
		const arrayBuffer = await file.arrayBuffer();
		console.log(`Processing audio file: size=${arrayBuffer.byteLength} bytes, type=${file.type}`);

		let base64Audio: string;
		try {
			base64Audio = Buffer.from(arrayBuffer).toString("base64");
		} catch (e: unknown) {
			const errorMessage = e instanceof Error ? e.message : String(e);
			console.error("Base64 conversion failed:", errorMessage);
			throw new Error(`Failed to process audio file: ${errorMessage}`);
		}

		// Construct message
		const messages: ChatMessage[] = [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: prompt
					},
					{
						type: "input_audio",
						input_audio: {
							data: base64Audio,
							format: mimeType
						}
					}
				]
			}
		];

		// Initialize client
		const multiAccountManager = new MultiAccountManager(c.env);
		const geminiClient = new GeminiApiClient(c.env, multiAccountManager);

		// Get completion
		const completion = await geminiClient.getCompletion(model, "", messages);

		return c.json({ text: completion.content });
	} catch (e: unknown) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		console.error("Transcription error:", errorMessage);
		return c.json(errors.server(errorMessage), 500);
	}
});

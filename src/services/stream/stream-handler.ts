import {
	Env,
	StreamChunk,
	UsageData,
	ChatMessage,
	Tool,
	ToolChoice,
	GeminiFunctionCall,
	GeminiResponse,
	StreamRequest
} from "../../types";
import { AuthManager } from "../auth";
import { MultiAccountManager } from "../account";
import { MessageFormatter } from "../message";
import { SSEParser, parseSSEStream, ThinkingState } from "./sse-parser";
import { NativeToolsManager, CitationsProcessor } from "../tools";
import { AutoModelSwitchingHelper } from "../../helpers/auto-model-switching";
import { CODE_ASSIST_ENDPOINT, CODE_ASSIST_API_VERSION } from "../../config";
import { NativeToolsRequestParams } from "../../types/native-tools";

/**
 * StreamHandler service for making HTTP requests to Gemini API
 * and handling both streaming and non-streaming responses.
 * Implements retry logic, account rotation, and auto model switching.
 */
export class StreamHandler {
	private autoSwitchHelper: AutoModelSwitchingHelper;

	constructor(
		private env: Env,
		private multiAccountManager: MultiAccountManager,
		private messageFormatter: MessageFormatter,
		private sseParser: SSEParser,
		private projectIdGetter: (authManager: AuthManager) => Promise<string>
	) {
		this.autoSwitchHelper = new AutoModelSwitchingHelper(env);
	}

	/**
	 * Performs the actual stream request with retry logic for 401 errors and auto model switching for rate limits.
	 */
	async *performStreamRequest(
		streamRequest: StreamRequest,
		authManager: AuthManager,
		needsThinkingClose: boolean = false,
		isRetry: boolean = false,
		realThinkingAsContent: boolean = false,
		originalModel?: string,
		nativeToolsManager?: NativeToolsManager,
		retryAttempt: number = 0,
		conversationId?: string
	): AsyncGenerator<StreamChunk> {
		// Ensure auth is initialized (redundant but safe)
		await authManager.initializeAuth();
		console.log(
			`[Mitigation] Stream request attempt ${retryAttempt + 1} with account GCP_SERVICE_ACCOUNT_${authManager.id}: ${authManager.accountName}${originalModel ? `, model: ${originalModel}` : ""}`
		);

		const citationsProcessor = new CitationsProcessor(this.env);
		const response = await fetch(`${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:streamGenerateContent?alt=sse`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${authManager.getAccessToken()}`
			},
			body: JSON.stringify(streamRequest)
		});

		if (!response.ok) {
			// Handle 401: Clear token and retry with SAME account (refresh token flow) if not already retried
			if (response.status === 401 && !isRetry) {
				console.log(`[Mitigation] Sequence step: 401 error - Token refresh for GCP_SERVICE_ACCOUNT_${authManager.id}: ${authManager.accountName}`);
				await authManager.clearTokenCache();
				await authManager.initializeAuth();
				yield* this.performStreamRequest(
					streamRequest,
					authManager,
					needsThinkingClose,
					true,
					realThinkingAsContent,
					originalModel,
					nativeToolsManager,
					retryAttempt
				);
				return;
			}

			// Handle Rate Limits (429/503): Report failure and switch account
			if (response.status === 429 || response.status === 503) {
				console.log(
					`[Mitigation] Sequence step: Rate limit (${response.status}) - Account rotation initiated from GCP_SERVICE_ACCOUNT_${authManager.id}: ${authManager.accountName}`
				);
				await this.multiAccountManager.reportFailure(authManager, response.status);

				// Retry with next account if we haven't tried too many times (e.g., 3 * number of accounts)
				// We use a safe upper bound to prevent infinite loops
				const maxRetries = this.multiAccountManager.getAccountCount() * 3;

				if (retryAttempt < maxRetries) {
					// Get a NEW account for retry
					const nextAuthManager = await this.multiAccountManager.getAccount();
					console.log(
						`[Mitigation] Account rotation: Attempt ${retryAttempt + 1}/${maxRetries} - Selected GCP_SERVICE_ACCOUNT_${nextAuthManager.id}: ${nextAuthManager.accountName}`
					);

					// NEW: Update sticky mapping if this is a tool-calling conversation
					if (conversationId) {
						await this.multiAccountManager.updateStickyAccount(
							conversationId,
							nextAuthManager.id
						);
					}

					// If we switch accounts, we should probably check if project ID is different.
					let nextProjectId = "";
					try {
						nextProjectId = await this.projectIdGetter(nextAuthManager);
					} catch (e) {
						console.error("Failed to get project for next account", e);
						// Keep going?
					}

					// Update project in request if possible
					if (nextProjectId && streamRequest.project) {
						streamRequest.project = nextProjectId;
					}

					yield* this.performStreamRequest(
						streamRequest,
						nextAuthManager,
						needsThinkingClose,
						false,
						realThinkingAsContent,
						originalModel,
						nativeToolsManager,
						retryAttempt + 1,
						conversationId
					);
					return;
				} else {
					console.error("Max retries reached for rate limiting.");
					// Fall through to auto model switching (if enabled) or error
				}
			}

			// Handle rate limiting with auto model switching (only if we exhausted account retries or it's a different error)
			// Note: We prioritize account rotation over model switching. Model switching is the last resort.
			if (
				this.autoSwitchHelper.isRateLimitStatus(response.status) &&
				!isRetry &&
				originalModel &&
				this.autoSwitchHelper.shouldAttemptFallback(originalModel)
			) {
				const fallbackModel = this.autoSwitchHelper.getFallbackModel(originalModel);
				if (fallbackModel && this.autoSwitchHelper.isEnabled()) {
					console.log(
						`[Mitigation] Sequence step: Rate limit (${response.status}) - Model fallback from ${originalModel} to ${fallbackModel} (account rotation exhausted)`
					);

					// Create new request with fallback model
					const fallbackRequest: StreamRequest = {
						...streamRequest,
						model: fallbackModel
					};

					// Add a notification chunk about the model switch
					yield {
						type: "text",
						data: this.autoSwitchHelper.createSwitchNotification(originalModel, fallbackModel)
					};

					yield* this.performStreamRequest(
						fallbackRequest,
						authManager,
						needsThinkingClose,
						true,
						realThinkingAsContent,
						originalModel,
						nativeToolsManager,
						retryAttempt
					);
					return;
				}
			}

			const errorText = await response.text();
			console.error(`[GeminiAPI] Stream request failed: ${response.status}`, errorText);
			console.error(`[DEBUG] Request payload:`, JSON.stringify(streamRequest, null, 2));
			throw new Error(`Stream request failed: ${response.status}`);
		}

		if (!response.body) {
			throw new Error("Response has no body");
		}

		let state: ThinkingState = {
			hasClosedThinking: false,
			hasStartedThinking: false
		};

		let buffer = "";
		let objectBuffer = "";
		let lastFlushTime = Date.now();

		for await (const chunk of parseSSEStream(response.body)) {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				if (line.trim() === "") {
					if (objectBuffer) {
						try {
							const jsonData: GeminiResponse = JSON.parse(objectBuffer);
							const candidate = jsonData.response?.candidates?.[0];

							if (candidate?.content?.parts) {
								state = yield* this.sseParser.processCandidateParts(
									candidate.content.parts,
									jsonData,
									realThinkingAsContent,
									needsThinkingClose,
									state,
									nativeToolsManager,
									citationsProcessor
								);
							}

							if (jsonData.response?.usageMetadata) {
								const usageData = this.sseParser.createUsageData(jsonData.response.usageMetadata);
								yield {
									type: "usage",
									data: usageData
								};
							}
						} catch (e) {
							console.error("Error parsing SSE JSON object:", e);
						}
						objectBuffer = "";
						lastFlushTime = Date.now();
					}
				} else if (line.startsWith("data: ")) {
					objectBuffer += line.substring(6);
					// Flush mechanism: try to parse periodically if buffer is accumulating
					if (Date.now() - lastFlushTime > 100 && objectBuffer) {
						try {
							const jsonData: GeminiResponse = JSON.parse(objectBuffer);
							const candidate = jsonData.response?.candidates?.[0];

							if (candidate?.content?.parts) {
								state = yield* this.sseParser.processCandidateParts(
									candidate.content.parts,
									jsonData,
									realThinkingAsContent,
									needsThinkingClose,
									state,
									nativeToolsManager,
									citationsProcessor
								);
							}

							if (jsonData.response?.usageMetadata) {
								const usageData = this.sseParser.createUsageData(jsonData.response.usageMetadata);
								yield {
									type: "usage",
									data: usageData
								};
							}
							objectBuffer = "";
							lastFlushTime = Date.now();
						} catch {
							// Not ready yet, continue accumulating
						}
					}
				}
			}
		}

		// Handle any remaining buffered data
		if (objectBuffer) {
			try {
				const jsonData: GeminiResponse = JSON.parse(objectBuffer);
				const candidate = jsonData.response?.candidates?.[0];

				if (candidate?.content?.parts) {
					state = yield* this.sseParser.processCandidateParts(
						candidate.content.parts,
						jsonData,
						realThinkingAsContent,
						needsThinkingClose,
						state,
						nativeToolsManager,
						citationsProcessor
					);
				}

				if (jsonData.response?.usageMetadata) {
					const usageData = this.sseParser.createUsageData(jsonData.response.usageMetadata);
					yield {
						type: "usage",
						data: usageData
					};
				}
			} catch (e) {
				console.error("Error parsing final SSE JSON object:", e);
			}
		}
	}

	/**
	 * Get a complete response from Gemini API (non-streaming).
	 * This method collects all chunks from the stream and returns the final result.
	 */
	async getCompletion(
		streamContentFn: (
			modelId: string,
			systemPrompt: string,
			messages: ChatMessage[],
			options?: {
				includeReasoning?: boolean;
				thinkingBudget?: number;
				tools?: Tool[];
				tool_choice?: ToolChoice;
				max_tokens?: number;
				temperature?: number;
				top_p?: number;
				stop?: string | string[];
				presence_penalty?: number;
				frequency_penalty?: number;
				seed?: number;
				response_format?: { type: "text" | "json_object" };
				conversationId?: string; // For sticky account mapping
			} & NativeToolsRequestParams
		) => AsyncGenerator<StreamChunk>,
		modelId: string,
		systemPrompt: string,
		messages: ChatMessage[],
		options?: {
			includeReasoning?: boolean;
			thinkingBudget?: number;
			tools?: Tool[];
			tool_choice?: ToolChoice;
			max_tokens?: number;
			temperature?: number;
			top_p?: number;
			stop?: string | string[];
			presence_penalty?: number;
			frequency_penalty?: number;
			seed?: number;
			response_format?: { type: "text" | "json_object" };
			conversationId?: string; // For sticky account mapping
		} & NativeToolsRequestParams
	): Promise<{
		content: string;
		usage?: UsageData;
		tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
	}> {
		try {
			let content = "";
			let usage: UsageData | undefined;
			const tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];

			// Collect all chunks from the stream
			for await (const chunk of streamContentFn(modelId, systemPrompt, messages, options)) {
				if (chunk.type === "text" && typeof chunk.data === "string") {
					content += chunk.data;
				} else if (chunk.type === "usage" && typeof chunk.data === "object") {
					usage = chunk.data as UsageData;
				} else if (chunk.type === "tool_code" && typeof chunk.data === "object") {
					const toolData = chunk.data as GeminiFunctionCall;
					tool_calls.push({
						id: `call_${crypto.randomUUID()}`,
						type: "function",
						function: {
							name: toolData.name,
							arguments: JSON.stringify(toolData.args)
						}
					});
				}
				// Skip reasoning chunks for non-streaming responses
			}

			return {
				content,
				usage,
				tool_calls: tool_calls.length > 0 ? tool_calls : undefined
			};
		} catch (error: unknown) {
			// Handle rate limiting for non-streaming requests
			if (this.autoSwitchHelper.isRateLimitError(error)) {
				console.log(`[Mitigation] Non-streaming rate limit detected - Attempting model fallback for ${modelId}`);
				const fallbackResult = await this.autoSwitchHelper.handleNonStreamingFallback(
					modelId,
					systemPrompt,
					messages,
					options,
					streamContentFn
				);
				if (fallbackResult) {
					return fallbackResult;
				}
			}

			// Re-throw if not a rate limit error or fallback not available
			throw error;
		}
	}

	/**
	 * Extracts native tools parameters from request options.
	 */
	extractNativeToolsParams(options?: Record<string, unknown>): NativeToolsRequestParams {
		return {
			enableSearch: this.extractBooleanParam(options, "enable_search"),
			enableUrlContext: this.extractBooleanParam(options, "enable_url_context"),
			enableNativeTools: this.extractBooleanParam(options, "enable_native_tools"),
			nativeToolsPriority: this.extractStringParam(
				options,
				"native_tools_priority",
				(v): v is "native" | "custom" | "mixed" => ["native", "custom", "mixed"].includes(v)
			)
		};
	}

	/**
	 * Extracts a boolean parameter from request options.
	 */
	private extractBooleanParam(options: Record<string, unknown> | undefined, key: string): boolean | undefined {
		const value =
			options?.[key] ??
			(options?.extra_body as Record<string, unknown>)?.[key] ??
			(options?.model_params as Record<string, unknown>)?.[key];
		return typeof value === "boolean" ? value : undefined;
	}

	/**
	 * Extracts a string parameter from request options with type guard validation.
	 */
	private extractStringParam<T extends string>(
		options: Record<string, unknown> | undefined,
		key: string,
		guard: (v: string) => v is T
	): T | undefined {
		const value =
			options?.[key] ??
			(options?.extra_body as Record<string, unknown>)?.[key] ??
			(options?.model_params as Record<string, unknown>)?.[key];
		if (typeof value === "string" && guard(value)) {
			return value;
		}
		return undefined;
	}
}

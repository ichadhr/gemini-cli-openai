import {
	Env,
	StreamChunk,
	UsageData,
	ChatMessage,
	Tool,
	ToolChoice
} from "../types";
import { AuthManager } from "./auth";
import { MultiAccountManager } from "./account";
import { MessageFormatter, SSEParser, StreamHandler, ReasoningGenerator, NativeToolsManager } from "./";
import { geminiCliModels } from "../config";
import { GenerationConfigValidator } from "../helpers/generation-config-validator";
import { AutoModelSwitchingHelper } from "../helpers/auto-model-switching";
import { NativeToolsRequestParams } from "../types/native-tools";

interface ProjectDiscoveryResponse {
	cloudaicompanionProject?: string;
}

/**
 * Handles communication with Google's Gemini API through the Code Assist endpoint.
 * Manages project discovery, streaming, and response parsing.
 */
export class GeminiApiClient {
	private env: Env;
	private multiAccountManager: MultiAccountManager;
	private projectIds: Map<number, string> = new Map();
	private autoSwitchHelper: AutoModelSwitchingHelper;
	private messageFormatter: MessageFormatter;
	private sseParser: SSEParser;
	private streamHandler: StreamHandler;
	private reasoningGenerator: ReasoningGenerator;

	// Maximum number of project IDs to cache (prevents unbounded memory growth)
	// Typical usage: < 10 accounts, so 1000 is a safe upper limit
	private static readonly MAX_PROJECT_IDS: number = 1000;

	constructor(env: Env, multiAccountManager: MultiAccountManager) {
		this.env = env;
		this.multiAccountManager = multiAccountManager;
		this.autoSwitchHelper = new AutoModelSwitchingHelper(env);
		this.messageFormatter = new MessageFormatter();
		this.sseParser = new SSEParser();
		this.streamHandler = new StreamHandler(
			env,
			multiAccountManager,
			this.messageFormatter,
			this.sseParser,
			this.discoverProjectId.bind(this)
		);
		this.reasoningGenerator = new ReasoningGenerator();
	}

	/**
	 * Discovers the Google Cloud project ID. Uses the environment variable if provided.
	 * Caches discovered project IDs to avoid repeated API calls.
	 */
	public async discoverProjectId(authManager: AuthManager): Promise<string> {
		if (this.env.GEMINI_PROJECT_ID) {
			return this.env.GEMINI_PROJECT_ID;
		}
		if (this.projectIds.has(authManager.id)) {
			return this.projectIds.get(authManager.id)!;
		}

		try {
			const initialProjectId = "default-project";

			const loadResponse = (await authManager.callEndpoint("loadCodeAssist", {
				cloudaicompanionProject: initialProjectId,
				metadata: { duetProject: initialProjectId }
			})) as ProjectDiscoveryResponse;

			if (loadResponse.cloudaicompanionProject) {
				// Evict oldest entry if at capacity (simple LRU-like behavior)
				if (this.projectIds.size >= GeminiApiClient.MAX_PROJECT_IDS) {
					const oldestKey = this.projectIds.keys().next().value!;
					this.projectIds.delete(oldestKey);
				}
				this.projectIds.set(authManager.id, loadResponse.cloudaicompanionProject);
				return loadResponse.cloudaicompanionProject;
			}
			throw new Error("Project ID discovery failed. Please set the GEMINI_PROJECT_ID environment variable.");
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error(`Failed to discover project ID for GCP_SERVICE_ACCOUNT_${authManager.id}: ${authManager.accountName} -`, errorMessage);
			throw new Error(
				"Could not discover project ID. Make sure you're authenticated and consider setting GEMINI_PROJECT_ID."
			);
		}
	}

	/**
	 * Stream content from Gemini API.
	 *
	 * Sticky Account for Tool-Calling Conversations:
	 * When a conversationId is provided, the same GCP account will be used
	 * for all turns in that conversation. This ensures consistency in
	 * multi-turn tool-calling scenarios.
	 */
	async *streamContent(
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
			response_format?: {
				type: "text" | "json_object";
			};
			conversationId?: string; // For sticky account mapping
		} & NativeToolsRequestParams
	): AsyncGenerator<StreamChunk> {
		// Get account ONCE for this request to ensure consistency
		// Use sticky account if conversationId is provided (tool-calling mode)
		const authManager = options?.conversationId && messages
			? await this.multiAccountManager.getAccountForConversation(options.conversationId, messages)
			: await this.multiAccountManager.getAccount();
		await authManager.initializeAuth();
		console.log(`[Mitigation] Initial account selection: GCP_SERVICE_ACCOUNT_${authManager.id}: ${authManager.accountName}`);
		const projectId = await this.discoverProjectId(authManager);

		const contents = this.messageFormatter.formatMessages(systemPrompt, messages);

		// Check if this is a thinking model and which thinking mode to use
		const isThinkingModel = geminiCliModels[modelId]?.thinking || false;
		const isRealThinkingEnabled = this.env.ENABLE_REAL_THINKING === "true";
		const isFakeThinkingEnabled = this.env.ENABLE_FAKE_THINKING === "true";
		const streamThinkingAsContent = this.env.STREAM_THINKING_AS_CONTENT === "true";
		const includeReasoning = options?.includeReasoning || false;

		const req = {
			thinking_budget: options?.thinkingBudget,
			tools: options?.tools,
			tool_choice: options?.tool_choice,
			max_tokens: options?.max_tokens,
			temperature: options?.temperature,
			top_p: options?.top_p,
			stop: options?.stop,
			presence_penalty: options?.presence_penalty,
			frequency_penalty: options?.frequency_penalty,
			seed: options?.seed,
			response_format: options?.response_format
		};

		// Use the validation helper to create a proper generation config
		const generationConfig = GenerationConfigValidator.createValidatedConfig(
			modelId,
			req,
			isRealThinkingEnabled,
			includeReasoning
		);

		// Native tools integration
		const nativeToolsManager = new NativeToolsManager(this.env);
		const nativeToolsParams = this.streamHandler.extractNativeToolsParams(options as Record<string, unknown>);
		const toolConfig = nativeToolsManager.determineToolConfiguration(options?.tools || [], nativeToolsParams, modelId);

		// Configure request based on tool strategy
		const { tools, toolConfig: finalToolConfig } = GenerationConfigValidator.createFinalToolConfiguration(
			toolConfig,
			options
		);

		// For thinking models with fake thinking (fallback when real thinking is not enabled or not requested)
		let needsThinkingClose = false;
		if (isThinkingModel && isFakeThinkingEnabled && !includeReasoning) {
			yield* this.reasoningGenerator.generateReasoningOutput(messages, streamThinkingAsContent);
			needsThinkingClose = streamThinkingAsContent; // Only need to close if we streamed as content
		}

		const streamRequest: {
			model: string;
			project: string;
			request: {
				contents: unknown;
				generationConfig: unknown;
				tools: unknown;
				toolConfig: unknown;
				safetySettings?: unknown;
			};
		} = {
			model: modelId,
			project: projectId,
			request: {
				contents: contents,
				generationConfig,
				tools: tools,
				toolConfig: finalToolConfig
			}
		};

		const safetySettings = GenerationConfigValidator.createSafetySettings(this.env);
		if (safetySettings.length > 0) {
			streamRequest.request.safetySettings = safetySettings;
		}

		yield* this.streamHandler.performStreamRequest(
			streamRequest,
			authManager,
			needsThinkingClose,
			false,
			includeReasoning && streamThinkingAsContent,
			modelId,
			nativeToolsManager,
			0,
			options?.conversationId
		);
	}

	/**
	 * Get a complete response from Gemini API (non-streaming).
	 *
	 * Sticky Account for Tool-Calling Conversations:
	 * When a conversationId is provided, the same GCP account will be used
	 * for all turns in that conversation.
	 */
	async getCompletion(
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
			response_format?: {
				type: "text" | "json_object";
			};
			conversationId?: string; // For sticky account mapping
		} & NativeToolsRequestParams
	): Promise<{
		content: string;
		usage?: UsageData;
		tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
	}> {
		return this.streamHandler.getCompletion(
			this.streamContent.bind(this),
			modelId,
			systemPrompt,
			messages,
			options
		);
	}
}

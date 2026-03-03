// Chat and Message Types

// --- Model Information Interface ---
export interface ModelInfo {
	maxTokens: number;
	contextWindow: number;
	supportsImages: boolean;
	supportsAudios: boolean;
	supportsVideos: boolean;
	supportsPdfs: boolean;
	supportsPromptCache: boolean;
	inputPrice: number;
	outputPrice: number;
	description: string;
	thinking: boolean; // Indicates if the model supports thinking
}

// --- Chat Completion Request Types ---
export type EffortLevel = "none" | "low" | "medium" | "high";

export interface Tool {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

export type ToolChoice = "none" | "auto" | { type: "function"; function: { name: string } };

export interface ChatCompletionRequest {
	model: string;
	messages: ChatMessage[];
	stream?: boolean;
	thinking_budget?: number; // Optional thinking token budget
	reasoning_effort?: EffortLevel; // Optional effort level for thinking
	tools?: Tool[];
	tool_choice?: ToolChoice;
	// Support for common custom parameter locations
	extra_body?: {
		reasoning_effort?: EffortLevel;
		enable_search?: boolean;
		enable_url_context?: boolean;
		enable_native_tools?: boolean;
		native_tools_priority?: "native" | "custom" | "mixed";
	};
	model_params?: {
		reasoning_effort?: EffortLevel;
		enable_search?: boolean;
		enable_url_context?: boolean;
		enable_native_tools?: boolean;
		native_tools_priority?: "native" | "custom" | "mixed";
	};
	// Newly added OpenAI parameters
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
	// Native Tools flags
	enable_search?: boolean;
	enable_url_context?: boolean;
	enable_native_tools?: boolean;
	native_tools_priority?: "native" | "custom" | "mixed";
}

export interface ToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

export interface ChatMessage {
	role: string;
	content: string | MessageContent[];
	tool_calls?: ToolCall[];
	tool_call_id?: string;
}

export interface VideoMetadata {
	startOffset: string;
	endOffset: string;
	fps?: number;
}

export interface MessageContent {
	type: "text" | "image_url" | "input_audio" | "input_video" | "input_pdf";
	text?: string;
	image_url?: {
		url: string;
		detail?: "low" | "high" | "auto";
	};
	input_audio?: {
		data: string;
		format: string;
	};
	input_video?: {
		data: string;
		format: string;
		url?: string;
		videoMetadata?: VideoMetadata;
	};
	input_pdf?: {
		data: string; // base64 encoded PDF
	};
}

// --- Chat Completion Response Interfaces ---
export interface ChatCompletionResponse {
	id: string;
	object: "chat.completion";
	created: number;
	model: string;
	choices: ChatCompletionChoice[];
	usage?: ChatCompletionUsage;
}

export interface ChatCompletionChoice {
	index: number;
	message: ChatCompletionMessage;
	finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export interface ChatCompletionMessage {
	role: "assistant";
	content: string | null;
	tool_calls?: ToolCall[];
}

export interface ChatCompletionUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
}

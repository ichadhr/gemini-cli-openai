// OpenAI-Compatible Types

export interface OpenAIErrorResponse {
	error: {
		message: string;
		type: string;
		param?: string;
		code?: string;
	};
}

export interface OpenAIChatCompletion {
	id: string;
	object: "chat.completion";
	created: number;
	model: string;
	choices: OpenAIChoice[];
	usage?: OpenAIUsage;
}

export interface OpenAIChoice {
	index: number;
	message: OpenAIMessage;
	finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export interface OpenAIMessage {
	role: "assistant" | "user" | "system" | "tool";
	content: string | null;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
}

export interface OpenAIToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

export interface OpenAIUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
}

export interface OpenAIStreamChunk {
	id: string;
	object: "chat.completion.chunk";
	created: number;
	model: string;
	choices: OpenAIStreamChoice[];
	usage?: OpenAIUsage;
}

export interface OpenAIStreamChoice {
	index: number;
	delta: OpenAIDelta;
	finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export interface OpenAIDelta {
	role?: "assistant";
	content?: string;
	tool_calls?: OpenAIToolCall[];
}

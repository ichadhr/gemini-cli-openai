// Streaming Types
import { NativeToolResponse } from "./native-tools";

// --- Gemini Specific Types ---
export interface GeminiFunctionCall {
	name: string;
	args: object;
	thought_signature?: string; // Gemini 3 thinking models include this
}

// --- Usage and Reasoning Data Types ---
export interface UsageData {
	inputTokens: number;
	outputTokens: number;
}

export interface ReasoningData {
	reasoning: string;
	toolCode?: string;
}

// --- Stream Chunk Types ---
export interface StreamChunk {
	type:
		| "text"
		| "usage"
		| "reasoning"
		| "thinking_content"
		| "real_thinking"
		| "tool_code"
		| "native_tool"
		| "grounding_metadata";
	data: string | UsageData | ReasoningData | GeminiFunctionCall | NativeToolResponse;
}

// Gemini API Types
import { GroundingMetadata, GeminiUrlContextMetadata } from "./native-tools";

// Gemini API response types
export interface GeminiCandidate {
	content?: {
		parts?: GeminiPart[];
	};
	groundingMetadata?: GroundingMetadata;
}

export interface GeminiUsageMetadata {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
}

export interface GeminiResponse {
	response?: {
		candidates?: GeminiCandidate[];
		usageMetadata?: GeminiUsageMetadata;
	};
}

// Stream request type for Gemini API
export interface StreamRequest {
	model: string;
	project: string;
	request: {
		contents: unknown;
		generationConfig: unknown;
		tools: unknown;
		toolConfig: unknown;
		safetySettings?: unknown;
	};
}

export interface GeminiPart {
	text?: string;
	thought?: boolean; // For real thinking chunks from Gemini
	functionCall?: {
		name: string;
		args: object;
	};
	functionResponse?: {
		name: string;
		response: {
			result: string;
		};
	};
	inlineData?: {
		mimeType: string;
		data: string;
	};
	fileData?: {
		mimeType: string;
		fileUri: string;
	};
	url_context_metadata?: GeminiUrlContextMetadata;
	// docs: https://ai.google.dev/gemini-api/docs/video-understanding#clipping-intervals
	// all must not exceed video real values
	videoMetadata?: {
		startOffset?: string; // string in seconds (40s)
		endOffset?: string; // string in seconds (80s)
		fps?: number;
	};
}

export interface GeminiFormattedMessage {
	role: string;
	parts: GeminiPart[];
}

import {
	StreamChunk,
	UsageData,
	GeminiFunctionCall,
	GeminiPart,
	GeminiResponse
} from "../../types";
import { NativeToolsManager, CitationsProcessor } from "../tools";

/**
 * Cleans excessive whitespace and newlines from thinking content
 * Preserves natural section breaks but removes excessive spacing
 */
export function cleanThinkingWhitespace(text: string): string {
	return (
		text
			// Replace 3+ consecutive newlines (with optional whitespace) with 2 newlines
			.replace(/\n\s*\n\s*\n+/g, "\n\n")
			// Clean up lines that are only whitespace between content
			.replace(/\n\s*\n/g, "\n\n")
			// Remove excessive spaces around newlines
			.replace(/[ \t]*\n[ \t]*/g, "\n")
			// Trim excessive trailing/leading whitespace
			.trim()
	);
}

/**
 * Parses a server-sent event (SSE) stream from the Gemini API.
 * Yields raw text chunks incrementally as they become available.
 */
export async function* parseSSEStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = stream.pipeThrough(new TextDecoderStream()).getReader();

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			yield value;
		}
	}
}

/**
 * Interface for thinking state tracking
 */
export interface ThinkingState {
	hasStartedThinking: boolean;
	hasClosedThinking: boolean;
}

/**
 * SSE Parser service for handling Gemini API streaming responses.
 * Responsible for parsing SSE format and processing candidate parts.
 */
export class SSEParser {
	/**
	 * Processes candidate parts from Gemini API response and yields stream chunks.
	 * This method extracts the duplicated processing logic from the SSE parser.
	 * Note: Usage metadata is handled separately in each call site.
	 * @returns Updated thinking state
	 */
	*processCandidateParts(
		parts: GeminiPart[],
		jsonData: GeminiResponse,
		realThinkingAsContent: boolean,
		needsThinkingClose: boolean,
		state: ThinkingState,
		nativeToolsManager?: NativeToolsManager,
		citationsProcessor?: CitationsProcessor
	): Generator<StreamChunk, ThinkingState> {
		let { hasStartedThinking, hasClosedThinking } = state;

		for (const part of parts) {
			// Handle real thinking content from Gemini
			if (part.thought === true && part.text) {
				const thinkingText = part.text;

				if (realThinkingAsContent) {
					// Stream as content with <thinking> tags (DeepSeek R1 style)
					if (!hasStartedThinking) {
						yield {
							type: "thinking_content",
							data: "<thinking>\n"
						};
						hasStartedThinking = true;
					}

					yield {
						type: "thinking_content",
						data: cleanThinkingWhitespace(thinkingText)
					};
				} else {
					// Stream as separate reasoning field
					yield {
						type: "real_thinking",
						data: thinkingText
					};
				}
			}
			// Check if text content contains <think> tags (based on your original example)
			else if (part.text && part.text.includes("<think>")) {
				if (realThinkingAsContent) {
					// Extract thinking content and convert to our format
					const thinkingMatch = part.text.match(/<think>(.*?)<\/think>/s);
					if (thinkingMatch) {
						if (!hasStartedThinking) {
							yield {
								type: "thinking_content",
								data: "<thinking>\n"
							};
							hasStartedThinking = true;
						}

						yield {
							type: "thinking_content",
							data: cleanThinkingWhitespace(thinkingMatch[1])
						};
					}

					// Extract any non-thinking content
					const nonThinkingContent = part.text.replace(/<think>.*?<\/think>/gs, "").trim();
					if (nonThinkingContent) {
						if (hasStartedThinking && !hasClosedThinking) {
							yield {
								type: "thinking_content",
								data: "\n</thinking>\n\n"
							};
							hasClosedThinking = true;
						}
						yield { type: "text", data: nonThinkingContent };
					}
				} else {
					// Stream thinking as separate reasoning field
					const thinkingMatch = part.text.match(/<think>(.*?)<\/think>/s);
					if (thinkingMatch) {
						yield {
							type: "real_thinking",
							data: thinkingMatch[1]
						};
					}

					// Stream non-thinking content as regular text
					const nonThinkingContent = part.text.replace(/<think>.*?<\/think>/gs, "").trim();
					if (nonThinkingContent) {
						yield { type: "text", data: nonThinkingContent };
					}
				}
			}
			// Handle regular content - only if it's not a thinking part and doesn't contain <think> tags
			else if (part.text && !part.thought && !part.text.includes("<think>")) {
				// Close thinking tag before first real content if needed
				if ((needsThinkingClose || (realThinkingAsContent && hasStartedThinking)) && !hasClosedThinking) {
					yield {
						type: "thinking_content",
						data: "\n</thinking>\n\n"
					};
					hasClosedThinking = true;
				}

				let processedText = part.text;
				if (nativeToolsManager && citationsProcessor) {
					processedText = citationsProcessor.processChunk(
						part.text,
						jsonData.response?.candidates?.[0]?.groundingMetadata
					);
				}
				yield { type: "text", data: processedText };
			}
			// Handle function calls from Gemini
			else if (part.functionCall) {
				// Close thinking tag before function call if needed
				if ((needsThinkingClose || (realThinkingAsContent && hasStartedThinking)) && !hasClosedThinking) {
					yield {
						type: "thinking_content",
						data: "\n</thinking>\n\n"
					};
					hasClosedThinking = true;
				}

				const functionCallData: GeminiFunctionCall = {
					name: part.functionCall.name,
					args: part.functionCall.args
				};

				yield {
					type: "tool_code",
					data: functionCallData
				};
			}
			// Note: Skipping unknown part structures
		}

		// Note: Usage metadata is handled separately in each call site
		return { hasStartedThinking, hasClosedThinking };
	}

	/**
	 * Creates usage data from Gemini usage metadata.
	 */
	createUsageData(usageMetadata: { promptTokenCount?: number; candidatesTokenCount?: number }): UsageData {
		return {
			inputTokens: usageMetadata.promptTokenCount || 0,
			outputTokens: usageMetadata.candidatesTokenCount || 0
		};
	}
}

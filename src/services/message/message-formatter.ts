import { ChatMessage, MessageContent, GeminiFormattedMessage, GeminiPart } from "../../types";
import { validateContent } from "../../utils/validation";
import { extractSignatureFromToolCallId } from "../../helpers/thought-signature";

/**
 * Type guard to check if content is a text content object
 */
export function isTextContent(content: MessageContent): content is { type: "text"; text: string } {
	return (
		typeof content === "object" &&
		content !== null &&
		"type" in content &&
		content.type === "text" &&
		"text" in content &&
		typeof content.text === "string"
	);
}

/**
 * Formats chat messages into Gemini API compatible format.
 * Handles text content, tool calls, tool responses, images (URL and base64),
 * audio, video, and PDFs.
 *
 * Gemini API Requirements for tool calling:
 * 1. functionResponse.name must be the FUNCTION NAME (not tool_call_id)
 * 2. functionResponse.id must be the TOOL CALL ID (for matching)
 * 3. Consecutive tool messages must be merged into one user message
 */
export class MessageFormatter {
	private toolCallIdToFunctionName: Map<string, string> = new Map();

	/**
	 * Converts a single message to Gemini format.
	 * Role mapping: 'assistant' → 'model', 'user' → 'user'
	 */
	formatMessage(msg: ChatMessage): GeminiFormattedMessage {
		const role = msg.role === "assistant" ? "model" : "user";

		// Handle tool call results (tool role in OpenAI format)
		// Gemini requires: name = function name, id = tool call ID
		if (msg.role === "tool") {
			const toolCallId = msg.tool_call_id || "unknown";
			const functionName = this.toolCallIdToFunctionName.get(toolCallId) || toolCallId;

			return {
				role: "user",
				parts: [
					{
						functionResponse: {
							name: functionName,
							id: toolCallId,
							response: {
								result: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
							}
						}
					}
				]
			};
		}

		// Handle assistant messages with tool calls
		if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
			const parts: GeminiPart[] = [];

			// Add text content if present
			if (typeof msg.content === "string" && msg.content.trim()) {
				parts.push({ text: msg.content });
			}

			// Add function calls and store tool_call_id → function_name mapping
			for (const toolCall of msg.tool_calls) {
				if (toolCall.type === "function") {
					let parsedArgs: object;
					try {
						parsedArgs = JSON.parse(toolCall.function.arguments);
					} catch (e: unknown) {
						const errorMessage = e instanceof Error ? e.message : String(e);
						throw new Error(`Invalid JSON in tool arguments for function '${toolCall.function.name}': ${errorMessage}`);
					}

					// Store mapping for later tool responses
					if (toolCall.id) {
						this.toolCallIdToFunctionName.set(toolCall.id, toolCall.function.name);
					}

					const functionCallPart: GeminiPart = {
						functionCall: {
							name: toolCall.function.name,
							args: parsedArgs
						}
					};

					// Extract signature from tool_call.id or use thought_signature field
					// This preserves the signature across multi-turn conversations
					const signature = extractSignatureFromToolCallId(toolCall.id) || toolCall.thought_signature;
					if (signature) {
						functionCallPart.thoughtSignature = signature;
					}

					parts.push(functionCallPart);
				}
			}

			return { role: "model", parts };
		}

		if (typeof msg.content === "string") {
			// Simple text message
			return {
				role,
				parts: [{ text: msg.content }]
			};
		}

		if (Array.isArray(msg.content)) {
			// Multimodal message with text and/or images
			const parts: GeminiPart[] = [];

			for (const content of msg.content) {
				if (content.type === "text") {
					parts.push({ text: content.text });
				} else if (content.type === "image_url" && content.image_url) {
					const imageUrl = content.image_url.url;

					// Validate image URL
					const { isValid, error, mimeType } = validateContent("image_url", content);
					if (!isValid) {
						throw new Error(`Invalid image: ${error}`);
					}

					if (imageUrl.startsWith("data:")) {
						// Handle base64 encoded images
						const [mimeType, base64Data] = imageUrl.split(",");
						const mediaType = mimeType.split(":")[1].split(";")[0];

						parts.push({
							inlineData: {
								mimeType: mediaType,
								data: base64Data
							}
						});
					} else {
						// Handle URL images
						// Note: For better reliability, you might want to fetch the image
						// and convert it to base64, as Gemini API might have limitations with external URLs
						const part = {
							fileData: {
								mimeType: mimeType || "image/jpeg",
								fileUri: imageUrl
							}
						};
						parts.push(part);
					}
				} else if (content.type === "input_audio" && content.input_audio) {
					parts.push({
						inlineData: {
							mimeType: content.input_audio.format,
							data: content.input_audio.data
						}
					});
				} else if (content.type === "input_video" && content.input_video) {
					if (content.input_video.data && content.input_video.format) {
						// Handle base64 video
						const part: GeminiPart = {
							inlineData: {
								mimeType: content.input_video.format,
								data: content.input_video.data
							}
						};

						// Add video metadata if present
						if (content.input_video.videoMetadata) {
							const { startOffset, endOffset, fps } = content.input_video.videoMetadata;
							if (startOffset || endOffset || fps) {
								part.videoMetadata = {};
								// Pass strings directly as Gemini API accepts "10s" format
								if (startOffset) part.videoMetadata.startOffset = startOffset;
								if (endOffset) part.videoMetadata.endOffset = endOffset;
								if (fps) part.videoMetadata.fps = fps;
							}
						}
						parts.push(part);
					}
				} else if (content.type === "input_pdf" && content.input_pdf) {
					if (content.input_pdf.data) {
						// Validate PDF
						const { isValid, error } = validateContent("input_pdf", content);
						if (!isValid) {
							throw new Error(`Invalid PDF: ${error}`);
						}

						// Handle base64 PDF
						parts.push({
							inlineData: {
								mimeType: "application/pdf",
								data: content.input_pdf.data
							}
						});
					}
				}
			}

			return { role, parts };
		}

		// Fallback for unexpected content format
		return {
			role,
			parts: [{ text: String(msg.content) }]
		};
	}

	/**
	 * Converts system prompt + messages to Gemini format.
	 * System prompt becomes first message with role 'user'.
	 *
	 * Gemini API Requirements:
	 * 1. functionResponse.name = function name, functionResponse.id = tool call ID
	 * 2. Consecutive tool messages must be merged into one user message
	 */
	formatMessages(systemPrompt: string, messages: ChatMessage[]): GeminiFormattedMessage[] {
		// Clear mapping for each new conversation
		this.toolCallIdToFunctionName.clear();

		const formattedMessages: GeminiFormattedMessage[] = [];

		for (const msg of messages) {
			const formatted = this.formatMessage(msg);

			// Merge consecutive tool messages into one Gemini user message
			// Gemini requires: 2 functionCalls → 1 user message with 2 functionResponse parts
			if (msg.role === "tool" && formattedMessages.length > 0) {
				const lastMsg = formattedMessages[formattedMessages.length - 1];
				// If last message is a tool response (user role with functionResponse), merge
				if (lastMsg.role === "user" && lastMsg.parts.some((p) => p.functionResponse)) {
					lastMsg.parts.push(...formatted.parts);
					continue;
				}
			}

			formattedMessages.push(formatted);
		}

		if (systemPrompt) {
			formattedMessages.unshift({ role: "user", parts: [{ text: systemPrompt }] });
		}

		return formattedMessages;
	}
}

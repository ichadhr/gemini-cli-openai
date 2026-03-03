import { ChatMessage, MessageContent, GeminiFormattedMessage, GeminiPart } from '../../types';
import { validateContent } from '../../utils/validation';

/**
 * Type guard to check if content is a text content object
 */
export function isTextContent(content: MessageContent): content is { type: 'text'; text: string } {
	return typeof content === 'object' && content !== null &&
		'type' in content && content.type === 'text' &&
		'text' in content && typeof content.text === 'string';
}

/**
 * Formats chat messages into Gemini API compatible format.
 * Handles text content, tool calls, tool responses, images (URL and base64),
 * audio, video, and PDFs.
 */
export class MessageFormatter {
	/**
	 * Converts a single message to Gemini format.
	 * Role mapping: 'assistant' → 'model', 'user' → 'user'
	 */
	formatMessage(msg: ChatMessage): GeminiFormattedMessage {
		const role = msg.role === "assistant" ? "model" : "user";

		// Handle tool call results (tool role in OpenAI format)
		if (msg.role === "tool") {
			return {
				role: "user",
				parts: [
					{
						functionResponse: {
							name: msg.tool_call_id || "unknown_function",
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

			// Add function calls
			for (const toolCall of msg.tool_calls) {
				if (toolCall.type === "function") {
					let parsedArgs: object;
					try {
						parsedArgs = JSON.parse(toolCall.function.arguments);
					} catch (e: unknown) {
						const errorMessage = e instanceof Error ? e.message : String(e);
						throw new Error(
							`Invalid JSON in tool arguments for function '${toolCall.function.name}': ${errorMessage}`
						);
					}
					parts.push({
						functionCall: {
							name: toolCall.function.name,
							args: parsedArgs
						}
					});
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
	 */
	formatMessages(systemPrompt: string, messages: ChatMessage[]): GeminiFormattedMessage[] {
		const formattedMessages = messages.map((msg) => this.formatMessage(msg));

		if (systemPrompt) {
			formattedMessages.unshift({ role: "user", parts: [{ text: systemPrompt }] });
		}

		return formattedMessages;
	}
}

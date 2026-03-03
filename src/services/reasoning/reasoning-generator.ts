import { ChatMessage, StreamChunk, ReasoningData } from '../../types';
import { REASONING_MESSAGES, REASONING_CHUNK_DELAY, THINKING_CONTENT_CHUNK_SIZE } from '../../config';
import { isTextContent } from '../message/message-formatter';

/**
 * Generates fake reasoning/thinking output for thinking models.
 * Provides a simulated thinking experience when real thinking is not enabled.
 */
export class ReasoningGenerator {
	/**
	 * Generates reasoning output for thinking models.
	 * Can stream as content (with <thinking> tags) or as separate reasoning stream.
	 *
	 * @param messages - Chat messages to analyze for context
	 * @param streamAsContent - Whether to stream as content with <thinking> tags
	 * @yields Stream chunks containing reasoning data
	 */
	async* generateReasoningOutput(
		messages: ChatMessage[],
		streamAsContent: boolean = false
	): AsyncGenerator<StreamChunk> {
		// Get the last user message to understand what the model should think about
		const lastUserMessage = messages.filter((msg) => msg.role === "user").pop();
		let userContent = "";

		if (lastUserMessage) {
			if (typeof lastUserMessage.content === "string") {
				userContent = lastUserMessage.content;
			} else if (Array.isArray(lastUserMessage.content)) {
				userContent = lastUserMessage.content
					.filter(isTextContent)
					.map((c) => c.text)
					.join(" ");
			}
		}

		// Generate reasoning text based on the user's question using constants
		const requestPreview = userContent.substring(0, 100) + (userContent.length > 100 ? "..." : "");

		if (streamAsContent) {
			// DeepSeek R1 style: stream thinking as content with <thinking> tags
			yield {
				type: "thinking_content",
				data: "<thinking>\n"
			};

			// Add a small delay after opening tag
			await new Promise((resolve) => setTimeout(resolve, REASONING_CHUNK_DELAY)); // Stream reasoning content in smaller chunks for more realistic streaming
			const reasoningTexts = REASONING_MESSAGES.map((msg) => msg.replace("{requestPreview}", requestPreview));
			const fullReasoningText = reasoningTexts.join("");

			// Split into smaller chunks for more realistic streaming
			// Try to split on word boundaries when possible for better readability
			const chunks: string[] = [];
			let remainingText = fullReasoningText;

			while (remainingText.length > 0) {
				if (remainingText.length <= THINKING_CONTENT_CHUNK_SIZE) {
					chunks.push(remainingText);
					break;
				}

				// Try to find a good break point (space, newline, punctuation)
				let chunkEnd = THINKING_CONTENT_CHUNK_SIZE;
				const searchSpace = remainingText.substring(0, chunkEnd + 10); // Look a bit ahead
				const goodBreaks = [" ", "\n", ".", ",", "!", "?", ";", ":"];

				for (const breakChar of goodBreaks) {
					const lastBreak = searchSpace.lastIndexOf(breakChar);
					if (lastBreak > THINKING_CONTENT_CHUNK_SIZE * 0.7) {
						// Don't make chunks too small
						chunkEnd = lastBreak + 1;
						break;
					}
				}

				chunks.push(remainingText.substring(0, chunkEnd));
				remainingText = remainingText.substring(chunkEnd);
			}

			for (const chunk of chunks) {
				yield {
					type: "thinking_content",
					data: chunk
				};

				// Add small delay between chunks
				await new Promise((resolve) => setTimeout(resolve, 50));
			}

			// Note: We don't close the thinking tag here - it will be closed when real content starts
		} else {
			// Original mode: stream as reasoning field
			const reasoningTexts = REASONING_MESSAGES.map((msg) => msg.replace("{requestPreview}", requestPreview));

			// Stream the reasoning text in chunks
			for (const reasoningText of reasoningTexts) {
				const reasoningData: ReasoningData = { reasoning: reasoningText };
				yield {
					type: "reasoning",
					data: reasoningData
				};

				// Add a small delay to simulate thinking time
				await new Promise((resolve) => setTimeout(resolve, REASONING_CHUNK_DELAY));
			}
		}
	}
}

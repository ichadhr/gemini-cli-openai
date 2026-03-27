/**
 * Thought Signature Utilities for Gemini 3 Cursor Compatibility
 *
 * Gemini 3 thinking models return a thoughtSignature in function calls.
 * This signature must be preserved across multi-turn conversations to maintain
 * thinking context. We encode it in the tool_call.id field.
 *
 * Format: call_<uuid>__sig__<base64_signature>
 *
 * Ref: https://ai.google.dev/gemini-api/docs/thinking
 */

const SIGNATURE_DELIMITER = "__sig__";

/**
 * Encodes a thought signature into a tool call ID.
 * If no signature is provided, returns a plain UUID-based ID.
 *
 * @param signature - The thought signature from Gemini (optional)
 * @returns A tool call ID, optionally containing the encoded signature
 */
export function encodeSignatureInToolCallId(signature: string | undefined): string {
	const baseId = `call_${crypto.randomUUID()}`;

	if (signature) {
		try {
			const encodedSig = btoa(signature);
			return `${baseId}${SIGNATURE_DELIMITER}${encodedSig}`;
		} catch (e) {
			// btoa can fail with non-ASCII characters
			console.error("[ThoughtSignature] Failed to encode signature:", e);
			return baseId;
		}
	}

	return baseId;
}

/**
 * Extracts a thought signature from a tool call ID.
 * Returns undefined if no signature is present or decoding fails.
 *
 * @param toolCallId - The tool call ID potentially containing a signature
 * @returns The decoded signature, or undefined if not present/invalid
 */
export function extractSignatureFromToolCallId(toolCallId: string | undefined): string | undefined {
	if (!toolCallId || !toolCallId.includes(SIGNATURE_DELIMITER)) {
		return undefined;
	}

	const sigPart = toolCallId.split(SIGNATURE_DELIMITER)[1];

	if (sigPart) {
		try {
			return atob(sigPart);
		} catch (e) {
			// atob can fail if the encoded string is invalid
			console.error("[ThoughtSignature] Failed to decode signature from tool_call id:", e);
		}
	}

	return undefined;
}

// Environment and Service Account Types

// --- Safety Threshold Types ---
export type SafetyThreshold =
	| "OFF" // can be off: https://ai.google.dev/gemini-api/docs/safety-settings#safety-filtering-per-request
	| "BLOCK_NONE"
	| "BLOCK_FEW"
	| "BLOCK_SOME"
	| "BLOCK_ONLY_HIGH"
	| "HARM_BLOCK_THRESHOLD_UNSPECIFIED";

// --- Environment Variable Typings ---
export interface Env {
	GCP_SERVICE_ACCOUNT: string; // Now contains OAuth2 credentials JSON
	GEMINI_PROJECT_ID?: string;
	GEMINI_CLI_KV: KVNamespace; // Cloudflare KV for token caching
	OPENAI_API_KEY?: string; // Optional API key for authentication
	ENABLE_FAKE_THINKING?: string; // Optional flag to enable fake thinking output (set to "true" to enable)
	ENABLE_REAL_THINKING?: string; // Optional flag to enable real Gemini thinking output (set to "true" to enable)
	STREAM_THINKING_AS_CONTENT?: string; // Optional flag to stream thinking as content with <thinking> tags (set to "true" to enable)
	ENABLE_AUTO_MODEL_SWITCHING?: string; // Optional flag to enable automatic fallback from pro to flash on 429 errors (set to "true" to enable)

	// Sticky Account Configuration for Tool-Calling Conversations
	STICKY_SESSION_TTL_SECONDS?: string; // Safety TTL for sticky account mappings (default: 300 seconds / 5 minutes)

	GEMINI_MODERATION_HARASSMENT_THRESHOLD?: SafetyThreshold;
	GEMINI_MODERATION_HATE_SPEECH_THRESHOLD?: SafetyThreshold;
	GEMINI_MODERATION_SEXUALLY_EXPLICIT_THRESHOLD?: SafetyThreshold;
	GEMINI_MODERATION_DANGEROUS_CONTENT_THRESHOLD?: SafetyThreshold;

	// Native Tools Configuration
	ENABLE_GEMINI_NATIVE_TOOLS?: string; // Enable native Gemini tools (default: false)
	ENABLE_GOOGLE_SEARCH?: string; // Enable Google Search tool (default: false)
	ENABLE_URL_CONTEXT?: string; // Enable URL Context tool (default: false)
	GEMINI_TOOLS_PRIORITY?: string; // Tool priority strategy (native_first, custom_first, user_choice)
	DEFAULT_TO_NATIVE_TOOLS?: string; // Default behavior when no custom tools provided (default: true)
	ALLOW_REQUEST_TOOL_CONTROL?: string; // Allow request-level tool control (default: true)

	// Citations and Grounding Configuration
	ENABLE_INLINE_CITATIONS?: string; // Enable inline citations in responses (default: false)
	INCLUDE_GROUNDING_METADATA?: string; // Include grounding metadata in responses (default: true)
	INCLUDE_SEARCH_ENTRY_POINT?: string; // Include search entry point HTML (default: false)

	// Index signature for dynamic access
	[key: string]: string | KVNamespace | undefined;
}

// --- OAuth2 Credentials Interface ---
export interface OAuth2Credentials {
	access_token: string;
	refresh_token: string;
	scope: string;
	token_type: string;
	id_token: string;
	expiry_date: number;
}

// --- Service Account Interface ---
export interface ServiceAccount {
	credentials: OAuth2Credentials;
	projectId?: string;
}

/**
 * Gets all service accounts from environment variables.
 * Supports multiple GCP_SERVICE_ACCOUNT_* numbered variables.
 */
export function getServiceAccounts(env: Env): ServiceAccount[] {
	const accounts: ServiceAccount[] = [];

	// Try numbered accounts first (GCP_SERVICE_ACCOUNT_1, GCP_SERVICE_ACCOUNT_2, etc.)
	let index = 1;
	while (true) {
		const key = `GCP_SERVICE_ACCOUNT_${index}`;
		const value = env[key];
		if (!value || typeof value !== "string") break;

		try {
			const credentials = JSON.parse(value) as OAuth2Credentials;
			accounts.push({ credentials });
		} catch (e) {
			console.warn(`Failed to parse ${key}:`, e);
		}
		index++;
	}

	// Fall back to GCP_SERVICE_ACCOUNT (unnumbered) if no numbered accounts found
	if (accounts.length === 0 && env.GCP_SERVICE_ACCOUNT) {
		try {
			const credentials = JSON.parse(env.GCP_SERVICE_ACCOUNT) as OAuth2Credentials;
			accounts.push({ credentials });
		} catch (e) {
			console.warn("Failed to parse GCP_SERVICE_ACCOUNT:", e);
		}
	}

	return accounts;
}

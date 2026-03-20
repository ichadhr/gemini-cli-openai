import { Env, OAuth2Credentials } from "../../types";
import { AuthManager } from "../auth/auth-manager";
import { AccountHealthTracker } from "./health";

/**
 * Multi-account manager with sticky account support for tool-calling conversations.
 *
 * ## The Problem
 * Currently, every request rotates to a different GCP account. This breaks multi-turn
 * tool calling (like sequentialthinking) because:
 * - Turn 1 → Account 1
 * - Turn 2 → Account 2 (different account!)
 * - Turn 3 → Account 3 (different account!)
 *
 * Issues: Different project configs, unpredictable rate limits, scattered logs.
 *
 * ## The Solution: Sticky Account for Tool-Calling
 * When a conversation involves tool calling, stick to ONE account for ALL turns:
 * - Detect tool-calling mode from messages
 * - Generate conversation ID
 * - Use same account for entire conversation
 * - Clear sticky mapping when tool calling completes
 */
export class MultiAccountManager {
	private env: Env;
	private accounts: AuthManager[] = [];
	private healthTracker: AccountHealthTracker;
	private currentAccountIndex: number = 0;

	// Safety TTL for sticky account mappings (default: 5 minutes)
	private readonly STICKY_SESSION_TTL_SECONDS: number;

	constructor(env: Env) {
		this.env = env;
		this.healthTracker = new AccountHealthTracker(env);
		// Parse TTL from env or use default 300 seconds (5 minutes)
		const ttlValue = (env as Record<string, string | undefined>).STICKY_SESSION_TTL_SECONDS;
		this.STICKY_SESSION_TTL_SECONDS = parseInt(ttlValue || "300", 10);
		if (isNaN(this.STICKY_SESSION_TTL_SECONDS) || this.STICKY_SESSION_TTL_SECONDS < 0) {
			this.STICKY_SESSION_TTL_SECONDS = 300;
		}
		this.initializeAccounts();
	}

	private initializeAccounts() {
		// 1. Check for numbered accounts GCP_SERVICE_ACCOUNT_0, _1, etc.
		let index = 0;
		while (true) {
			const envKey = `GCP_SERVICE_ACCOUNT_${index}`;
			// We need to cast env to Record<string, string | undefined> to access dynamic keys
			const credentialsJson = (this.env as unknown as Record<string, string | undefined>)[envKey];

			if (!credentialsJson) {
				break;
			}

			try {
				const credentials = JSON.parse(credentialsJson) as OAuth2Credentials;
				this.addAccount(index, credentials);
			} catch (e) {
				console.error(`Failed to parse credentials for GCP_SERVICE_ACCOUNT_${index}:`, e);
			}
			index++;
		}

		// 2. Check for legacy single account GCP_SERVICE_ACCOUNT
		if (this.accounts.length === 0 && this.env.GCP_SERVICE_ACCOUNT) {
			try {
				const credentials = JSON.parse(this.env.GCP_SERVICE_ACCOUNT) as OAuth2Credentials;
				this.addAccount(0, credentials);
				console.log("Initialized in single-account mode (legacy)");
			} catch (e) {
				console.error("Failed to parse legacy GCP_SERVICE_ACCOUNT:", e);
			}
		}

		console.log(`Initialized AccountManager with ${this.accounts.length} accounts`);
	}

	private addAccount(id: number, credentials: OAuth2Credentials) {
		// We need to modify AuthManager to accept credentials directly or we handle it here.
		// The current AuthManager loads from env.GCP_SERVICE_ACCOUNT.
		// We will modify AuthManager to take (env, id, credentials).
		// For now, we assume we will refactor AuthManager to take (env, id, credentials).
		const authManager = new AuthManager(this.env, id, credentials);
		this.accounts.push(authManager);
	}

	/**
	 * Get a healthy account to use.
	 * Rotates through accounts using persistent round-robin via KV.
	 */
	public async getAccount(): Promise<AuthManager> {
		if (this.accounts.length === 0) {
			throw new Error("No service accounts configured");
		}

		// Try to get rotation index from KV for persistent round-robin
		// We do this optimistically to not block too much, but for sequence we need to read it.
		// Default to random start if KV fails or is empty, to prevent "always 0" issue if KV is down.
		let currentIndex = this.currentAccountIndex;

		try {
			const kvIndex = await this.env.GEMINI_CLI_KV.get("account_rotation_index");
			if (kvIndex !== null) {
				currentIndex = parseInt(kvIndex, 10);
			}
		} catch (e) {
			console.warn("Failed to read rotation index from KV, using local/random index", e);
		}

		// Normalize index
		if (isNaN(currentIndex) || currentIndex < 0) currentIndex = 0;
		currentIndex = currentIndex % this.accounts.length;

		const startIndex = currentIndex;
		let attempts = 0;

		while (attempts < this.accounts.length) {
			const account = this.accounts[currentIndex];
			const accountId = account.id;

			if (await this.healthTracker.isAccountHealthy(accountId)) {
				// Found a healthy account. Update the global rotation index for the NEXT request.
				// We increment by 1 and save.
				const nextIndex = (currentIndex + 1) % this.accounts.length;

				// Fire-and-forget update to KV (using waitUntil if available in context, but here we just don't await)
				// Note: In strict Cloudflare Workers, we should use ctx.waitUntil, but we don't have ctx here.
				// Awaiting it adds latency (~10-50ms). Given the user wants "sequence", we accept this small cost
				// or we just float it. "await" is safer to ensure it writes.
				try {
					// We await it to ensure sequence is respected for immediate next request
					await this.env.GEMINI_CLI_KV.put("account_rotation_index", nextIndex.toString());
				} catch (e) {
					console.error("Failed to update rotation index in KV", e);
				}

				return account;
			}

			console.log(`Skipping unhealthy GCP_SERVICE_ACCOUNT_${accountId}: ${account.accountName}`);
			currentIndex = (currentIndex + 1) % this.accounts.length;
			attempts++;
		}

		console.warn("All accounts appear unhealthy or rate limited. Returning next available account.");
		return this.accounts[startIndex];
	}

	/**
	 * Get account for conversation, using sticky mapping for tool-calling.
	 *
	 * Problem: Multi-turn tool calling breaks with per-request rotation.
	 * Each turn may hit a different account, causing:
	 * - Inconsistent project configurations
	 * - Unpredictable rate limit handling
	 * - Scattered logs across accounts
	 *
	 * Solution: Keep same account for all turns in tool-calling conversations.
	 *
	 * @param conversationId - Unique identifier for the conversation (from X-Conversation-ID header or hash)
	 * @returns AuthManager - The account to use for this conversation
	 */
	public async getAccountForConversation(conversationId?: string): Promise<AuthManager> {
		// If no conversation ID provided, fall back to normal rotation
		if (!conversationId) {
			console.log("[Mitigation] No conversation ID provided, using normal account rotation");
			return this.getAccount();
		}

		// Check if there's already a sticky mapping for this conversation
		const stickyAccountId = await this.getStickyAccountId(conversationId);

		if (stickyAccountId !== null) {
			// Found existing sticky mapping - use the same account
			const account = this.accounts.find((acc) => acc.id === stickyAccountId);
			if (account && (await this.healthTracker.isAccountHealthy(stickyAccountId))) {
				const accountName = account.accountName;
				console.log(`[Mitigation] Sticky account: Using GCP_SERVICE_ACCOUNT_${stickyAccountId}: ${accountName} for conversation ${conversationId.substring(0, 8)}...`);
				return account;
			}

			// Account not found or unhealthy - clear the stale mapping and get a new one
			console.log(`[Mitigation] Sticky account ${stickyAccountId} unhealthy, clearing mapping for conversation ${conversationId.substring(0, 8)}...`);
			await this.clearStickyAccount(conversationId);
		}

		// No sticky mapping exists - get a fresh account and store it
		const account = await this.getAccount();
		await this.setStickyAccount(conversationId, account.id);
		console.log(`[Mitigation] Sticky account: Mapped GCP_SERVICE_ACCOUNT_${account.id}: ${account.accountName} to conversation ${conversationId.substring(0, 8)}...`);

		return account;
	}

	/**
	 * Store sticky account mapping in KV with safety TTL.
	 * Safety TTL prevents orphaned mappings on crash/failure.
	 *
	 * KV Key: sticky:{conversation_id}
	 * KV Value: account index as string
	 * Safety TTL: 300 seconds (5 minutes) default
	 *
	 * @param conversationId - Unique identifier for the conversation
	 * @param accountId - The account index to stick to
	 */
	private async setStickyAccount(conversationId: string, accountId: number): Promise<void> {
		try {
			const key = `sticky:${conversationId}`;
			const value = accountId.toString();

			await this.env.GEMINI_CLI_KV.put(key, value, {
				expirationTtl: this.STICKY_SESSION_TTL_SECONDS
			});

			console.log(`[Mitigation] Sticky account mapping stored: ${key} -> GCP_SERVICE_ACCOUNT_${accountId} (TTL: ${this.STICKY_SESSION_TTL_SECONDS}s)`);
		} catch (e) {
			console.error(`[Mitigation] Failed to store sticky account mapping for conversation ${conversationId.substring(0, 8)}...`, e);
		}
	}

	/**
	 * Retrieve sticky account mapping from KV.
	 *
	 * @param conversationId - Unique identifier for the conversation
	 * @returns The account index if found, null otherwise
	 */
	private async getStickyAccountId(conversationId: string): Promise<number | null> {
		try {
			const key = `sticky:${conversationId}`;
			const value = await this.env.GEMINI_CLI_KV.get(key);

			if (value === null) {
				return null;
			}

			const accountId = parseInt(value, 10);
			if (isNaN(accountId) || accountId < 0 || accountId >= this.accounts.length) {
				console.warn(`[Mitigation] Invalid sticky account ID '${value}' for conversation ${conversationId.substring(0, 8)}...`);
				return null;
			}

			return accountId;
		} catch (e) {
			console.error(`[Mitigation] Failed to retrieve sticky account for conversation ${conversationId.substring(0, 8)}...`, e);
			return null;
		}
	}

	/**
	 * Clear sticky account mapping when tool calling completes.
	 * This should be called when the assistant responds without tool_calls,
	 * indicating the tool-calling conversation has finished.
	 *
	 * @param conversationId - Unique identifier for the conversation
	 */
	public async clearStickyAccount(conversationId: string): Promise<void> {
		try {
			const key = `sticky:${conversationId}`;
			await this.env.GEMINI_CLI_KV.delete(key);
			console.log(`[Mitigation] Sticky account mapping cleared for conversation ${conversationId.substring(0, 8)}...`);
		} catch (e) {
			console.error(`[Mitigation] Failed to clear sticky account for conversation ${conversationId.substring(0, 8)}...`, e);
		}
	}

	/**
	 * Generate djb2 hash for conversation ID.
	 * Used when client doesn't provide X-Conversation-ID header.
	 *
	 * The djb2 algorithm is chosen for:
	 * - Good distribution properties
	 * - Fast computation
	 * - Simple implementation
	 *
	 * @param content - The content to hash (typically first user message)
	 * @returns A string hash suitable for use as conversation ID
	 */
	public generateConversationId(content: string): string {
		let hash = 5381;
		for (let i = 0; i < content.length; i++) {
			// hash = hash * 33 + content.charCodeAt(i)
			hash = ((hash << 5) + hash) + content.charCodeAt(i);
		}
		// Convert to unsigned 32-bit and then to hex string
		const hashHex = (hash >>> 0).toString(16);
		return `conv_${hashHex}`;
	}

	/**
	 * Report a failure for an account to update its health status.
	 */
	public async reportFailure(account: AuthManager, statusCode: number) {
		if (statusCode === 429 || statusCode === 503) {
			const accountId = account.id;
			await this.healthTracker.recordFailure(accountId);
		}
	}

	/**
	 * Update sticky account mapping when account rotation happens due to rate limit.
	 * This is critical for multi-turn tool calling - when a sticky account hits rate limit
	 * and rotates to a new account, we must update the sticky mapping so subsequent
	 * turns use the new account instead of the rate-limited one.
	 *
	 * @param conversationId - The conversation ID with sticky mapping
	 * @param newAccountId - The new account ID to map to
	 */
	public async updateStickyAccount(conversationId: string, newAccountId: number): Promise<void> {
		try {
			const key = `sticky:${conversationId}`;

			// Update the mapping with the same TTL
			await this.env.GEMINI_CLI_KV.put(key, newAccountId.toString(), {
				expirationTtl: this.STICKY_SESSION_TTL_SECONDS
			});

			console.log(`[Mitigation] Sticky account updated: ${conversationId.substring(0, 8)}... → Account ${newAccountId}`);
		} catch (e) {
			console.error(`[Mitigation] Failed to update sticky account for conversation ${conversationId.substring(0, 8)}...`, e);
		}
	}

	public getAccountCount(): number {
		return this.accounts.length;
	}

	public getAccounts(): AuthManager[] {
		return this.accounts;
	}
}

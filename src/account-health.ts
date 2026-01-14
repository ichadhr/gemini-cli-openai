import { Env } from "./types";

export interface AccountHealth {
	isRateLimited: boolean;
	lastRateLimitTime: number;
	failureCount: number;
	cooldownEnds: number;
}

const DEFAULT_COOLDOWN_MS = 60 * 1000; // 60 seconds
const KV_HEALTH_KEY_PREFIX = "account_health_";

export class AccountHealthTracker {
	private env: Env;
	private localHealth: Map<number, AccountHealth> = new Map();

	constructor(env: Env) {
		this.env = env;
	}

	/**
	 * Record a rate limit failure (429 or 503) for an account.
	 */
	public async recordFailure(accountId: number): Promise<void> {
		const now = Date.now();
		const cooldownEnds = now + DEFAULT_COOLDOWN_MS;

		const health: AccountHealth = {
			isRateLimited: true,
			lastRateLimitTime: now,
			failureCount: (this.localHealth.get(accountId)?.failureCount || 0) + 1,
			cooldownEnds
		};

		this.localHealth.set(accountId, health);
		console.log(`Account ${accountId} rate limited. Cooldown until ${new Date(cooldownEnds).toISOString()}`);

		// Persist to KV for distributed tracking
		// We fire and forget this to not block the request
		this.persistHealthToKV(accountId, health).catch((err) => {
			console.error(`Failed to persist health for account ${accountId}:`, err);
		});
	}

	/**
	 * Check if an account is healthy and available for use.
	 */
	public async isAccountHealthy(accountId: number): Promise<boolean> {
		const now = Date.now();

		// Check local cache first
		const localStatus = this.localHealth.get(accountId);
		if (localStatus) {
			if (localStatus.cooldownEnds > now) {
				return false;
			}
			// Cooldown expired, reset local status potentially
			if (localStatus.isRateLimited) {
				localStatus.isRateLimited = false;
				this.localHealth.set(accountId, localStatus);
			}
		}

		// Check KV for distributed state if not locally known to be bad
		// Optimization: We might want to skip this for every request if performance is key,
		// but for rate limits, consistency is better.
		// However, reading from KV on every check might be slow.
		// Strategy: Trust local state for "bad" status. Trust KV for "bad" status if local says "good" or unknown.
		// For now, let's implement a lightweight check or just rely on local state + occasional updates?
		// Better: Check KV only if we think it's healthy, to see if another worker marked it bad.

		try {
			const kvHealth = await this.env.GEMINI_CLI_KV.get<AccountHealth>(`${KV_HEALTH_KEY_PREFIX}${accountId}`, "json");
			if (kvHealth) {
				if (kvHealth.cooldownEnds > now) {
					// Update local cache
					this.localHealth.set(accountId, kvHealth);
					return false;
				}
			}
		} catch (e) {
			console.warn(`Error reading health from KV for account ${accountId}:`, e);
			// Fail open (assume healthy) if KV fails
		}

		return true;
	}

	/**
	 * Persist account health state to KV.
	 */
	private async persistHealthToKV(accountId: number, health: AccountHealth): Promise<void> {
		const ttl = Math.ceil((health.cooldownEnds - Date.now()) / 1000);
		if (ttl > 0) {
			await this.env.GEMINI_CLI_KV.put(
				`${KV_HEALTH_KEY_PREFIX}${accountId}`,
				JSON.stringify(health),
				{ expirationTtl: ttl } // expire when cooldown ends
			);
		}
	}

	/**
	 * Reset health status for an account (e.g. after successful usage if we wanted to implement fast recovery).
	 */
	public async recordSuccess(accountId: number): Promise<void> {
		// We generally don't need to clear 429 status on success immediately unless we implement half-open state.
		// For now, just let cooldown expire.
		// But if we had consecutive failures tracking, we could reset count here.
		const current = this.localHealth.get(accountId);
		if (current && current.failureCount > 0 && !current.isRateLimited) {
			current.failureCount = 0;
			this.localHealth.set(accountId, current);
		}
	}
}

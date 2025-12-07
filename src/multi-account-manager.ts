import { Env, OAuth2Credentials } from "./types";
import { AuthManager } from "./auth";
import { AccountHealthTracker } from "./account-health";

export class MultiAccountManager {
    private env: Env;
    private accounts: AuthManager[] = [];
    private healthTracker: AccountHealthTracker;
    private currentAccountIndex: number = 0;

    constructor(env: Env) {
        this.env = env;
        this.healthTracker = new AccountHealthTracker(env);
        this.initializeAccounts();
    }

    private initializeAccounts() {
        // 1. Check for numbered accounts GCP_SERVICE_ACCOUNT_0, _1, etc.
        let index = 0;
        while (true) {
            const envKey = `GCP_SERVICE_ACCOUNT_${index}`;
            // We need to cast env to any because these keys are dynamic and not in the Env interface definition explicitly
            const credentialsJson = (this.env as any)[envKey] as string | undefined;

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

        console.log(`Initialized MultiAccountManager with ${this.accounts.length} accounts`);
    }

    private addAccount(id: number, credentials: OAuth2Credentials) {
        // We need to modify AuthManager to accept credentials directly or we handle it here.
        // The current AuthManager loads from env.GCP_SERVICE_ACCOUNT.
        // We will modify AuthManager to accept credentials in constructor.
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
            const accountId = (account as any).id;

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

            console.log(`Skipping unhealthy GCP_SERVICE_ACCOUNT_${accountId}`);
            currentIndex = (currentIndex + 1) % this.accounts.length;
            attempts++;
        }

        console.warn("All accounts appear unhealthy or rate limited. Returning next available account.");
        return this.accounts[startIndex];
    }

    /**
     * Report a failure for an account to update its health status.
     */
    public async reportFailure(account: AuthManager, statusCode: number) {
        if (statusCode === 429 || statusCode === 503) {
            const accountId = (account as any).id;
            await this.healthTracker.recordFailure(accountId);
        }
    }

    public getAccountCount(): number {
        return this.accounts.length;
    }

    public getAccounts(): AuthManager[] {
        return this.accounts;
    }
}

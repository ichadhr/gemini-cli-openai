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
                console.error(`Failed to parse credentials for account ${index}:`, e);
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
     * Rotates through accounts using round-robin.
     */
    public async getAccount(): Promise<AuthManager> {
        if (this.accounts.length === 0) {
            throw new Error("No service accounts configured");
        }

        const startIndex = this.currentAccountIndex;
        let attempts = 0;

        while (attempts < this.accounts.length) {
            const account = this.accounts[this.currentAccountIndex];
            // The AuthManager has an 'id' property we will add
            const accountId = (account as any).id;

            if (await this.healthTracker.isAccountHealthy(accountId)) {
                // Move index for next time (round-robin)
                this.rotateIndex();
                return account;
            }

            console.log(`Skipping unhealthy account ${accountId}`);
            this.rotateIndex();
            attempts++;
        }

        // If all accounts are unhealthy, return the one that expires soonest?
        // Or just return the "next" one and hope for the best / let it fail to enforce backoff?
        // Returning the next one (original start) allows the caller to hit the rate limit and verify it's still bad.
        console.warn("All accounts appear unhealthy or rate limited. Returning next available account.");
        return this.accounts[startIndex];
    }

    private rotateIndex() {
        this.currentAccountIndex = (this.currentAccountIndex + 1) % this.accounts.length;
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

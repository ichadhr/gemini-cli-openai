import { Hono } from "hono";
import { Env } from "../types";
import { MultiAccountManager } from "../multi-account-manager";
import { GeminiApiClient } from "../gemini-client";

/**
 * Debug and testing routes for troubleshooting authentication and API functionality.
 */
export const DebugRoute = new Hono<{ Bindings: Env }>();

// Check KV cache status
DebugRoute.get("/cache", async (c) => {
	try {
		const multiAccountManager = new MultiAccountManager(c.env);
		const accounts = multiAccountManager.getAccounts();
		const results = [];

		for (const account of accounts) {
			const cacheInfo = await account.getCachedTokenInfo();
			results.push({
				account_id: account.id,
				status: "ok",
				cached: cacheInfo.cached,
				cached_at: cacheInfo.cached_at,
				expires_at: cacheInfo.expires_at,
				time_until_expiry_seconds: cacheInfo.time_until_expiry_seconds,
				is_expired: cacheInfo.is_expired,
				message: cacheInfo.message
			});
		}

		return c.json({
			accounts_count: accounts.length,
			accounts: results
		});
	} catch (e: unknown) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		return c.json(
			{
				status: "error",
				message: errorMessage
			},
			500
		);
	}
});

// Simple token test endpoint
DebugRoute.post("/token-test", async (c) => {
	try {
		console.log("Token test endpoint called");
		const multiAccountManager = new MultiAccountManager(c.env);

		// Test authentication with a healthy account
		const authManager = await multiAccountManager.getAccount();
		await authManager.initializeAuth();
		console.log(`Token test passed (Account ${authManager.id})`);

		return c.json({
			status: "ok",
			message: `Token authentication successful for account ${authManager.id}`
		});
	} catch (e: unknown) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		console.error("Token test error:", e);
		return c.json(
			{
				status: "error",
				message: errorMessage
				// Removed stack trace for security
			},
			500
		);
	}
});

// Full functionality test endpoint
DebugRoute.post("/test", async (c) => {
	try {
		console.log("Test endpoint called");
		const multiAccountManager = new MultiAccountManager(c.env);
		const geminiClient = new GeminiApiClient(c.env, multiAccountManager);

		// Test authentication
		const authManager = await multiAccountManager.getAccount();
		await authManager.initializeAuth();
		console.log(`Auth test passed (Account ${authManager.id})`);

		// Test project discovery
		const projectId = await geminiClient.discoverProjectId(authManager);
		console.log("Project discovery test passed");

		return c.json({
			status: "ok",
			message: "Authentication and project discovery successful",
			project_available: !!projectId
			// Removed actual projectId for security
		});
	} catch (e: unknown) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		console.error("Test endpoint error:", e);
		return c.json(
			{
				status: "error",
				message: errorMessage
				// Removed stack trace and detailed error message for security
			},
			500
		);
	}
});

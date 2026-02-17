import { MiddlewareHandler } from "hono";
import { Env } from "../types";
import { errors } from "../utils/errors";

/**
 * Middleware to enforce OpenAI-style API key authentication if OPENAI_API_KEY is set in the environment.
 * Checks for 'Authorization: Bearer <key>' header on protected routes.
 */
export const openAIApiKeyAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
	// Skip authentication for public endpoints
	const publicEndpoints = ["/", "/health"];
	if (publicEndpoints.some((endpoint) => c.req.path === endpoint)) {
		await next();
		return;
	}

	// If OPENAI_API_KEY is set in environment, require authentication
	if (c.env.OPENAI_API_KEY) {
		const authHeader = c.req.header("Authorization");

		if (!authHeader) {
			return c.json(errors.missingAuthorization(), 401);
		}

		// Check for Bearer token format
		const match = authHeader.match(/^Bearer\s+(.+)$/);
		if (!match) {
			return c.json(errors.invalidAuthorizationFormat(), 401);
		}

		const providedKey = match[1];
		if (providedKey !== c.env.OPENAI_API_KEY) {
			return c.json(errors.authentication("Invalid API key"), 401);
		}

		// Optionally log successful authentication
		// console.log('API key authentication successful');
	}

	await next();
};

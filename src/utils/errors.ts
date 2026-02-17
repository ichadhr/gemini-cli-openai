/**
 * OpenAI-compatible error response helper
 * @see https://platform.openai.com/docs/guides/error-codes
 */

export interface OpenAIError {
	message: string;
	type: string;
	code: string;
	param?: string | null;
}

export interface OpenAIErrorResponse {
	error: OpenAIError;
}

/**
 * Creates an OpenAI-compatible error response
 * @param message - Human-readable error message
 * @param type - Error type (e.g., "invalid_request_error")
 * @param code - Machine-readable error code
 * @param param - Optional parameter that caused the error
 * @returns OpenAI-compatible error response object
 */
export function createErrorResponse(
	message: string,
	type: string = "api_error",
	code: string = "unknown_error",
	param?: string | null
): OpenAIErrorResponse {
	return {
		error: {
			message,
			type,
			code,
			param: param ?? null
		}
	};
}

/**
 * Common error types for OpenAI API compatibility
 */
export const errorTypes = {
	INVALID_REQUEST: "invalid_request_error",
	AUTHENTICATION: "authentication_error",
	PERMISSION_DENIED: "permission_denied_error",
	NOT_FOUND: "not_found_error",
	RATE_LIMIT: "rate_limit_error",
	SERVER: "server_error"
} as const;

/**
 * Common error codes for OpenAI API compatibility
 */
export const errorCodes = {
	// Invalid request errors
	INVALID_JSON: "invalid_json",
	MISSING_PARAMETER: "missing_parameter",
	INVALID_PARAMETER: "invalid_parameter",
	STRING_TOO_LONG: "string_too_long",
	INVALID_MODEL: "invalid_model",
	INVALID_MESSAGES: "invalid_messages",

	// Authentication errors
	INVALID_API_KEY: "invalid_api_key",
	MISSING_AUTHORIZATION: "missing_authorization",
	INVALID_AUTHORIZATION_FORMAT: "invalid_authorization_format",

	// Permission errors
	INSUFFICIENT_QUOTA: "insufficient_quota",
	ACCESS_DENIED: "access_denied",

	// Not found errors
	MODEL_NOT_FOUND: "model_not_found",
	ENDPOINT_NOT_FOUND: "endpoint_not_found",

	// Rate limit errors
	RATE_LIMIT_EXCEEDED: "rate_limit_exceeded",
	QUOTA_EXCEEDED: "quota_exceeded",

	// Server errors
	INTERNAL_ERROR: "internal_server_error",
	SERVER_OVERLOADED: "server_overloaded",
	STREAM_ERROR: "stream_error"
} as const;

/**
 * Convenience helpers for common error scenarios
 */
export const errors = {
	/**
	 * Invalid request error (400)
	 * Used for malformed requests, invalid parameters, etc.
	 */
	invalidRequest: (message: string, param?: string) =>
		createErrorResponse(message, errorTypes.INVALID_REQUEST, errorCodes.INVALID_PARAMETER, param),

	/**
	 * Missing required field error (400)
	 */
	missingField: (fieldName: string) =>
		createErrorResponse(
			`Missing required field: ${fieldName}`,
			errorTypes.INVALID_REQUEST,
			errorCodes.MISSING_PARAMETER,
			fieldName
		),

	/**
	 * Authentication error (401)
	 * Used for invalid or missing API keys
	 */
	authentication: (message: string, code?: string) =>
		createErrorResponse(
			message,
			errorTypes.AUTHENTICATION,
			code ?? errorCodes.INVALID_API_KEY
		),

	/**
	 * Missing authorization header (401)
	 */
	missingAuthorization: () =>
		createErrorResponse(
			"Missing Authorization header",
			errorTypes.AUTHENTICATION,
			errorCodes.MISSING_AUTHORIZATION
		),

	/**
	 * Invalid authorization format (401)
	 */
	invalidAuthorizationFormat: () =>
		createErrorResponse(
			"Invalid Authorization header format. Expected: Bearer <token>",
			errorTypes.AUTHENTICATION,
			errorCodes.INVALID_AUTHORIZATION_FORMAT
		),

	/**
	 * Permission denied error (403)
	 * Used for insufficient quota, access denied, etc.
	 */
	permissionDenied: (message: string, code?: string) =>
		createErrorResponse(
			message,
			errorTypes.PERMISSION_DENIED,
			code ?? errorCodes.ACCESS_DENIED
		),

	/**
	 * Not found error (404)
	 * Used for invalid model, endpoint not found, etc.
	 */
	notFound: (message: string) =>
		createErrorResponse(message, errorTypes.NOT_FOUND, errorCodes.MODEL_NOT_FOUND),

	/**
	 * Rate limit error (429)
	 * Used when quota or rate limit is exceeded
	 */
	rateLimit: (message: string) =>
		createErrorResponse(message, errorTypes.RATE_LIMIT, errorCodes.RATE_LIMIT_EXCEEDED),

	/**
	 * Server error (500)
	 * Used for internal server errors
	 */
	server: (message: string) =>
		createErrorResponse(message, errorTypes.SERVER, errorCodes.INTERNAL_ERROR),

	/**
	 * Stream error (500)
	 * Used for streaming-specific errors
	 */
	streamError: (message: string) =>
		createErrorResponse(message, errorTypes.SERVER, errorCodes.STREAM_ERROR)
} as const;

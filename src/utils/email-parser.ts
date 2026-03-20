/**
 * Parse email address from Google OAuth2 id_token (JWT).
 * @param idToken - The id_token from OAuth2 credentials
 * @returns The email address or null if not found
 */
export function parseEmailFromIdToken(idToken: string): string | null {
	try {
		const parts = idToken.split('.');
		if (parts.length !== 3) return null;

		// Decode JWT payload (base64url)
		const payload = JSON.parse(atob(parts[1]));
		return payload.email || null;
	} catch {
		return null;
	}
}

/**
 * Extract account name from email (without domain).
 * @param email - Full email address
 * @returns Account name without domain (e.g., "ichadhr" from "ichadhr@gmail.com")
 */
export function getAccountName(email: string | null): string {
	if (!email) return 'unknown';
	return email.split('@')[0];
}

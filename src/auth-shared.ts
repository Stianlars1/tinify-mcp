/**
 * Auth primitives shared between the HTTP entry ({@link ../http.ts}) and the
 * OAuth provider ({@link ./oauth.ts}). Kept in its own module so both can
 * import it without creating a cycle.
 */

/** tnf_live_* or tnf_test_* followed by at least one key character. */
export const API_KEY_PATTERN = /^tnf_(?:live|test)_[A-Za-z0-9._-]+$/;

/** Extracts the raw token from an `Authorization: Bearer <token>` header. */
export function extractBearerToken(
  authorization: string | undefined,
): string | null {
  if (authorization === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (match === null) return null;
  const token = (match[1] ?? "").trim();
  return token === "" ? null : token;
}

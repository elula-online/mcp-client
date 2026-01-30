
// Response cache for performance optimization
let RESPONSE_CACHE: {
  UNAUTHORIZED: Response;
  FORBIDDEN: Response;
  SERVER_ERROR: Response;
} | null = null;

/**
 * Initialize response cache for reuse
 */
function getResponseCache() {
  if (!RESPONSE_CACHE) {
    RESPONSE_CACHE = {
      UNAUTHORIZED: Response.json(
        {
          error: "Missing authentication header",
          timestamp: new Date().toISOString(),
        },
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      ),
      FORBIDDEN: Response.json(
        {
          error: "Invalid authentication credentials",
          timestamp: new Date().toISOString(),
        },
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      ),
      SERVER_ERROR: Response.json(
        {
          error: "Authentication not properly configured",
          timestamp: new Date().toISOString(),
        },
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      ),
    };
  }
  return RESPONSE_CACHE;
}

// Cache for debug mode check using WeakMap
const DEBUG_CACHE = new WeakMap<any, boolean>();


function isDebugMode(env: any): boolean {
  if (!DEBUG_CACHE.has(env)) {
    DEBUG_CACHE.set(env, env.DEBUG === "1" || env.DEBUG === 1);
  }
  return DEBUG_CACHE.get(env)!;
}

/**
 * Timing-safe string comparison to prevent timing attacks
 * CRITICAL SECURITY: Prevents attackers from using response time to guess tokens
 * 
 * @param a - First string (user-provided token)
 * @param b - Second string (expected token)
 * @returns true if strings match
 */
function timingSafeEqual(a: string | null, b: string | null): boolean {
  // Handle null/undefined cases
  if (!a || !b) {
    // Still perform a dummy comparison to maintain constant time
    const dummyA = new TextEncoder().encode("dummy");
    const dummyB = new TextEncoder().encode("dummy");
    let result = 0;
    for (let i = 0; i < dummyA.length; i++) {
      result |= dummyA[i] ^ dummyB[i];
    }
    return false;
  }

  const bufA = new TextEncoder().encode(a);
  const bufB = new TextEncoder().encode(b);

  // Always compare the longer length to maintain constant time
  const maxLength = Math.max(bufA.length, bufB.length);
  let result = bufA.length ^ bufB.length; 

  // Compare all bytes up to max length
  for (let i = 0; i < maxLength; i++) {
    const byteA = i < bufA.length ? bufA[i] : 0;
    const byteB = i < bufB.length ? bufB[i] : 0;
    result |= byteA ^ byteB;
  }

  return result === 0;
}

/**
 * Custom error class for authentication failures
 */
export class AuthError extends Error {
  constructor(
    message: string,
    public statusCode: number = 401,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Validates the authentication header using timing-safe comparison
 * 
 * @param request - The incoming Request object
 * @param authSecret - The secret key from environment variables
 * @param env - Environment object (for debug mode)
 * @returns Response object if authentication fails, null if passes
 */
export function validateAuth(
  request: Request,
  authSecret: string,
  env?: any,
): Response | null {
  const startTime = performance.now();
  const debug = env ? isDebugMode(env) : false;

  // Get authentication header
  const providedToken = request.headers.get("X-PARAAT-AUTH");

  // Debug logging (only when enabled)
  if (debug) {
    console.log("[AUTH] Validating request");
    console.log("[AUTH] Token present:", !!providedToken);
    console.log("[AUTH] Expected secret configured:", !!authSecret);
  }

  // Check if auth secret is configured (server-side issue)
  if (!authSecret) {
    if (debug) {
      console.error("[AUTH] PARAAT_AUTH_SECRET not configured in environment");
    }
    return getResponseCache().SERVER_ERROR.clone();
  }

  // Check if token was provided (client-side issue)
  if (!providedToken) {
    if (debug) {
      console.warn("[AUTH] No authentication token provided");
      const duration = performance.now() - startTime;
      console.log(`[AUTH_PERF] Validation time: ${duration.toFixed(2)}ms`);
    }
    return getResponseCache().UNAUTHORIZED.clone();
  }

  // Perform timing-safe comparison to prevent timing attacks
  const isValid = timingSafeEqual(providedToken, authSecret);

  // Debug logging
  if (debug) {
    const duration = performance.now() - startTime;
    console.log(`[AUTH_PERF] Validation time: ${duration.toFixed(2)}ms`);
    console.log("[AUTH] Result:", isValid ? "PASS" : "FAIL");
  }

  // Return error response if invalid
  if (!isValid) {
    return getResponseCache().FORBIDDEN.clone();
  }

  // Authentication successful
  return null;
}

/**
 * Creates a standardized error response for authentication failures
 * (Kept for backward compatibility, but validateAuth now returns Response directly)
 * 
 * @param error - The error object
 * @returns Response object with appropriate error message and status code
 */
export function createAuthErrorResponse(error: AuthError | Error): Response {
  const statusCode = error instanceof AuthError ? error.statusCode : 500;
  const message =
    error instanceof AuthError
      ? error.message
      : "Internal authentication error";

  return Response.json(
    {
      error: message,
      timestamp: new Date().toISOString(),
    },
    {
      status: statusCode,
      headers: {
        "Content-Type": "application/json",
      },
    },
  );
}

/**
 * Middleware wrapper that applies authentication to a handler function
 * 
 * @param handler - The request handler function to wrap
 * @param authSecret - The secret key from environment variables
 * @param env - Environment object (for debug mode)
 * @returns Wrapped handler with authentication
 */
export function withAuth(
  handler: (request: Request) => Promise<Response>,
  authSecret: string,
  env?: any,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const authResult = validateAuth(request, authSecret, env);

    // If authentication failed, return error response
    if (authResult !== null) {
      return authResult;
    }

    // Authentication passed, proceed to handler
    return await handler(request);
  };
}

/**
 * Generate a secure random token for use as PARAAT_AUTH_SECRET
 * This is a helper function for documentation/setup purposes
 * 
 * @param length - Length in bytes (default 32)
 * @returns Hex-encoded random token
 */
export function generateSecureToken(length: number = 32): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
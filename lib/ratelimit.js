/**
 * Login attempt throttle.
 *
 * The deployed site runs on many short-lived serverless instances, so an
 * in-memory counter only throttles whichever instance happens to handle a
 * request — an attacker gets a fresh allowance on every new instance. When
 * Upstash Redis credentials are present this uses Upstash's REST API instead,
 * giving one shared counter across every instance and every region. Without
 * them it falls back to the in-memory map, so local dev and unconfigured
 * deploys still work (with a weaker limit).
 *
 * Fixed window: the first failure from an address starts a WINDOW_MS timer, and
 * MAX_ATTEMPTS failures inside it block further attempts until the window ends.
 * A successful sign-in clears the counter.
 *
 * Upstash is called over plain HTTP rather than through @upstash/redis, to keep
 * the project dependency-light; the commands used (GET / PTTL / INCR / EXPIRE /
 * DEL) are simple enough that the client buys us little.
 */

export const WINDOW_MS = 15 * 60 * 1000;
export const MAX_ATTEMPTS = 10;

const WINDOW_SECONDS = Math.ceil(WINDOW_MS / 1000);
const KEY_PREFIX = "lsc:login";

// Bound on the in-memory fallback. `clientIp()` reads a spoofable
// X-Forwarded-For, so an attacker can present unlimited distinct addresses;
// without a cap the map would grow without bound. Once at the cap, stale
// entries are dropped and, if every entry is still fresh, the oldest is evicted
// (Map preserves insertion order).
const MAX_TRACKED_IPS = 10_000;
const memoryAttempts = new Map();

function restUrl() {
  return String(process.env.UPSTASH_REDIS_REST_URL || "")
    .trim()
    .replace(/\/+$/, "");
}

function restToken() {
  return String(process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
}

/** True when a shared Redis backend is configured. */
export function rateLimitConfigured() {
  return Boolean(restUrl() && restToken());
}

const keyFor = (ip) => `${KEY_PREFIX}:${ip}`;

/** Run a small Redis command pipeline through Upstash's REST API. */
async function redisPipeline(commands) {
  const response = await fetch(`${restUrl()}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${restToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
    // Never let a slow cache hold up a sign-in response.
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`Upstash responded ${response.status}`);
  const results = await response.json();
  return results.map((entry) => (entry && "result" in entry ? entry.result : null));
}

/**
 * Whether an address has used up its attempts.
 * @returns {Promise<{blocked: boolean, retryAfterSeconds: number}>}
 */
export async function isThrottled(ip) {
  if (rateLimitConfigured()) {
    try {
      const [count, pttl] = await redisPipeline([
        ["GET", keyFor(ip)],
        ["PTTL", keyFor(ip)],
      ]);
      const used = Number(count) || 0;
      if (used >= MAX_ATTEMPTS) {
        // PTTL is -1 (no expiry) / -2 (missing); fall back to the full window.
        const ttl = Number(pttl);
        const remaining = ttl > 0 ? ttl : WINDOW_MS;
        return { blocked: true, retryAfterSeconds: Math.ceil(remaining / 1000) };
      }
      return { blocked: false, retryAfterSeconds: 0 };
    } catch {
      // A cache outage must not lock admins out — fall through to the in-memory
      // check rather than failing the request.
    }
  }
  return memoryIsThrottled(ip);
}

/** Count one failed attempt against an address. */
export async function recordFailure(ip) {
  if (rateLimitConfigured()) {
    try {
      await redisPipeline([
        ["INCR", keyFor(ip)],
        ["EXPIRE", keyFor(ip), String(WINDOW_SECONDS), "NX"],
      ]);
      return;
    } catch {
      // A cache outage must not drop the attempt entirely — fall through.
    }
  }
  memoryRecordFailure(ip);
}

/** Forget an address's failures (a successful sign-in). */
export async function clearFailures(ip) {
  if (rateLimitConfigured()) {
    try {
      await redisPipeline([["DEL", keyFor(ip)]]);
      return;
    } catch {
      // Fall through and clear the in-memory entry too.
    }
  }
  memoryAttempts.delete(ip);
}

/** Test/ops hook: how many addresses the in-memory fallback is tracking. */
export function trackedIpCount() {
  return memoryAttempts.size;
}

function pruneMemory(now) {
  if (memoryAttempts.size < MAX_TRACKED_IPS) return;
  for (const [ip, entry] of memoryAttempts) {
    if (now - entry.first >= WINDOW_MS) memoryAttempts.delete(ip);
  }
  while (memoryAttempts.size >= MAX_TRACKED_IPS) {
    memoryAttempts.delete(memoryAttempts.keys().next().value);
  }
}

function memoryIsThrottled(ip) {
  const entry = memoryAttempts.get(ip);
  if (!entry) return { blocked: false, retryAfterSeconds: 0 };
  const elapsed = Date.now() - entry.first;
  if (elapsed >= WINDOW_MS || entry.count < MAX_ATTEMPTS) {
    return { blocked: false, retryAfterSeconds: 0 };
  }
  return { blocked: true, retryAfterSeconds: Math.ceil((WINDOW_MS - elapsed) / 1000) };
}

function memoryRecordFailure(ip) {
  const now = Date.now();
  pruneMemory(now);
  const entry = memoryAttempts.get(ip);
  if (!entry || now - entry.first >= WINDOW_MS) {
    memoryAttempts.set(ip, { first: now, count: 1 });
    return;
  }
  entry.count += 1;
}

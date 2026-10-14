// SPEC-2026-10-08-kaneo-workspace-collaboration: public reads/writes are
// rate-limited per token hash and per client IP. In-memory sliding window is
// sufficient for a single API instance behind the tunnel; a multi-instance
// deployment should move these buckets to Redis before scaling out.

type Bucket = { hits: number[] };

const buckets = new Map<string, Bucket>();

const WINDOW_MS = Number(process.env.SHARE_RATE_LIMIT_WINDOW_MS ?? 60_000);

// Read lazily so integration tests can tighten limits via process.env.
function limits() {
  return {
    read: Number(process.env.SHARE_RATE_LIMIT_READ ?? 60),
    write: Number(process.env.SHARE_RATE_LIMIT_WRITE ?? 20),
  };
}

export type ShareRateLimitScope = "read" | "write";

function takeHit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { hits: [] };
    buckets.set(key, bucket);
  }
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs);
  if (bucket.hits.length >= limit) {
    return false;
  }
  bucket.hits.push(now);

  // Opportunistic GC so abandoned buckets do not grow unbounded.
  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) {
      const lastHit = b.hits[b.hits.length - 1] ?? 0;
      if (b.hits.length === 0 || now - lastHit > windowMs) {
        buckets.delete(k);
      }
    }
  }
  return true;
}

export function checkShareRateLimit(
  scope: ShareRateLimitScope,
  tokenHash: string,
  ip: string,
): { allowed: boolean; limit: number; retryAfterSeconds: number } {
  const limit = scope === "read" ? limits().read : limits().write;
  const tokenAllowed = takeHit(`token:${scope}:${tokenHash}`, limit, WINDOW_MS);
  const ipAllowed = takeHit(`ip:${scope}:${ip}`, limit * 10, WINDOW_MS);
  return {
    allowed: tokenAllowed && ipAllowed,
    limit,
    retryAfterSeconds: Math.ceil(WINDOW_MS / 1000),
  };
}

// Test hook: clear all buckets between test cases.
export function resetShareRateLimits() {
  buckets.clear();
}

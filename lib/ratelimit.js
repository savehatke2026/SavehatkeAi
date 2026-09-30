/* ============================================================
   SaveHatke AI — best-effort in-memory rate limiting.

   This blunts casual API abuse (a script hammering /api/chat) but it is
   NOT a security boundary: on Vercel it lives per warm serverless
   instance, so a determined attacker spreading load across instances
   gets a higher effective limit. Real volumetric protection belongs at
   the platform/edge layer. Authorization is enforced independently and
   unconditionally — this only limits how fast an already-authorized
   caller can go.
   ============================================================ */

const buckets = new Map();

/** Drops buckets that have fully drained so the map cannot grow forever. */
function sweep(now) {
  if (buckets.size < 5000) return;
  for (const [key, bucket] of buckets) {
    if (now - bucket.updatedAt > 10 * 60 * 1000) buckets.delete(key);
  }
}

/**
 * Fixed-window counter.
 * @returns {{allowed:boolean, retryAfterSeconds:number}}
 */
export function checkRateLimit(key, { limit, windowSeconds }) {
  const now = Date.now();
  sweep(now);

  const windowMs = windowSeconds * 1000;
  let bucket = buckets.get(key);

  if (!bucket || now - bucket.startedAt >= windowMs) {
    bucket = { startedAt: now, count: 0, updatedAt: now };
    buckets.set(key, bucket);
  }

  bucket.updatedAt = now;
  bucket.count += 1;

  if (bucket.count > limit) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((bucket.startedAt + windowMs - now) / 1000)
    );
    return { allowed: false, retryAfterSeconds };
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

export function resetRateLimits() {
  buckets.clear();
}
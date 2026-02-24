import { env } from "@/lib/env";
import { log } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

function windowStart(date: Date): Date {
  const windowMs = env.rateLimitWindowSeconds * 1000;
  const start = Math.floor(date.getTime() / windowMs) * windowMs;
  return new Date(start);
}

export async function assertRouteWithinRateLimit(
  vendorId: string,
  routeKey: keyof typeof env.rateLimitByRoute
): Promise<void> {
  const limit = env.rateLimitByRoute[routeKey];
  const now = new Date();
  const bucketStart = windowStart(now);

  const result = await prisma.rateLimitWindow.upsert({
    where: {
      vendorId_routeKey_windowStart: {
        vendorId,
        routeKey,
        windowStart: bucketStart
      }
    },
    create: {
      vendorId,
      routeKey,
      windowStart: bucketStart,
      count: 1
    },
    update: {
      count: {
        increment: 1
      }
    },
    select: {
      count: true
    }
  });

  const usageRatio = result.count / limit;
  if (usageRatio >= 0.8 && usageRatio < 1) {
    log("info", "gateway_rate_limit_near_threshold", {
      vendorId,
      routeKey,
      count: result.count,
      limit
    });
  }

  if (result.count > limit) {
    const nowMs = now.getTime();
    const windowMs = env.rateLimitWindowSeconds * 1000;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((bucketStart.getTime() + windowMs - nowMs) / 1000)
    );

    log("warn", "gateway_rate_limit_exceeded", {
      vendorId,
      routeKey,
      count: result.count,
      limit,
      retryAfterSeconds
    });

    throw new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(retryAfterSeconds)
      }
    });
  }
}

import { env } from "@/lib/env";
import { log } from "@/lib/logger";

export function assertSpecbooksApiKey(req: Request): void {
  const key = req.headers.get("X-SPECBOOKS-API-KEY");
  if (!key || key !== env.specbooksApiKey) {
    log("warn", "gateway_auth_rejected", {
      path: new URL(req.url).pathname,
      method: req.method,
      hasApiKey: Boolean(key)
    });
    throw new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" }
    });
  }
}

export function assertInternalBearer(req: Request): void {
  const expected = process.env.MLD_QUEUE_TOKEN?.trim();
  const auth = req.headers.get("authorization") || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  if (!expected || !provided || provided !== expected) {
    log("warn", "gateway_internal_auth_rejected", {
      path: new URL(req.url).pathname,
      method: req.method,
      hasExpectedToken: Boolean(expected),
      hasAuthHeader: Boolean(auth)
    });
    throw new Response(JSON.stringify({ error: "Unauthorized", code: "UNAUTHORIZED" }), {
      status: 401,
      headers: { "content-type": "application/json" }
    });
  }
}

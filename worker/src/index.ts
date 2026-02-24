import "dotenv/config";
import http from "node:http";
import { env } from "./lib/env";
import { log } from "./lib/logger";
import { startWorker } from "./worker";

async function main() {
  await startWorker();

  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(env.port, () => {
    log("info", "health_server_started", { port: env.port });
  });
}

main().catch((error) => {
  log("error", "worker_boot_failed", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});

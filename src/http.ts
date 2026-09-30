#!/usr/bin/env node
import "dotenv/config";
import { createHttpApp } from "./httpApp.js";
import { HttpConfigError, readHttpConfig, type HttpConfig } from "./httpConfig.js";

/**
 * Executable entry point of the remote server: Streamable HTTP with OAuth,
 * meant to run on the ERP host behind Apache (see docs/deployment.md).
 *
 * Like index.ts it starts unconditionally — it is only ever loaded as the bin
 * or via `node dist/http.js`. Unlike index.ts, stdout is free here (no stdio
 * protocol), but diagnostics still go to stderr so journald keeps them apart.
 */
function loadConfig(): HttpConfig {
  try {
    return readHttpConfig(process.env);
  } catch (error) {
    if (error instanceof HttpConfigError) {
      console.error(`fifty1-erp-mcp-http: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

const SHUTDOWN_GRACE_MS = 10_000;

function main(): void {
  const config = loadConfig();
  const app = createHttpApp({ publicUrl: config.publicUrl, apiBaseUrl: config.apiBaseUrl });

  const server = app.listen(config.port, config.host, () => {
    console.log(
      `fifty1-erp-mcp-http lauscht auf http://${config.host}:${config.port}${config.publicUrl.pathname}` +
        ` (öffentlich: ${config.publicUrl.href}, ERP: ${config.apiBaseUrl})`,
    );
  });

  server.on("error", (error) => {
    console.error("fifty1-erp-mcp-http konnte nicht starten:", error);
    process.exit(1);
  });

  // systemd stops with SIGTERM: finish in-flight tool calls, then exit. The
  // timer covers clients that keep connections open.
  const shutdown = (signal: string) => {
    console.error(`fifty1-erp-mcp-http: ${signal} empfangen, fahre herunter …`);
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

main();

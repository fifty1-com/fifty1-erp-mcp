import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The bin is installed as a symlink by npm (npx, global installs), so the entry
 * point must not decide whether to start by comparing import.meta.url against
 * process.argv[1] — that comparison fails there, the server never starts, and
 * the client only sees "Connection closed".
 */
describe("executable entry point", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

  it("starts unconditionally instead of guessing whether it is the entry point", () => {
    expect(source).not.toContain("import.meta.url ===");
    expect(source).toMatch(/^main\(\)/m);
  });

  it("keeps the importable server out of the executable module", () => {
    expect(source).toContain('from "./server.js"');
    expect(source).not.toContain("export function createServer");
  });
});

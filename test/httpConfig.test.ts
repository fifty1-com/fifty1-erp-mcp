import { describe, expect, it } from "vitest";
import { readHttpConfig } from "../src/httpConfig.js";

/**
 * A misconfigured remote server should refuse to start with a message that
 * says what to set — not come up and answer every client with 401s because the
 * token audience does not match.
 */
describe("readHttpConfig", () => {
  const base = {
    MCP_PUBLIC_URL: "https://erp.fifty1.com/mcp",
    FIFTY1_API_BASE_URL: "https://erp.fifty1.com/api",
  };

  it("applies the defaults for port and host", () => {
    expect(readHttpConfig(base)).toEqual({
      publicUrl: new URL("https://erp.fifty1.com/mcp"),
      apiBaseUrl: "https://erp.fifty1.com/api",
      port: 3030,
      host: "127.0.0.1",
    });
  });

  it("takes port and host from the environment", () => {
    const config = readHttpConfig({ ...base, PORT: "8081", HOST: "0.0.0.0" });

    expect(config.port).toBe(8081);
    expect(config.host).toBe("0.0.0.0");
  });

  it("names both required variables when they are missing", () => {
    expect(() => readHttpConfig({})).toThrowError(/MCP_PUBLIC_URL.*FIFTY1_API_BASE_URL/s);
  });

  it("rejects a public URL that is not a URL", () => {
    expect(() => readHttpConfig({ ...base, MCP_PUBLIC_URL: "erp.fifty1.com/mcp" })).toThrowError(
      /MCP_PUBLIC_URL/,
    );
  });

  it("rejects plain http for a public host", () => {
    expect(() =>
      readHttpConfig({ ...base, MCP_PUBLIC_URL: "http://erp.fifty1.com/mcp" }),
    ).toThrowError(/https/);
  });

  it("allows plain http on localhost for development", () => {
    const config = readHttpConfig({ ...base, MCP_PUBLIC_URL: "http://localhost:3030/mcp" });

    expect(config.publicUrl.href).toBe("http://localhost:3030/mcp");
  });

  it("rejects a public URL with query or fragment", () => {
    expect(() =>
      readHttpConfig({ ...base, MCP_PUBLIC_URL: "https://erp.fifty1.com/mcp?x=1" }),
    ).toThrowError(/MCP_PUBLIC_URL/);
  });

  it("rejects an API base URL that is not a URL", () => {
    expect(() => readHttpConfig({ ...base, FIFTY1_API_BASE_URL: "api" })).toThrowError(
      /FIFTY1_API_BASE_URL/,
    );
  });

  it.each(["0", "70000", "abc", "30.5"])("rejects the port %s", (port) => {
    expect(() => readHttpConfig({ ...base, PORT: port })).toThrowError(/PORT/);
  });
});

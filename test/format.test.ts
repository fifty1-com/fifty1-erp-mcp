import { describe, expect, it } from "vitest";
import { money, percent, hours, summarizeList } from "../src/format.js";

describe("money", () => {
  it("always carries the currency", () => {
    expect(money(1234.5)).toMatch(/€/);
    expect(money(1234.5)).toMatch(/1\.234,50/);
  });

  it("returns null rather than a misleading zero for a missing amount", () => {
    expect(money(null)).toBeNull();
    expect(money(undefined)).toBeNull();
  });

  it("formats zero as an amount", () => {
    expect(money(0)).toMatch(/0,00/);
  });
});

describe("percent and hours", () => {
  it("formats a percentage with a unit", () => {
    expect(percent(73.373)).toBe("73,4 %");
  });

  it("formats hours with a unit", () => {
    expect(hours(10.5)).toBe("10,5 h");
  });

  it("passes missing values through as null", () => {
    expect(percent(null)).toBeNull();
    expect(hours(undefined)).toBeNull();
  });
});

describe("summarizeList", () => {
  const envelope = (over: Partial<Parameters<typeof summarizeList>[0]> = {}) => ({
    items: [],
    total: 0,
    returned: 0,
    limit: 25,
    offset: 0,
    has_more: false,
    ...over,
  });

  it("says plainly when nothing matched", () => {
    expect(summarizeList(envelope(), "Projekte")).toBe("Keine Projekte gefunden.");
  });

  it("does not suggest paging when everything is shown", () => {
    expect(summarizeList(envelope({ total: 3, returned: 3, items: [1, 2, 3] }), "Projekte"))
      .toBe("3 Projekte.");
  });

  it("names the next offset when there is more", () => {
    const text = summarizeList(
      envelope({ total: 40, returned: 25, has_more: true, items: new Array(25).fill(0) }),
      "Projekte",
    );

    expect(text).toContain("25 von 40");
    expect(text).toContain("offset=25");
  });
});

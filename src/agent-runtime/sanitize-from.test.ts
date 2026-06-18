import { describe, expect, it } from "bun:test";
import { sanitizeMailFrom } from "./sanitize-from.js";

describe("sanitizeMailFrom", () => {
  it("returns a clean address unchanged", () => {
    expect(sanitizeMailFrom("channel:cli:don")).toBe("channel:cli:don");
    expect(sanitizeMailFrom("agent:archie")).toBe("agent:archie");
  });

  it("removes newline/carriage-return characters", () => {
    expect(sanitizeMailFrom("channel:cli:foo\nbar")).toBe("channel:cli:foo bar");
    expect(sanitizeMailFrom("channel:cli:foo\rbar")).toBe("channel:cli:foo bar");
  });

  it("escapes backticks and backslashes", () => {
    expect(sanitizeMailFrom("channel:cli:`whoami`")).toBe("channel:cli:\\`whoami\\`");
    expect(sanitizeMailFrom("channel:cli:C:\\path")).toBe("channel:cli:C:\\\\path");
  });

  it("trims whitespace", () => {
    expect(sanitizeMailFrom("  channel:cli:don  ")).toBe("channel:cli:don");
  });

  it("caps length", () => {
    const long = "a".repeat(300);
    expect(sanitizeMailFrom(long).length).toBe(200);
  });
});

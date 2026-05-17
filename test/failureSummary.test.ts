import { describe, expect, it } from "vitest";
import { summarizeFailure } from "../src/App";

describe("summarizeFailure", () => {
  it("flags Codex usage-limit dumps as a usage / credit limit", () => {
    const raw = [
      "OpenAI Codex failed with exit code 1:",
      "OpenAI Codex v0.129.0-alpha.15 (research preview)",
      "ERROR: You've hit your usage limit. Upgrade to Pro …",
      "ERROR: You've hit your usage limit."
    ].join("\n");
    const summary = summarizeFailure(raw);
    expect(summary).toMatch(/Usage \/ credit limit reached/i);
    expect(summary).toMatch(/usage limit/i);
    // The huge stderr blob is NOT preserved verbatim in the summary.
    expect(summary.length).toBeLessThan(700);
  });

  it("flags rate-limit / quota / 402 messages as usage limits too", () => {
    expect(summarizeFailure("Error 402: Payment required")).toMatch(/Usage \/ credit limit/);
    expect(summarizeFailure("Quota exceeded for this account")).toMatch(/Usage \/ credit limit/);
    expect(summarizeFailure("Rate limit reached. Try again later.")).toMatch(/Usage \/ credit limit/);
  });

  it("falls back to a generic failure summary for other errors", () => {
    const summary = summarizeFailure("Network unreachable: ECONNREFUSED 127.0.0.1:443");
    expect(summary).toMatch(/run failed/i);
    expect(summary).toContain("Network unreachable");
  });

  it("returns a clean message when the raw output is empty", () => {
    expect(summarizeFailure("   ")).toMatch(/failed without a reason/i);
  });

  it("recognises a SIGTERM-style timeout dump as a timeout, not a generic failure", () => {
    expect(summarizeFailure("Claude Code failed: Claude Code exited with code 143.")).toMatch(/ran out of time/i);
    expect(summarizeFailure("OpenAI Codex failed: OpenAI Codex exited with code 137.")).toMatch(/ran out of time/i);
    expect(summarizeFailure("Claude Code did not finish within 480s and was terminated.")).toMatch(/ran out of time/i);
  });
});

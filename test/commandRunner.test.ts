import { describe, expect, it } from "vitest";
import { sanitizeEnvForChild, SpawnCommandRunner } from "../electron/commandRunner";

const runner = new SpawnCommandRunner();

describe("SpawnCommandRunner", () => {
  it("returns a non-zero exit code when the binary doesn't exist (no uncaught error)", async () => {
    const result = await runner.run("definitely-not-a-real-binary-xyz", ["--whatever"], {
      timeoutMs: 4_000
    });
    expect(result.code).not.toBe(0);
    expect(typeof result.stderr).toBe("string");
  });

  it("does not throw EPIPE when the child closes stdin before we finish writing a large prompt", async () => {
    // `true` exits 0 immediately and never reads stdin. Writing a multi-MB prompt to its
    // already-closed stdin used to surface as an uncaught EPIPE that crashed the main
    // Electron process. The runner should now resolve cleanly with the child's real exit code.
    const bigPrompt = "x".repeat(2_000_000); // ~2 MB
    const result = await runner.run("true", [], {
      input: bigPrompt,
      timeoutMs: 4_000
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("captures stdout when the child reads stdin and echoes it (cat pipeline)", async () => {
    const result = await runner.run("cat", [], {
      input: "hello pipeline\n",
      timeoutMs: 4_000
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("hello pipeline");
  });

  it("respects a tight timeout when the child hangs", async () => {
    const start = Date.now();
    const result = await runner.run("sleep", ["10"], { timeoutMs: 600 });
    const elapsed = Date.now() - start;
    // Should be killed well before 10s. Allow generous slack for jitter.
    expect(elapsed).toBeLessThan(3_000);
    expect(result.code).not.toBe(0);
  });
});

describe("sanitizeEnvForChild", () => {
  it("strips parent Claude Code / Codex env vars so spawned CLIs don't see a nested session", () => {
    const parent: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/Users/me",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SSE_PORT: "12345",
      CODEX_PARENT_SESSION: "abc",
      CODEX_PARENT_PID: "999",
      CODEX_SANDBOX: "read-only",
      ANTHROPIC_AGENT: "yes",
      CUSTOM_KEEPER: "preserved"
    };
    const next = sanitizeEnvForChild(parent);
    expect(next.CLAUDECODE).toBeUndefined();
    expect(next.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(next.CLAUDE_CODE_SSE_PORT).toBeUndefined();
    expect(next.CODEX_PARENT_SESSION).toBeUndefined();
    expect(next.CODEX_PARENT_PID).toBeUndefined();
    expect(next.CODEX_SANDBOX).toBeUndefined();
    expect(next.ANTHROPIC_AGENT).toBeUndefined();
    // Other env vars survive.
    expect(next.HOME).toBe("/Users/me");
    expect(next.CUSTOM_KEEPER).toBe("preserved");
    // PATH is augmented with the standard CLI lookup paths.
    expect(next.PATH).toContain("/opt/homebrew/bin");
    expect(next.PATH).toContain("/usr/bin");
  });
});

import { describe, expect, it } from "vitest";
import {
  looksLikeCreditExhaustion,
  parseReviewerOutput,
  providerCommand,
  refineBrief,
  resolveExecutionMode,
  runAgentLoop
} from "../electron/orchestrator";
import type { CommandRunner, CommandResult } from "../electron/commandRunner";

class MockRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; input?: string }> = [];

  constructor(protected outputs: CommandResult[]) {}

  async run(
    command: string,
    args: string[],
    options?: { cwd?: string; input?: string; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<CommandResult> {
    this.calls.push({ command, args, input: options?.input });
    return this.outputs.shift() ?? { code: 1, stdout: "", stderr: "unexpected call" };
  }

  async launch() {}

  async startLogin() {
    return { output: "", openedInTerminal: false };
  }
}

const request = {
  task: "Add a greeting",
  roles: { worker: "openai", reviewer: "anthropic" },
  maxIterations: 20
} as const;

describe("runAgentLoop", () => {
  it("stops when reviewer approves and preserves proposed diffs", async () => {
    const runner = new MockRunner([
      {
        code: 0,
        stderr: "",
        stdout: "Done\n```diff\ndiff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new\n```"
      },
      {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          decision: "approved_final",
          feedback: "Looks good.",
          finalAnswer: "Ready for the user."
        })
      }
    ]);

    const result = await runAgentLoop(runner, request);

    expect(result.status).toBe("approved");
    expect(result.finalAnswer).toBe("Ready for the user.");
    expect(result.changedFiles).toEqual(["src/a.ts"]);
    expect(result.iterations).toHaveLength(1);
    expect(runner.calls[0].args).not.toContain("--ask-for-approval");
    expect(runner.calls[0].args).toEqual([
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-"
    ]);
    expect(runner.calls[0].input).toContain("Rewrite the user's rough problem statement");
    expect(result.brief?.workerPrompt).toContain("OpenAI Codex");
    expect(result.brief?.reviewerPrompt).toContain("Claude Code");
  });

  it("sends reviewer feedback back to the worker", async () => {
    const runner = new MockRunner([
      { code: 0, stderr: "", stdout: "draft" },
      {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({ decision: "changes_requested", feedback: "Tighten the answer." })
      },
      { code: 0, stderr: "", stdout: "revised" },
      {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({ decision: "approved_final", feedback: "ok", finalAnswer: "final" })
      }
    ]);

    const result = await runAgentLoop(runner, { ...request, maxIterations: 2 });

    expect(result.status).toBe("approved");
    expect(runner.calls[2].input).toContain("Tighten the answer.");
  });

  it("stops for clarification requests", async () => {
    const runner = new MockRunner([
      { code: 0, stderr: "", stdout: "draft" },
      {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          decision: "needs_user_clarification",
          feedback: "Need target framework.",
          clarificationQuestion: "Which framework should I use?"
        })
      }
    ]);

    const result = await runAgentLoop(runner, request);

    expect(result.status).toBe("clarification_needed");
    expect(result.clarificationQuestion).toBe("Which framework should I use?");
  });

  it("forwards reviewer-supplied suggestions onto the run result", async () => {
    const runner = new MockRunner([
      { code: 0, stderr: "", stdout: "draft" },
      {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          decision: "needs_user_clarification",
          feedback: "Need framework.",
          clarificationQuestion: "Which framework should I use?",
          suggestions: ["React", "Vue", "SvelteKit", "  ", "Next.js with TypeScript"]
        })
      }
    ]);

    const result = await runAgentLoop(runner, request);

    expect(result.status).toBe("clarification_needed");
    // Empty / whitespace-only entries dropped, capped at 4.
    expect(result.clarificationSuggestions).toEqual(["React", "Vue", "SvelteKit", "Next.js with TypeScript"]);
  });

  it("soft-approves on the last iteration with caveats appended", async () => {
    const runner = new MockRunner([
      { code: 0, stderr: "", stdout: "draft 1" },
      { code: 0, stderr: "", stdout: JSON.stringify({ decision: "changes_requested", feedback: "needs more" }) },
      { code: 0, stderr: "", stdout: "draft 2" },
      { code: 0, stderr: "", stdout: JSON.stringify({ decision: "changes_requested", feedback: "still rough — but stop here" }) }
    ]);

    const result = await runAgentLoop(runner, { ...request, maxIterations: 2 });

    expect(result.status).toBe("approved");
    expect(result.iterations).toHaveLength(2);
    expect(result.finalAnswer).toContain("draft 2");
    expect(result.finalAnswer).toContain("Reviewer caveats");
    expect(result.finalAnswer).toContain("still rough");
  });

  it("returns a cancelled result when the abort signal fires before the loop starts", async () => {
    const runner = new MockRunner([]);
    const controller = new AbortController();
    controller.abort();
    const result = await runAgentLoop(runner, { ...request, maxIterations: 4 }, controller.signal);
    expect(result.status).toBe("approved");
    expect(result.failureReason).toMatch(/cancelled by user/i);
    expect(result.iterations).toHaveLength(0);
    // No commands should have been spawned.
    expect(runner.calls).toHaveLength(0);
  });

  it("propagates the abort signal to the runner", async () => {
    const seenSignals: Array<AbortSignal | undefined> = [];
    class SignalCapturingRunner extends MockRunner {
      async run(
        command: string,
        args: string[],
        options?: { cwd?: string; input?: string; timeoutMs?: number; signal?: AbortSignal }
      ): Promise<CommandResult> {
        seenSignals.push(options?.signal);
        return super.run(command, args, options);
      }
    }
    const runner = new SignalCapturingRunner([
      { code: 0, stderr: "", stdout: "draft" },
      { code: 0, stderr: "", stdout: JSON.stringify({ decision: "approved_final", feedback: "ok", finalAnswer: "done" }) }
    ]);
    const controller = new AbortController();
    await runAgentLoop(runner, request, controller.signal);
    expect(seenSignals.length).toBeGreaterThan(0);
    expect(seenSignals[0]).toBe(controller.signal);
  });
});

describe("parseReviewerOutput", () => {
  it("blocks malformed reviewer output", () => {
    expect(parseReviewerOutput("not json").decision).toBe("blocked");
  });
});

describe("credit exhaustion handling", () => {
  it("recognises common credit-exhaustion phrases", () => {
    expect(looksLikeCreditExhaustion("Error: insufficient credit balance")).toBe(true);
    expect(looksLikeCreditExhaustion("HTTP 402 payment required")).toBe(true);
    expect(looksLikeCreditExhaustion("You have exceeded your usage quota")).toBe(true);
    expect(looksLikeCreditExhaustion("Out of credits — top up to continue")).toBe(true);
    expect(looksLikeCreditExhaustion("normal output")).toBe(false);
  });

  it("skips reviewer when reviewer credits are exhausted and returns worker output", async () => {
    const runner = new MockRunner([
      { code: 0, stderr: "", stdout: "worker draft answer" },
      { code: 1, stderr: "Error 402: insufficient credit balance", stdout: "" }
    ]);

    const result = await runAgentLoop(runner, request);

    expect(result.status).toBe("approved");
    expect(result.finalAnswer).toBe("worker draft answer");
    expect(result.skippedAgents).toEqual([
      expect.objectContaining({ provider: "anthropic", role: "reviewer" })
    ]);
    expect(result.iterations).toHaveLength(1);
    expect(result.iterations[0].reviewerDecision).toBe("approved_final");
  });

  it("falls back to the other CLI as worker when the worker is exhausted", async () => {
    const runner = new MockRunner([
      // primary worker (openai) — exhausted
      { code: 1, stderr: "Out of credits, please top up", stdout: "" },
      // fallback worker (anthropic / claude)
      { code: 0, stderr: "", stdout: "fallback worker output" },
      // reviewer (anthropic / claude) — but reviewer call still happens; provide approval
      {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          decision: "approved_final",
          feedback: "ok",
          finalAnswer: "shipped via fallback"
        })
      }
    ]);

    const result = await runAgentLoop(runner, request);

    expect(result.status).toBe("approved");
    expect(result.finalAnswer).toBe("shipped via fallback");
    expect(result.skippedAgents).toEqual([
      expect.objectContaining({ provider: "openai", role: "worker" })
    ]);
    expect(runner.calls[0].command).toBe("codex");
    expect(runner.calls[1].command).toBe("claude");
  });

  it("blocks when both providers report exhausted credits", async () => {
    const runner = new MockRunner([
      { code: 1, stderr: "credit balance exhausted", stdout: "" },
      { code: 1, stderr: "rate limit / quota exceeded", stdout: "" }
    ]);

    const result = await runAgentLoop(runner, request);

    expect(result.status).toBe("blocked");
    expect(result.skippedAgents).toHaveLength(2);
    expect(result.failureReason).toMatch(/exhausted credits/i);
  });

  it("treats SIGTERM exit code 143 from a CLI as a timeout, not a generic error", async () => {
    const runner = new MockRunner([
      // worker (claude) gets killed by our timeout — exit code 143 + timedOut flag
      { code: 143, stderr: "", stdout: "", timedOut: true, durationMs: 480_000 },
      // fallback worker (codex) returns a draft
      { code: 0, stderr: "", stdout: "fallback draft" },
      // reviewer approves
      {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({ decision: "approved_final", feedback: "ok", finalAnswer: "shipped" })
      }
    ]);

    const result = await runAgentLoop(runner, {
      ...request,
      roles: { worker: "anthropic", reviewer: "openai" }
    });

    expect(result.status).toBe("approved");
    expect(result.finalAnswer).toBe("shipped");
    expect(result.skippedAgents).toEqual([
      expect.objectContaining({ provider: "anthropic", role: "worker", reason: expect.stringMatching(/within\s+\d+s/i) })
    ]);
  });

  it("skips the reviewer and returns the worker draft when the reviewer times out", async () => {
    const runner = new MockRunner([
      { code: 0, stderr: "", stdout: "worker draft answer" },
      // reviewer (codex) gets killed by SIGTERM
      { code: 143, stderr: "", stdout: "", timedOut: true, durationMs: 480_000 }
    ]);

    const result = await runAgentLoop(runner, request);

    expect(result.status).toBe("approved");
    expect(result.finalAnswer).toBe("worker draft answer");
    expect(result.skippedAgents).toEqual([
      expect.objectContaining({ provider: "anthropic", role: "reviewer", reason: expect.stringMatching(/within\s+\d+s/i) })
    ]);
  });

  it("blocks when both providers time out", async () => {
    const runner = new MockRunner([
      { code: 143, stderr: "", stdout: "", timedOut: true, durationMs: 480_000 },
      { code: 143, stderr: "", stdout: "", timedOut: true, durationMs: 480_000 }
    ]);

    const result = await runAgentLoop(runner, request);

    expect(result.status).toBe("blocked");
    expect(result.skippedAgents).toHaveLength(2);
    expect(result.failureReason).toMatch(/timed out/i);
  });
});

describe("execution mode", () => {
  it("defaults to read-only and uses read-only sandbox flags", () => {
    expect(resolveExecutionMode({ ...request })).toBe("read_only");
    expect(providerCommand("openai", "read_only", true).args).toEqual([
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-"
    ]);
    expect(providerCommand("anthropic", "read_only", true).args).toContain("plan");
    expect(providerCommand("anthropic", "read_only", true).args).not.toContain("--dangerously-skip-permissions");
  });

  it("enables workspace-write flags only when a workspace is set", () => {
    expect(resolveExecutionMode({ ...request, executionMode: "workspace_write" })).toBe("read_only");
    expect(
      resolveExecutionMode({ ...request, executionMode: "workspace_write", workspacePath: "/tmp/x" })
    ).toBe("workspace_write");

    const codexWrite = providerCommand("openai", "workspace_write", true).args;
    expect(codexWrite).toContain("workspace-write");
    // `codex exec` is non-interactive by design; --ask-for-approval is not a valid flag for it.
    expect(codexWrite).not.toContain("--ask-for-approval");

    const claudeWrite = providerCommand("anthropic", "workspace_write", true).args;
    expect(claudeWrite).toContain("acceptEdits");
    expect(claudeWrite).toContain("--dangerously-skip-permissions");
    expect(claudeWrite).not.toContain("plan");
    expect(claudeWrite).not.toContain("--tools");
  });

  it("forwards workspace-write flags through runAgentLoop when workspace is provided", async () => {
    const runner = new MockRunner([
      { code: 0, stderr: "", stdout: "wrote files\nsrc/a.ts updated" },
      {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          decision: "approved_final",
          feedback: "ok",
          finalAnswer: "applied"
        })
      }
    ]);

    const result = await runAgentLoop(runner, {
      ...request,
      workspacePath: "/tmp/example",
      executionMode: "workspace_write"
    });

    expect(result.status).toBe("approved");
    expect(runner.calls[0].command).toBe("codex");
    expect(runner.calls[0].args).toContain("workspace-write");
    expect(runner.calls[1].command).toBe("claude");
    expect(runner.calls[1].args).toContain("--dangerously-skip-permissions");
  });

  it("falls back to read-only when workspace_write is requested without a workspace", async () => {
    const runner = new MockRunner([
      { code: 0, stderr: "", stdout: "draft" },
      {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          decision: "approved_final",
          feedback: "ok",
          finalAnswer: "done"
        })
      }
    ]);

    await runAgentLoop(runner, { ...request, executionMode: "workspace_write" });

    expect(runner.calls[0].args).toContain("read-only");
    expect(runner.calls[0].args).not.toContain("workspace-write");
  });

  it("injects the right execution guidance into worker and reviewer prompts", () => {
    const readOnly = refineBrief({ ...request, workspacePath: "/tmp/x" });
    expect(readOnly.workerPrompt).toContain("EXECUTION MODE: READ-ONLY");
    expect(readOnly.workerPrompt).toContain("propose a unified git diff");

    const writeMode = refineBrief({
      ...request,
      workspacePath: "/tmp/x",
      executionMode: "workspace_write"
    });
    expect(writeMode.workerPrompt).toContain("EXECUTION MODE: WORKSPACE WRITE");
    expect(writeMode.workerPrompt).toContain("create or edit files directly");
    expect(writeMode.reviewerPrompt).toContain("EXECUTION MODE: WORKSPACE WRITE");
  });
});

describe("refineBrief", () => {
  it("creates role-specific worker and reviewer prompts", () => {
    const brief = refineBrief(request);

    expect(brief.summary).toContain("Add a greeting");
    expect(brief.workerPrompt).toContain("OpenAI Codex");
    expect(brief.workerPrompt).toContain("Do not apply changes directly");
    expect(brief.reviewerPrompt).toContain("Claude Code");
    expect(brief.reviewerPrompt).toContain("Return only JSON");
  });

  it("instructs the reviewer to verify the worker's output AND identify additions/improvements", () => {
    const brief = refineBrief(request);

    // Part A — verify everything the worker produced.
    expect(brief.reviewerPrompt).toContain("VERIFY EVERYTHING THE WORKER PRODUCED");
    expect(brief.reviewerPrompt).toMatch(/Factual claims/i);
    expect(brief.reviewerPrompt).toMatch(/Code \(if any\): read every line/i);
    expect(brief.reviewerPrompt).toMatch(/Logic:/i);
    expect(brief.reviewerPrompt).toMatch(/Coverage:/i);
    expect(brief.reviewerPrompt).toMatch(/Safety:/i);

    // Part B — identify what is missing or could be improved.
    expect(brief.reviewerPrompt).toContain("IDENTIFY WHAT'S MISSING OR WOULD MAKE THE ANSWER MATERIALLY BETTER");
    expect(brief.reviewerPrompt).toMatch(/Important angles the worker overlooked/i);
    expect(brief.reviewerPrompt).toMatch(/Things to ADD or CHANGE/i);

    // Anti-loop guardrails are still in place.
    expect(brief.reviewerPrompt).toContain("ANTI-LOOP GUARDRAILS");
    expect(brief.reviewerPrompt).toMatch(/iteration ≥ 4/);

    // Concrete feedback format.
    expect(brief.reviewerPrompt).toMatch(/numbered task list/i);
  });

  it("injects selected skills into only the targeted agent prompts", () => {
    const brief = refineBrief({
      ...request,
      skills: [
        {
          id: "1",
          name: "Market Research",
          instructions: "Use current market evidence.",
          target: "worker",
          enabled: true
        },
        {
          id: "2",
          name: "Security Review",
          instructions: "Check for unsafe assumptions.",
          target: "reviewer",
          enabled: true
        }
      ]
    });

    expect(brief.workerPrompt).toContain("Market Research");
    expect(brief.workerPrompt).not.toContain("Security Review");
    expect(brief.reviewerPrompt).toContain("Security Review");
    expect(brief.reviewerPrompt).not.toContain("Market Research");
  });
});

import { describe, expect, it, vi } from "vitest";
import { applyLogToTracker, finalizeTracker, newTracker } from "../src/App";
import type { AgentLogEvent } from "../shared/types";

function makeLog(source: string, message: string, atIso: string): AgentLogEvent {
  return { source, message, timestamp: atIso };
}

describe("RunTracker log parsing", () => {
  it("opens an iteration and tags worker phase + provider when an orchestrator phase line arrives", () => {
    let now = 1_000_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    let tracker = newTracker(now);
    tracker = applyLogToTracker(
      tracker,
      makeLog("orchestrator", "Iteration 1 / 5 — worker turn (Claude Code).", new Date(now).toISOString())
    );

    expect(tracker.currentIteration).toBe(1);
    expect(tracker.currentPhase).toBe("worker");
    expect(tracker.currentProvider).toBe("anthropic");
    expect(tracker.iterations).toHaveLength(1);
    expect(tracker.iterations[0].workerProvider).toBe("anthropic");

    vi.useRealTimers();
  });

  it("accumulates per-phase and per-iteration durations as phases transition", () => {
    vi.useFakeTimers();
    const t0 = 1_700_000_000_000;
    vi.setSystemTime(t0);

    let tracker = newTracker(t0);

    // Iteration 1 — worker (Claude) for 30s
    vi.setSystemTime(t0 + 0);
    tracker = applyLogToTracker(
      tracker,
      makeLog("orchestrator", "Iteration 1 / 5 — worker turn (Claude Code).", new Date(t0).toISOString())
    );

    // -> reviewer (Codex) for 10s
    vi.setSystemTime(t0 + 30_000);
    tracker = applyLogToTracker(
      tracker,
      makeLog("orchestrator", "Iteration 1 / 5 — reviewer turn (OpenAI Codex).", new Date(t0 + 30_000).toISOString())
    );

    // Iteration 2 — worker for 20s
    vi.setSystemTime(t0 + 40_000);
    tracker = applyLogToTracker(
      tracker,
      makeLog("orchestrator", "Iteration 2 / 5 — worker turn (Claude Code).", new Date(t0 + 40_000).toISOString())
    );

    // -> reviewer for 5s
    vi.setSystemTime(t0 + 60_000);
    tracker = applyLogToTracker(
      tracker,
      makeLog("orchestrator", "Iteration 2 / 5 — reviewer turn (OpenAI Codex).", new Date(t0 + 60_000).toISOString())
    );

    // Finalize at +65s
    vi.setSystemTime(t0 + 65_000);
    tracker = finalizeTracker(tracker);

    expect(tracker.iterations).toHaveLength(2);
    expect(tracker.iterations[0]).toMatchObject({
      iteration: 1,
      workerMs: 30_000,
      reviewerMs: 10_000,
      workerProvider: "anthropic",
      reviewerProvider: "openai"
    });
    expect(tracker.iterations[1]).toMatchObject({
      iteration: 2,
      workerMs: 20_000,
      reviewerMs: 5_000,
      workerProvider: "anthropic",
      reviewerProvider: "openai"
    });
    expect(tracker.workerTotalMs).toBe(50_000);
    expect(tracker.reviewerTotalMs).toBe(15_000);
    expect(tracker.currentPhase).toBeUndefined();

    vi.useRealTimers();
  });

  it("captures the latest detail line so the UI can show 'what is it doing now'", () => {
    let tracker = newTracker(0);
    tracker = applyLogToTracker(tracker, makeLog("orchestrator", "Iteration 1 / 5 — worker turn (Claude Code).", "2026-05-09T00:00:00Z"));
    tracker = applyLogToTracker(tracker, makeLog("claude", "Analyzing the user's question…", "2026-05-09T00:00:01Z"));
    tracker = applyLogToTracker(tracker, makeLog("command", "claude -p ...", "2026-05-09T00:00:02Z"));
    expect(tracker.lastDetail).toBe("Analyzing the user's question…");
  });

  it("ignores non-phase orchestrator chatter for phase tracking but still updates lastDetail", () => {
    let tracker = newTracker(0);
    tracker = applyLogToTracker(tracker, makeLog("orchestrator", "Run cancelled by user after 2 iteration(s).", "2026-05-09T00:00:00Z"));
    expect(tracker.currentPhase).toBeUndefined();
    expect(tracker.currentIteration).toBeUndefined();
    expect(tracker.lastDetail).toMatch(/cancelled by user/);
  });
});

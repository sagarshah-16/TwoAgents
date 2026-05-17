import { z } from "zod";
import { changedFilesFromDiff, extractUnifiedDiff } from "../shared/diff.js";
import type {
  AgentDecision,
  AgentSkill,
  AgentRunRequest,
  AgentRunResult,
  ExecutionMode,
  IterationRecord,
  ProviderId,
  RefinedBrief,
  SkippedAgent
} from "../shared/types.js";
import type { CommandRunner } from "./commandRunner.js";
import { emitAgentLog } from "./logBus.js";

const reviewerSchema = z.object({
  decision: z.enum(["approved_final", "changes_requested", "needs_user_clarification", "blocked"]),
  feedback: z.string(),
  finalAnswer: z.string().optional(),
  clarificationQuestion: z.string().optional(),
  // Optional 2–4 short candidate answers the user can pick from when the decision is
  // needs_user_clarification. The renderer turns these into clickable chips.
  suggestions: z.array(z.string()).optional()
});

const providerLabels: Record<ProviderId, string> = {
  openai: "OpenAI Codex",
  anthropic: "Claude Code"
};

type ProviderRunOutcome =
  | { kind: "ok"; output: string }
  | { kind: "credits_exhausted"; reason: string }
  | { kind: "timeout"; reason: string; durationMs?: number }
  | { kind: "aborted" }
  | { kind: "error"; reason: string };

/**
 * How long a single worker / reviewer CLI call may run before we kill it.
 * Bumped from 5 → 8 minutes because Claude in plan mode + long conversation
 * context legitimately needs more than 5 minutes for some prompts.
 */
const PROVIDER_CALL_TIMEOUT_MS = 480_000;

type ReviewerDecisionPayload = {
  decision: AgentDecision;
  feedback: string;
  finalAnswer?: string;
  clarificationQuestion?: string;
  suggestions?: string[];
};

export async function runAgentLoop(
  runner: CommandRunner,
  request: AgentRunRequest,
  signal?: AbortSignal
): Promise<AgentRunResult> {
  const maxIterations = Math.max(1, Math.min(request.maxIterations || 20, 20));
  const executionMode = resolveExecutionMode(request);
  const brief = refineBrief(request);
  const iterations: IterationRecord[] = [];
  const skippedAgents: SkippedAgent[] = [];
  const exhausted = new Set<ProviderId>();

  let workerProvider: ProviderId = request.roles.worker;
  const reviewerProvider: ProviderId = request.roles.reviewer;
  let reviewerSkipped = false;
  let reviewerFeedback = "";
  let latestDiff: string | undefined;
  let lastWorkerOutput = "";

  emitAgentLog(
    "brief",
    `Refined prompts. Execution mode: ${executionMode === "workspace_write" ? "workspace write (agents may create/edit files and run commands)" : "read-only (agents propose diffs only)"}.`
  );

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    if (signal?.aborted) {
      return cancelledResult(brief, iterations, skippedAgents, lastWorkerOutput, latestDiff);
    }
    emitAgentLog("orchestrator", `Iteration ${iteration} / ${maxIterations} — worker turn (${providerLabels[workerProvider]}).`);
    // ---- WORKER ----
    const workerPrompt = buildWorkerPrompt(brief, reviewerFeedback, iteration);
    let workerOutcome = await runProviderPrompt(
      runner,
      workerProvider,
      workerPrompt,
      request.workspacePath,
      executionMode,
      signal
    );

    if (workerOutcome.kind === "credits_exhausted" || workerOutcome.kind === "timeout") {
      const reasonLabel = workerOutcome.kind === "timeout" ? "timed out" : "credits exhausted";
      noteSkip(skippedAgents, exhausted, workerProvider, "worker", workerOutcome.reason);
      const fallback: ProviderId = workerProvider === "openai" ? "anthropic" : "openai";
      if (exhausted.has(fallback)) {
        return blockedDueToExhaustion(brief, iterations, skippedAgents);
      }
      emitAgentLog(
        "orchestrator",
        `${providerLabels[workerProvider]} ${reasonLabel} — falling back to ${providerLabels[fallback]} as worker.`
      );
      workerProvider = fallback;
      workerOutcome = await runProviderPrompt(
        runner,
        workerProvider,
        workerPrompt,
        request.workspacePath,
        executionMode,
        signal
      );
      if (workerOutcome.kind === "credits_exhausted" || workerOutcome.kind === "timeout") {
        noteSkip(skippedAgents, exhausted, workerProvider, "worker", workerOutcome.reason);
        return blockedDueToExhaustion(brief, iterations, skippedAgents);
      }
    }

    if (workerOutcome.kind === "aborted" || signal?.aborted) {
      return cancelledResult(brief, iterations, skippedAgents, lastWorkerOutput, latestDiff);
    }

    if (workerOutcome.kind === "error") {
      throw new Error(`${providerLabels[workerProvider]} failed: ${workerOutcome.reason}`);
    }

    const workerOutput = workerOutcome.output;
    lastWorkerOutput = workerOutput;
    latestDiff = extractUnifiedDiff(workerOutput) ?? latestDiff;

    // ---- REVIEWER ----
    let review: ReviewerDecisionPayload;
    if (reviewerSkipped || exhausted.has(reviewerProvider)) {
      review = {
        decision: "approved_final",
        feedback: `Reviewer skipped because ${providerLabels[reviewerProvider]} credits/quota are exhausted. Returning the worker output as the final answer.`,
        finalAnswer: workerOutput
      };
    } else {
      emitAgentLog("orchestrator", `Iteration ${iteration} / ${maxIterations} — reviewer turn (${providerLabels[reviewerProvider]}).`);
      const reviewerPromptText = buildReviewerPrompt(brief, workerOutput, iteration);
      const reviewerOutcome = await runProviderPrompt(
        runner,
        reviewerProvider,
        reviewerPromptText,
        request.workspacePath,
        executionMode,
        signal
      );

      if (reviewerOutcome.kind === "aborted" || signal?.aborted) {
        return cancelledResult(brief, iterations, skippedAgents, lastWorkerOutput, latestDiff);
      }

      if (reviewerOutcome.kind === "credits_exhausted" || reviewerOutcome.kind === "timeout") {
        const isTimeout = reviewerOutcome.kind === "timeout";
        noteSkip(skippedAgents, exhausted, reviewerProvider, "reviewer", reviewerOutcome.reason);
        reviewerSkipped = true;
        emitAgentLog(
          "orchestrator",
          `${providerLabels[reviewerProvider]} ${isTimeout ? "timed out" : "credits exhausted"} — skipping review and accepting worker output as final.`
        );
        review = {
          decision: "approved_final",
          feedback: isTimeout
            ? `Reviewer skipped: ${providerLabels[reviewerProvider]} did not finish in time. Continuing with worker output.`
            : `Reviewer skipped: ${providerLabels[reviewerProvider]} credits/quota exhausted. Continuing with worker output.`,
          finalAnswer: workerOutput
        };
      } else if (reviewerOutcome.kind === "error") {
        review = {
          decision: "blocked",
          feedback: reviewerOutcome.reason
        };
      } else {
        review = parseReviewerOutput(reviewerOutcome.output);
      }
    }

    const proposedDiff = extractUnifiedDiff(workerOutput) ?? extractUnifiedDiff(review.feedback) ?? latestDiff;
    const changedFiles = changedFilesFromDiff(proposedDiff);

    // On the very last iteration, soft-promote `changes_requested` to `approved_final` so the
    // user always gets a final answer (with reviewer notes appended as caveats) rather than a
    // bare "max_iterations" failure. The user explicitly asked for this behavior.
    if (review.decision === "changes_requested" && iteration === maxIterations) {
      review = {
        decision: "approved_final",
        feedback: review.feedback,
        finalAnswer:
          (review.finalAnswer || workerOutput) +
          `\n\n---\n**Reviewer caveats** (the loop hit ${maxIterations} iterations):\n${review.feedback}`
      };
    }

    iterations.push({
      iteration,
      workerProvider,
      reviewerProvider,
      workerOutput,
      reviewerDecision: review.decision,
      reviewerFeedback: review.feedback,
      proposedDiff,
      changedFiles
    });

    if (review.decision === "approved_final") {
      return {
        status: "approved",
        finalAnswer: review.finalAnswer || workerOutput || review.feedback,
        brief,
        iterations,
        proposedDiff,
        changedFiles,
        skippedAgents: skippedAgents.length ? skippedAgents : undefined
      };
    }

    if (review.decision === "needs_user_clarification") {
      return {
        status: "clarification_needed",
        clarificationQuestion: review.clarificationQuestion || review.feedback,
        clarificationSuggestions: review.suggestions?.filter((s) => s.trim().length).slice(0, 4),
        brief,
        iterations,
        proposedDiff,
        changedFiles,
        skippedAgents: skippedAgents.length ? skippedAgents : undefined
      };
    }

    if (review.decision === "blocked") {
      return {
        status: "blocked",
        failureReason: review.feedback,
        brief,
        iterations,
        proposedDiff,
        changedFiles,
        skippedAgents: skippedAgents.length ? skippedAgents : undefined
      };
    }

    reviewerFeedback = review.feedback;
  }

  const last = iterations.at(-1);
  return {
    status: "max_iterations",
    failureReason: "The agents reached the maximum iteration limit before reviewer approval.",
    brief,
    iterations,
    proposedDiff: last?.proposedDiff,
    changedFiles: last?.changedFiles ?? [],
    skippedAgents: skippedAgents.length ? skippedAgents : undefined
  };
}

function noteSkip(
  skipped: SkippedAgent[],
  exhausted: Set<ProviderId>,
  provider: ProviderId,
  role: "worker" | "reviewer",
  reason: string
) {
  if (!skipped.some((entry) => entry.provider === provider && entry.role === role)) {
    skipped.push({ provider, role, reason: shortReason(reason) });
  }
  exhausted.add(provider);
}

function shortReason(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "Credits/quota exhausted.";
  }
  if (trimmed.length <= 220) {
    return trimmed;
  }
  return `${trimmed.slice(0, 217)}...`;
}

function blockedDueToExhaustion(
  brief: RefinedBrief,
  iterations: IterationRecord[],
  skippedAgents: SkippedAgent[]
): AgentRunResult {
  const anyTimeout = skippedAgents.some((s) =>
    /timed?\s*out|timeout|did\s+not\s+finish|exited\s+with\s+code\s+(143|137)/i.test(s.reason)
  );
  const reason = anyTimeout
    ? "Both agents either timed out or ran out of credits. Try again, switch the worker/reviewer roles in Settings, or wait and retry."
    : "Both providers report exhausted credits/quotas. Add credit to either provider and retry.";
  return {
    status: "blocked",
    failureReason: reason,
    brief,
    iterations,
    changedFiles: [],
    skippedAgents
  };
}

function cancelledResult(
  brief: RefinedBrief,
  iterations: IterationRecord[],
  skippedAgents: SkippedAgent[],
  lastWorkerOutput: string,
  latestDiff?: string
): AgentRunResult {
  emitAgentLog(
    "orchestrator",
    `Run cancelled by user after ${iterations.length} iteration(s). Returning the latest worker draft as the final answer.`
  );
  return {
    status: "approved",
    finalAnswer: lastWorkerOutput || "The run was cancelled before the worker produced any output.",
    failureReason: "Cancelled by user — showing the latest worker draft. The reviewer did not approve.",
    brief,
    iterations,
    proposedDiff: latestDiff,
    changedFiles: changedFilesFromDiff(latestDiff),
    skippedAgents: skippedAgents.length ? skippedAgents : undefined
  };
}

function buildWorkerPrompt(brief: RefinedBrief, reviewerFeedback: string, iteration: number) {
  return [
    brief.workerPrompt,
    reviewerFeedback ? `Reviewer feedback to address:\n${reviewerFeedback}` : "",
    `Iteration: ${iteration}`
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildReviewerPrompt(brief: RefinedBrief, workerOutput: string, iteration: number) {
  return [
    brief.reviewerPrompt,
    `Iteration: ${iteration}`,
    `Worker output:\n${workerOutput}`
  ].join("\n\n");
}

export function refineBrief(request: AgentRunRequest): RefinedBrief {
  const task = request.task.trim();
  const executionMode = resolveExecutionMode(request);
  const writeAllowed = executionMode === "workspace_write" && Boolean(request.workspacePath);
  const conversationContext = formatConversationContext(request.conversationMessages);
  const workspaceMode = request.workspacePath
    ? `Workspace context is available at: ${request.workspacePath}`
    : "No workspace folder is selected; produce chat artifacts only unless the task is self-contained.";
  const executionGuidance = writeAllowed
    ? [
        "EXECUTION MODE: WORKSPACE WRITE.",
        "You are running with workspace-write permissions inside the workspace path above.",
        "When the task calls for code, you SHOULD create or edit files directly and run commands as needed (build, test, lint).",
        "After making changes, summarize what you changed (paths and rationale) and any commands you ran with their key results.",
        "Do not touch files outside the workspace. Do not run network installs or destructive commands without an explicit need."
      ].join(" ")
    : [
        "EXECUTION MODE: READ-ONLY.",
        "You may read the workspace but you MUST NOT write files or run commands.",
        "If code or file changes are needed, propose a unified git diff in a fenced ```diff block. The user will apply it manually."
      ].join(" ");
  const workerName = providerLabels[request.roles.worker];
  const reviewerName = providerLabels[request.roles.reviewer];
  const workerSkills = formatSkillsForPrompt(request.skills, "worker");
  const reviewerSkills = formatSkillsForPrompt(request.skills, "reviewer");

  const summary = [
    "Refined brief:",
    task,
    conversationContext ? `\nRelevant conversation context:\n${conversationContext}` : "",
    "",
    "Expected workflow:",
    "1. Understand the user's goal and make the smallest useful plan.",
    writeAllowed
      ? "2. Implement the requested change directly in the workspace (create/edit files, run commands)."
      : "2. Produce the requested result or a proposed unified diff (no workspace mutations).",
    "3. Let the reviewer verify correctness, completeness, risk, and whether user clarification is needed.",
    "4. Iterate until reviewer approval, clarification, blocking failure, or the iteration limit."
  ].join("\n");

  const workerPrompt = [
    `You are ${workerName}, the worker agent in a two-agent desktop workflow.`,
    "Rewrite the user's rough problem statement into concrete work and complete that work.",
    "Prioritize the user's intent over spelling or wording mistakes.",
    workspaceMode,
    executionGuidance,
    workerSkills ? `Apply these selected skills:\n${workerSkills}` : "",
    writeAllowed
      ? "When you produce code changes by writing files directly, also include a short summary listing the files you created or modified."
      : "If code or file changes are needed, propose a unified git diff in a fenced ```diff block. Do not apply changes directly.",
    "If the task is ambiguous but you can make a safe assumption, state the assumption and proceed.",
    "If you cannot proceed without a decision, ask the reviewer for the smallest necessary clarification.",
    "",
    "User task:",
    task,
    conversationContext ? `\nConversation so far:\n${conversationContext}` : ""
  ].join("\n");

  const reviewerPrompt = [
    `You are ${reviewerName}, the reviewer agent in a two-agent desktop workflow.`,
    "Treat the worker's output as a draft you are responsible for. If it ships unchanged to the user, your name is on it. Do a substantive second pass — not a surface-level sanity check, and not a perfectionist nitpick.",
    executionGuidance,
    writeAllowed
      ? "If gaps are small and concrete, you MAY apply minor follow-up edits and re-run quick verifications yourself before approving. Otherwise return changes_requested with explicit instructions for the worker."
      : "Do not modify files; only judge the worker's proposed changes.",
    "",
    "PART A — VERIFY EVERYTHING THE WORKER PRODUCED.",
    "Don't compare against the user's intent only — read the worker's actual output line by line and pressure-test it.",
    "1. Factual claims: numbers, prices, dates, version requirements, API behaviors, fees, limits, eligibility. For each notable claim, ask 'do I have reason to believe this is true and current?'. Call out specific claims that look wrong, outdated, or unsupported.",
    "2. Code (if any): read every line. Will it compile / run? Are imports correct, types consistent, edge cases handled (empty input, null, async ordering, off-by-one)? Does the proposed unified diff apply cleanly against the workspace? Does it touch files it shouldn't?",
    "3. Logic: does the reasoning hold end-to-end? Find leaps, contradictions, conclusions that don't follow from the premises.",
    "4. Coverage: does the answer actually address what the user asked, or just adjacent topics? Did the worker pick the right framing of the problem?",
    "5. Safety: data loss, destructive commands, credentials in plaintext, reliance on assumptions about the user's environment that may not hold.",
    "",
    "PART B — IDENTIFY WHAT'S MISSING OR WOULD MAKE THE ANSWER MATERIALLY BETTER.",
    "Beyond verification, you are responsible for what the worker DIDN'T do.",
    "1. Important angles the worker overlooked: relevant trade-offs, alternative approaches the user should weigh, gotchas they will hit.",
    "2. Concrete additions the user clearly needs next: missing tests, missing error handling, missing setup steps, missing docs, missing cost / latency / risk callouts.",
    "3. Things to ADD or CHANGE — name them concretely so the worker can act, e.g. 'Add an empty-array guard in parse() at line 14' or 'Cite Polymarket's official fee schedule URL', not 'be more thorough'.",
    "4. If the answer is mostly fine but a few additions would clearly improve it, list them as Should-add / Nice-to-have rather than blocking on them.",
    "",
    "DECISION CALIBRATION (this is the contract, do not deviate):",
    "- changes_requested  — there is at least one MUST-FIX issue uncovered in Part A, OR a load-bearing addition from Part B that the worker can clearly add in one more pass. Send this back as a numbered, actionable task list in `feedback`. Be specific enough that the worker can do exactly what you're asking without guessing.",
    "- approved_final     — Part A turned up no factual or correctness errors and the Part B additions are non-blocking polish. Populate `finalAnswer` with a polished version of the worker's output (you may copy and lightly edit it), and append a short '**What I'd add next**' or '**Caveats**' section if Part B surfaced anything worth telling the user.",
    "- needs_user_clarification — the user's intent is genuinely ambiguous in a way you cannot safely default. Provide 2–4 short candidate answers in `suggestions`. Do NOT use this for information YOU wish the worker had cited — only for information that must come from the USER.",
    "- blocked — unrecoverable tool or safety failure that no further iteration could fix.",
    "",
    "ANTI-LOOP GUARDRAILS:",
    "- Do not request changes for stylistic polish, optional citations, alternative phrasings, or 'could be more thorough' alone. Those go in the approved_final caveats.",
    "- If your concerns from a previous iteration have been addressed and only new minor nits remain, approve.",
    "- If a non-critical concern persists into iteration ≥ 4, fold it into approved_final's caveats and stop blocking.",
    "- Never re-request the same change twice in a row without acknowledging the worker's attempt.",
    "",
    "FEEDBACK FORMAT:",
    "When you return changes_requested, write `feedback` as a numbered task list. Each item: what to do, where, and why it matters. The worker reads your feedback verbatim and acts on it, so be precise.",
    "When you return approved_final, `finalAnswer` is what the user will see — make it clean and self-contained.",
    reviewerSkills ? `Apply these selected review skills as well:\n${reviewerSkills}` : "",
    "",
    "Return only JSON with this exact shape (no Markdown, no commentary outside the JSON):",
    '{"decision":"approved_final|changes_requested|needs_user_clarification|blocked","feedback":"...","finalAnswer":"optional","clarificationQuestion":"optional","suggestions":["optional","short","picks"]}',
    "",
    "Original user task:",
    task,
    conversationContext ? `\nConversation so far:\n${conversationContext}` : "",
    "",
    "Refined task summary:",
    summary
  ].join("\n");

  return {
    originalTask: task,
    summary,
    workerPrompt,
    reviewerPrompt
  };
}

export function resolveExecutionMode(request: AgentRunRequest): ExecutionMode {
  if (request.executionMode === "workspace_write" && request.workspacePath) {
    return "workspace_write";
  }
  return "read_only";
}

function formatSkillsForPrompt(skills: AgentSkill[] | undefined, target: "worker" | "reviewer") {
  const selected = (skills ?? []).filter((skill) =>
    skill.enabled && skill.name.trim() && skill.instructions.trim() && (skill.target === target || skill.target === "both")
  );
  if (selected.length === 0) {
    return "";
  }
  return selected
    .map((skill, index) => `${index + 1}. ${skill.name.trim()}: ${skill.instructions.trim()}`)
    .join("\n");
}

function formatConversationContext(messages: AgentRunRequest["conversationMessages"]) {
  const priorMessages = (messages ?? []).slice(-8);
  if (priorMessages.length === 0) {
    return "";
  }
  return priorMessages
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n\n");
}

export function parseReviewerOutput(raw: string): ReviewerDecisionPayload {
  const json = extractJson(raw);
  const parsed = reviewerSchema.safeParse(json ? safeJsonParse(json) : undefined);
  if (parsed.success) {
    return parsed.data;
  }

  return {
    decision: "blocked" as const,
    feedback: `Reviewer returned an invalid decision payload.\n\n${raw}`
  };
}

function safeJsonParse(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function runProviderPrompt(
  runner: CommandRunner,
  provider: ProviderId,
  prompt: string,
  workspacePath: string | undefined,
  executionMode: ExecutionMode,
  signal?: AbortSignal
): Promise<ProviderRunOutcome> {
  if (signal?.aborted) {
    return { kind: "aborted" };
  }
  const { command, args } = providerCommand(provider, executionMode, Boolean(workspacePath));
  const result = await runner.run(command, args, {
    cwd: workspacePath,
    input: prompt,
    timeoutMs: PROVIDER_CALL_TIMEOUT_MS,
    signal
  });

  if (signal?.aborted || result.code === 130) {
    return { kind: "aborted" };
  }

  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  const combined = `${stdout}\n${stderr}`;
  const looksTimedOut =
    Boolean(result.timedOut) ||
    result.code === 143 || // SIGTERM
    result.code === 137 || // SIGKILL
    /timed?\s*out|timeout/i.test(combined);

  if (result.code !== 0) {
    if (looksTimedOut) {
      const seconds = result.durationMs != null ? Math.round(result.durationMs / 1000) : Math.round(PROVIDER_CALL_TIMEOUT_MS / 1000);
      return {
        kind: "timeout",
        reason: `${providerLabels[provider]} did not finish within ${seconds}s and was terminated.`,
        durationMs: result.durationMs
      };
    }
    if (looksLikeCreditExhaustion(combined)) {
      return { kind: "credits_exhausted", reason: stderr || stdout || "Credits/quota exhausted." };
    }
    return {
      kind: "error",
      reason: stderr || stdout || `${providerLabels[provider]} exited with code ${result.code ?? "unknown"}.`
    };
  }

  if (!stdout && looksLikeCreditExhaustion(stderr)) {
    return { kind: "credits_exhausted", reason: stderr };
  }

  // Some CLIs return non-fatal warnings on stderr; only flag exhaustion when there is no useful stdout.
  if (!stdout) {
    return { kind: "error", reason: stderr || `${providerLabels[provider]} returned no output.` };
  }

  return { kind: "ok", output: stdout };
}

export function providerCommand(
  provider: ProviderId,
  executionMode: ExecutionMode,
  hasWorkspace: boolean
): { command: string; args: string[] } {
  const writeAllowed = executionMode === "workspace_write" && hasWorkspace;
  if (provider === "openai") {
    // `codex exec` is non-interactive by design — there is no `--ask-for-approval` flag.
    // We just pick the sandbox policy and let exec run without prompting.
    return {
      command: "codex",
      args: writeAllowed
        ? ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "-"]
        : ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "-"]
    };
  }
  return {
    command: "claude",
    args: writeAllowed
      ? [
          "-p",
          "--permission-mode",
          "acceptEdits",
          "--dangerously-skip-permissions",
          "--output-format",
          "text",
          "--disable-slash-commands"
        ]
      : [
          "-p",
          "--permission-mode",
          "plan",
          "--output-format",
          "text",
          "--disable-slash-commands",
          "--tools",
          ""
        ]
  };
}

const CREDIT_EXHAUSTION_PATTERNS = [
  /\bcredit(s)?\s+(balance|exhaust|exceed|empt|out)/i,
  /\binsufficient\s+(credit|quota|balance|funds)/i,
  /\bquota\s+(exceed|exhaust|reached)/i,
  /\busage\s+limit\b/i,
  /\brate\s+limit\b/i,
  /\bout\s+of\s+(credit|tokens|quota)/i,
  /\b(credit|quota)\s+(exceed|exhaust)/i,
  /\bbilling\b.*\b(required|exceeded|hard.?cap)/i,
  /\bpayment\s+required\b/i,
  /\b402\b/,
  /\b429\b.*\b(quota|usage|credit)/i,
  /\bplan\s+(limit|quota)\s+(reached|exceeded)/i,
  /\bnot\s+enough\s+(credit|tokens|quota)/i,
  /\bexceeded\s+your\s+(plan|usage|quota)/i,
  /\bsubscription\s+(expired|inactive)/i
];

export function looksLikeCreditExhaustion(text: string): boolean {
  if (!text) {
    return false;
  }
  return CREDIT_EXHAUSTION_PATTERNS.some((pattern) => pattern.test(text));
}

function extractJson(raw: string): string | undefined {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }
  return candidate.slice(start, end + 1);
}

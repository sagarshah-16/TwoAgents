import type { ApplyPatchResult } from "../shared/types.js";
import type { CommandRunner } from "./commandRunner.js";

export async function applyUnifiedPatch(
  runner: CommandRunner,
  workspacePath: string,
  patch: string
): Promise<ApplyPatchResult> {
  if (!workspacePath) {
    return { ok: false, message: "Choose a workspace before applying a patch." };
  }
  if (!patch.includes("diff --git")) {
    return { ok: false, message: "No valid unified git diff was found." };
  }

  const check = await runner.run("git", ["apply", "--check", "-"], {
    cwd: workspacePath,
    input: patch,
    timeoutMs: 30_000
  });
  if (check.code !== 0) {
    return { ok: false, message: check.stderr || check.stdout || "Patch validation failed." };
  }

  const apply = await runner.run("git", ["apply", "-"], {
    cwd: workspacePath,
    input: patch,
    timeoutMs: 30_000
  });
  if (apply.code !== 0) {
    return { ok: false, message: apply.stderr || apply.stdout || "Patch apply failed." };
  }

  return { ok: true, message: "Patch applied successfully." };
}

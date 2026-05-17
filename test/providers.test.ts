import { describe, expect, it } from "vitest";
import { getProviderStatuses } from "../electron/providers";
import type { CommandRunner, CommandResult } from "../electron/commandRunner";

class StatusRunner implements CommandRunner {
  async run(command: string, args: string[]): Promise<CommandResult> {
    const joined = [command, ...args].join(" ");
    if (joined === "codex --version") return { code: 0, stdout: "codex 1.0.0", stderr: "" };
    if (joined === "codex login status") return { code: 0, stdout: "Logged in using ChatGPT", stderr: "" };
    if (joined === "claude --version") return { code: 0, stdout: "1.0.0", stderr: "" };
    if (joined === "claude auth status") {
      return { code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}', stderr: "" };
    }
    return { code: 127, stdout: "", stderr: "missing" };
  }

  async launch() {}

  async startLogin() {
    return { output: "", openedInTerminal: false };
  }
}

describe("getProviderStatuses", () => {
  it("detects logged-in OpenAI and Anthropic CLI sessions", async () => {
    const statuses = await getProviderStatuses(new StatusRunner());

    expect(statuses).toHaveLength(2);
    expect(statuses.every((status) => status.installed)).toBe(true);
    expect(statuses.every((status) => status.loggedIn)).toBe(true);
  });
});

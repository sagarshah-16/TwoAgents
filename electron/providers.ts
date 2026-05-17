import type { ProviderId, ProviderStatus } from "../shared/types.js";
import type { CommandRunner } from "./commandRunner.js";

export const providerLabels: Record<ProviderId, string> = {
  openai: "OpenAI Codex",
  anthropic: "Claude Code"
};

export async function getProviderStatuses(runner: CommandRunner): Promise<ProviderStatus[]> {
  const [openai, anthropic] = await Promise.all([
    getOpenAiStatus(runner),
    getAnthropicStatus(runner)
  ]);
  return [openai, anthropic];
}

export async function launchProviderLogin(runner: CommandRunner, provider: ProviderId) {
  if (provider === "openai") {
    const result = await runner.startLogin("codex", ["login", "--device-auth"], openUrl);
    return {
      ok: true,
      message: result.openedInTerminal
        ? "Opened Codex login in Terminal. Complete the browser/device-code flow there."
        : "Opened Codex ChatGPT OAuth login in your browser.",
      url: result.url,
      deviceCode: result.deviceCode
    };
  }

  const result = await runner.startLogin("claude", ["auth", "login"], openUrl);
  return {
    ok: true,
    message: result.openedInTerminal
      ? "Opened Claude login in Terminal. Complete the browser flow there."
      : "Opened Claude OAuth login in your browser.",
    url: result.url,
    deviceCode: result.deviceCode
  };
}

async function getOpenAiStatus(runner: CommandRunner): Promise<ProviderStatus> {
  const command = "codex login status";
  const version = await runner.run("codex", ["--version"], { timeoutMs: 10_000 });
  if (version.code === 127) {
    return missing("openai", command, "Install Codex CLI to use OpenAI as an agent.");
  }

  const status = await runner.run("codex", ["login", "status"], { timeoutMs: 15_000 });
  const combined = `${status.stdout}\n${status.stderr}`.trim();
  const loggedIn = status.code === 0 && /logged in/i.test(combined);
  return {
    provider: "openai",
    label: providerLabels.openai,
    installed: true,
    loggedIn,
    authMethod: loggedIn ? combined : undefined,
    detail: combined || "Codex CLI is installed, but login status is unknown.",
    command,
    version: version.stdout.trim() || version.stderr.trim()
  };
}

async function getAnthropicStatus(runner: CommandRunner): Promise<ProviderStatus> {
  const command = "claude auth status";
  const version = await runner.run("claude", ["--version"], { timeoutMs: 10_000 });
  if (version.code === 127) {
    return missing("anthropic", command, "Install Claude Code to use Anthropic as an agent.");
  }

  const status = await runner.run("claude", ["auth", "status"], { timeoutMs: 15_000 });
  const combined = `${status.stdout}\n${status.stderr}`.trim();
  let loggedIn = status.code === 0 && /loggedIn["']?\s*:\s*true/i.test(combined);
  let authMethod: string | undefined;
  try {
    const parsed = JSON.parse(status.stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
    loggedIn = Boolean(parsed.loggedIn);
    authMethod = [parsed.authMethod, parsed.subscriptionType].filter(Boolean).join(" / ");
  } catch {
    authMethod = loggedIn ? combined : undefined;
  }

  return {
    provider: "anthropic",
    label: providerLabels.anthropic,
    installed: true,
    loggedIn,
    authMethod,
    detail: combined || "Claude Code is installed, but login status is unknown.",
    command,
    version: version.stdout.trim() || version.stderr.trim()
  };
}

function missing(provider: ProviderId, command: string, detail: string): ProviderStatus {
  return {
    provider,
    label: providerLabels[provider],
    installed: false,
    loggedIn: false,
    detail,
    command
  };
}

function openUrl(url: string) {
  import("electron")
    .then(({ shell }) => shell?.openExternal?.(url))
    .catch(() => undefined);
}

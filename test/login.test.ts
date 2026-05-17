import { describe, expect, it } from "vitest";
import { launchProviderLogin } from "../electron/providers";
import type { CommandRunner, CommandResult, LoginCommandResult } from "../electron/commandRunner";

class LoginRunner implements CommandRunner {
  openedUrl: string | undefined;

  constructor(private loginResult: LoginCommandResult) {}

  async run(): Promise<CommandResult> {
    return { code: 0, stdout: "", stderr: "" };
  }

  async launch() {}

  async startLogin(_command: string, _args: string[], onUrl: (url: string) => void): Promise<LoginCommandResult> {
    if (this.loginResult.url) {
      onUrl(this.loginResult.url);
      this.openedUrl = this.loginResult.url;
    }
    return this.loginResult;
  }
}

describe("launchProviderLogin", () => {
  it("returns browser URL and device code for Codex login", async () => {
    const runner = new LoginRunner({
      output: "Open https://auth.openai.com/codex/device and enter QFW4-Q0KK9",
      url: "https://auth.openai.com/codex/device",
      deviceCode: "QFW4-Q0KK9",
      openedInTerminal: false
    });

    const result = await launchProviderLogin(runner, "openai");

    expect(result.url).toBe("https://auth.openai.com/codex/device");
    expect(result.deviceCode).toBe("QFW4-Q0KK9");
    expect(runner.openedUrl).toBe(result.url);
  });
});

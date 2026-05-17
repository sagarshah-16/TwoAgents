import { spawn } from "node:child_process";
import { emitAgentLog } from "./logBus.js";

export type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True if our timeout fired and we sent SIGTERM ourselves. */
  timedOut?: boolean;
  /** Wall-clock duration the child actually ran for, in milliseconds. */
  durationMs?: number;
};

export type LoginCommandResult = {
  output: string;
  url?: string;
  deviceCode?: string;
  openedInTerminal: boolean;
};

export type CommandRunner = {
  run: (
    command: string,
    args: string[],
    options?: { cwd?: string; input?: string; timeoutMs?: number; signal?: AbortSignal }
  ) => Promise<CommandResult>;
  launch: (command: string, args: string[]) => Promise<void>;
  startLogin: (command: string, args: string[], onUrl: (url: string) => void) => Promise<LoginCommandResult>;
};

export class SpawnCommandRunner implements CommandRunner {
  run(
    command: string,
    args: string[],
    options: { cwd?: string; input?: string; timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      emitAgentLog("command", `${command} ${args.join(" ")}`);
      // If we're already aborted, return immediately without spawning anything.
      if (options.signal?.aborted) {
        resolve({ code: 130, stdout: "", stderr: "aborted" });
        return;
      }
      const child = spawn(command, args, {
        cwd: options.cwd,
        shell: false,
        env: withCliPath()
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      const startedAt = Date.now();
      const finish = (result: CommandResult) => {
        if (settled) {
          return;
        }
        settled = true;
        if (options.signal && abortHandler) {
          options.signal.removeEventListener("abort", abortHandler);
        }
        resolve({ ...result, durationMs: Date.now() - startedAt });
      };
      const timeoutMs = options.timeoutMs ?? 120_000;
      const timeout = setTimeout(() => {
        timedOut = true;
        emitAgentLog("command", `${command} timed out after ${Math.round(timeoutMs / 1000)}s — sending SIGTERM`);
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignored */
        }
        // Escalate to SIGKILL if it doesn't go down cleanly.
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignored */
          }
        }, 1500);
      }, timeoutMs);
      // Wire abort: SIGTERM the child, then SIGKILL after 1s if it didn't exit cleanly.
      const abortHandler = () => {
        emitAgentLog("command", `${command} aborted by user`);
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignored */
        }
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignored */
          }
        }, 1000);
        finish({ code: 130, stdout, stderr: stderr || "aborted by user" });
      };
      if (options.signal) {
        options.signal.addEventListener("abort", abortHandler);
      }

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        emitChunk(command, chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        emitChunk(command, chunk);
      });
      // Stream-level errors (EPIPE on stdin if the child dies before we finish writing,
      // ECONNRESET, etc.) must not become uncaught exceptions.
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EPIPE") {
          // The child closed stdin before we finished writing the prompt — this is normal
          // when the CLI bails out fast (e.g. usage-limit error). Drop the write silently;
          // the close handler will still resolve the promise with the real exit code.
          return;
        }
        emitAgentLog("command", `${command} stdin error: ${error.message}`);
      });
      child.stdout.on("error", () => {
        /* nothing useful to do; stdout closing is handled via close */
      });
      child.stderr.on("error", () => {
        /* same */
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        finish({ code: 127, stdout, stderr: error.message, timedOut });
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        const elapsed = Date.now() - startedAt;
        emitAgentLog("command", `${command} exited with ${code ?? "unknown"}${timedOut ? ` (timed out after ${Math.round(elapsed / 1000)}s)` : ""}`);
        finish({ code, stdout, stderr, timedOut });
      });

      try {
        if (options.input) {
          child.stdin.write(options.input, (writeError) => {
            // Async error callback — already handled by the 'error' listener above,
            // but we keep the callback so write() returns immediately.
            if (writeError && (writeError as NodeJS.ErrnoException).code !== "EPIPE") {
              emitAgentLog("command", `${command} stdin write error: ${writeError.message}`);
            }
          });
        }
        child.stdin.end();
      } catch (error) {
        // Synchronous failure (e.g. stdin already destroyed). The close handler will still fire.
        const reason = error instanceof Error ? error.message : String(error);
        if (!(error as NodeJS.ErrnoException)?.code || (error as NodeJS.ErrnoException).code !== "EPIPE") {
          emitAgentLog("command", `${command} stdin write threw: ${reason}`);
        }
      }
    });
  }

  async launch(command: string, args: string[]): Promise<void> {
    if (process.platform === "darwin") {
      const escaped = `export PATH=${shellQuote(cliPath())}:$PATH; ${[command, ...args].map(shellQuote).join(" ")}`;
      spawn("osascript", [
        "-e",
        `tell application "Terminal" to activate`,
        "-e",
        `tell application "Terminal" to do script ${JSON.stringify(escaped)}`
      ], {
        detached: true,
        stdio: "ignore"
      }).unref();
      return;
    }

    spawn(command, args, {
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
      env: withCliPath()
    }).unref();
  }

  startLogin(command: string, args: string[], onUrl: (url: string) => void): Promise<LoginCommandResult> {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        detached: true,
        shell: false,
        env: withCliPath()
      });
      let output = "";
      let url: string | undefined;
      let deviceCode: string | undefined;
      let resolved = false;

      const finish = (openedInTerminal: boolean) => {
        if (resolved) {
          return;
        }
        resolved = true;
        resolve({
          output: output.trim(),
          url,
          deviceCode,
          openedInTerminal
        });
      };

      const inspect = (chunk: Buffer) => {
        output += stripAnsi(chunk.toString());
        url ??= findUrl(output);
        deviceCode ??= findDeviceCode(output);
        if (url) {
          onUrl(url);
          finish(false);
        }
      };

      child.stdout.on("data", inspect);
      child.stderr.on("data", inspect);
      child.stdout.on("error", () => undefined);
      child.stderr.on("error", () => undefined);
      child.stdin?.on("error", () => undefined);
      child.on("error", async () => {
        await this.launch(command, args);
        finish(true);
      });

      setTimeout(async () => {
        if (!resolved) {
          child.kill("SIGTERM");
          await this.launch(command, args);
          finish(true);
        }
      }, 5000);

      child.unref();
    });
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function cliPath(): string {
  return [
    "/Applications/Codex.app/Contents/Resources",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ].join(":");
}

// Env vars set by parent Claude Code / Codex sessions. If any of these leak into
// our spawned worker/reviewer CLIs, Claude Code refuses to start a nested session
// ("Claude Code cannot be launched inside another Claude Code session.") and Codex
// can pick up unintended config. We strip them so the agents always run cleanly.
const PARENT_AGENT_ENV_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_AGENT_PARENT",
  "ANTHROPIC_AGENT",
  "CODEX_PARENT_SESSION",
  "CODEX_PARENT_PID",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED"
];

export function sanitizeEnvForChild(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {
    ...env,
    PATH: `${cliPath()}:${env.PATH ?? ""}`,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    SSH_ASKPASS: "/bin/false",
    SSH_ASKPASS_REQUIRE: "never"
  };
  for (const key of PARENT_AGENT_ENV_VARS) {
    delete next[key];
  }
  return next;
}

function withCliPath(): NodeJS.ProcessEnv {
  return sanitizeEnvForChild(process.env);
}

function emitChunk(source: string, chunk: Buffer) {
  const lines = stripAnsi(chunk.toString())
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4);
  for (const line of lines) {
    emitAgentLog(source, line);
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function findUrl(value: string): string | undefined {
  const match = value.match(/https?:\/\/[^\s"'<>]+/);
  return match?.[0]?.replace(/[),.;]+$/, "");
}

function findDeviceCode(value: string): string | undefined {
  const match = value.match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/);
  return match?.[0];
}

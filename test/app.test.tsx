import { describe, expect, it, vi } from "vitest";
import type { AgentRunResult, AppSettings, BridgeApi, ChatSession, ProviderStatus } from "../shared/types";

function installBridge(overrides: Partial<BridgeApi> = {}) {
  const settings: AppSettings = {
    defaultWorkspacePath: "/tmp/example-workspace",
    maxIterations: 6,
    skills: [],
    executionMode: "read_only"
  };
  const statuses: ProviderStatus[] = [
    {
      provider: "openai",
      label: "OpenAI Codex",
      installed: true,
      loggedIn: true,
      command: "codex login status",
      detail: "Logged in",
      version: "codex 1.0.0"
    },
    {
      provider: "anthropic",
      label: "Claude Code",
      installed: true,
      loggedIn: true,
      command: "claude auth status",
      detail: "Logged in",
      version: "1.0.0"
    }
  ];
  const chats: ChatSession[] = [];
  const bridge: BridgeApi = {
    getProviderStatuses: vi.fn(async () => statuses),
    launchLogin: vi.fn(async () => ({ ok: true, message: "" })),
    runAgents: vi.fn(async (): Promise<AgentRunResult> => ({
      status: "approved",
      finalAnswer: "ok",
      iterations: [],
      changedFiles: []
    })),
    cancelAgents: vi.fn(async () => ({ ok: true })),
    onAgentRunStarted: vi.fn(() => () => undefined),
    chooseWorkspace: vi.fn(async () => "/tmp/example-workspace"),
    getSettings: vi.fn(async () => settings),
    saveSettings: vi.fn(async (next: AppSettings) => next),
    applyPatch: vi.fn(async () => ({ ok: true, message: "applied" })),
    listChats: vi.fn(async () => chats),
    createChat: vi.fn(
      async (): Promise<ChatSession> => ({
        id: "test-1",
        title: "New chat",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        roles: { worker: "openai", reviewer: "anthropic" },
        workspacePath: "/tmp/example-workspace",
        messages: []
      })
    ),
    saveChat: vi.fn(async (chat: ChatSession) => chat),
    deleteChat: vi.fn(async () => []),
    onAgentLog: vi.fn(() => () => undefined),
    getLogFilePath: vi.fn(async () => "/tmp/main.log"),
    exportChatPdf: vi.fn(async () => ({ ok: true, filePath: "/tmp/chat.pdf" })),
    ...overrides
  };
  Object.defineProperty(window, "twoAgents", {
    value: bridge,
    writable: true,
    configurable: true
  });
  return bridge;
}

describe("App renderer smoke", () => {
  it("mounts without error and shows the brand and welcome content", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    installBridge();
    // Importing App.tsx runs createRoot(...).render(...). Use vi.resetModules so the import re-runs.
    vi.resetModules();
    await import("../src/App");
    // give React a tick to flush microtasks plus the initial loadInitialState promise
    await new Promise((resolve) => setTimeout(resolve, 30));
    await new Promise((resolve) => setTimeout(resolve, 30));

    const root = document.getElementById("root");
    expect(root).toBeTruthy();
    const text = root?.textContent ?? "";
    expect(text).toContain("Two Agents");
    expect(text).toContain("New chat");
    expect(text.toLowerCase()).toContain("worker");
    expect(text.toLowerCase()).toContain("reviewer");
  });
});

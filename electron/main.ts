import { app, BrowserWindow, dialog, ipcMain } from "electron";
import Store from "electron-store";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentRunRequest,
  AppSettings,
  ChatSession,
  ExportChatPdfRequest,
  ExportChatPdfResult,
  ProviderId
} from "../shared/types.js";
import { SpawnCommandRunner } from "./commandRunner.js";
import { applyUnifiedPatch } from "./patches.js";
import { getProviderStatuses, launchProviderLogin } from "./providers.js";
import { runAgentLoop } from "./orchestrator.js";
import { onAgentLog } from "./logBus.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runner = new SpawnCommandRunner();
type StoreShape = AppSettings & {
  chats: ChatSession[];
};

const store = new Store<StoreShape>({
  name: "settings",
  defaults: {
    defaultWorkspacePath: app.getPath("documents"),
    // 5 is enough for the worker→reviewer loop in the vast majority of tasks.
    // Anything higher and the reviewer tends to keep finding nits ad infinitum.
    maxIterations: 5,
    skills: [],
    executionMode: "read_only",
    chats: []
  }
});

// ----- EPIPE-safe console & persistent log file --------------------------
// macOS: ~/Library/Logs/two-agents/main.log
// Linux: ~/.config/two-agents/logs/main.log
// Windows: %APPDATA%\two-agents\logs\main.log
//
// Why this is here: when the parent terminal that spawned `npm run dev` is
// killed (Ctrl-C, window close, concurrently exits, etc.) but the Electron
// process keeps running, stdout/stderr become broken pipes. Any subsequent
// console.log / console.error throws EPIPE, which is then itself "uncaught"
// and triggers Electron's default error dialog. We swallow EPIPE on the
// stdio streams and mirror everything to a persistent file instead.

let stdioBroken = false;
function markStdioBroken(label: string, error: NodeJS.ErrnoException) {
  if (error && error.code === "EPIPE") {
    stdioBroken = true;
    appendLog(`[stdio] ${label} pipe closed (EPIPE) — switching to file-only logging`);
    return;
  }
  appendLog(`[stdio] ${label} stream error ${error?.code || ""} ${error?.message || ""}`);
}
process.stdout.on("error", (error) => markStdioBroken("stdout", error as NodeJS.ErrnoException));
process.stderr.on("error", (error) => markStdioBroken("stderr", error as NodeJS.ErrnoException));

function safeConsoleLog(...args: unknown[]) {
  if (stdioBroken) {
    return;
  }
  try {
    console.log(...args);
  } catch (error) {
    markStdioBroken("stdout", error as NodeJS.ErrnoException);
  }
}

function safeConsoleError(...args: unknown[]) {
  if (stdioBroken) {
    return;
  }
  try {
    console.error(...args);
  } catch (error) {
    markStdioBroken("stderr", error as NodeJS.ErrnoException);
  }
}

const logDir = app.getPath("logs");
try {
  fs.mkdirSync(logDir, { recursive: true });
} catch {
  /* best-effort */
}
const logFile = path.join(logDir, "main.log");

function appendLog(line: string) {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()}  ${line}\n`);
  } catch {
    /* swallow log errors so they never break the app */
  }
}

const sessionStart = new Date().toISOString();
appendLog(`\n===== two-agents session start ${sessionStart} =====`);
appendLog(`logDir=${logDir}`);

process.on("uncaughtException", (error) => {
  // Never throw from inside this handler — both console + appendLog must be safe.
  if ((error as NodeJS.ErrnoException)?.code === "EPIPE") {
    stdioBroken = true;
    appendLog(`[fatal] uncaughtException EPIPE swallowed`);
    return;
  }
  safeConsoleError("[main] uncaughtException", error);
  appendLog(`[fatal] uncaughtException ${error?.stack || String(error)}`);
});

process.on("unhandledRejection", (reason) => {
  const err = reason as NodeJS.ErrnoException | undefined;
  if (err?.code === "EPIPE") {
    stdioBroken = true;
    appendLog(`[fatal] unhandledRejection EPIPE swallowed`);
    return;
  }
  safeConsoleError("[main] unhandledRejection", reason);
  appendLog(`[fatal] unhandledRejection ${reason instanceof Error ? reason.stack : String(reason)}`);
});

onAgentLog((event) => {
  safeConsoleLog(`[agent:${event.source}] ${event.message}`);
  appendLog(`[${event.source}] ${event.message}`);
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send("agent:log", event);
    } catch (error) {
      appendLog(`[ipc] webContents.send failed: ${(error as Error)?.message ?? error}`);
    }
  }
});

async function createWindow() {
  const win = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 960,
    minHeight: 680,
    title: "Two Agents",
    backgroundColor: "#f7f4ed",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (!app.isPackaged) {
    await win.loadURL(process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    await win.loadFile(path.join(__dirname, "../../dist/index.html"));
  }
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

ipcMain.handle("providers:statuses", () => getProviderStatuses(runner));

ipcMain.handle("providers:login", (_event, provider: ProviderId) => {
  return launchProviderLogin(runner, provider);
});

// Active runs that can be cancelled by the user. We key by a short id which is
// also returned to the renderer in the `agent:log` channel so the UI knows what
// to cancel.
const activeRuns = new Map<string, AbortController>();

ipcMain.handle("agents:run", async (_event, request: AgentRunRequest) => {
  const requestId = randomUUID().slice(0, 8);
  const controller = new AbortController();
  activeRuns.set(requestId, controller);
  appendLog(
    `[agents:run ${requestId}] start  worker=${request.roles.worker} reviewer=${request.roles.reviewer} ` +
      `mode=${request.executionMode || "read_only"} workspace=${request.workspacePath || "(none)"} ` +
      `task=${(request.task || "").slice(0, 120).replace(/\s+/g, " ")}`
  );
  // Tell the renderer the run-id so it can wire up its cancel button.
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send("agent:run-started", { requestId });
    } catch {
      /* renderer might be gone */
    }
  }
  try {
    const result = await runAgentLoop(runner, request, controller.signal);
    appendLog(
      `[agents:run ${requestId}] end status=${result.status} iterations=${result.iterations.length} ` +
        `skipped=${(result.skippedAgents || []).map((s) => `${s.provider}/${s.role}`).join(",") || "none"}`
    );
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    appendLog(`[agents:run ${requestId}] threw  ${reason}`);
    return {
      status: "failed",
      failureReason: reason,
      iterations: [],
      changedFiles: []
    };
  } finally {
    activeRuns.delete(requestId);
  }
});

ipcMain.handle("agents:cancel", (_event, requestId?: string) => {
  if (requestId) {
    const controller = activeRuns.get(requestId);
    if (!controller) {
      appendLog(`[agents:cancel] no active run with id=${requestId}`);
      return { ok: false };
    }
    controller.abort();
    appendLog(`[agents:cancel] aborted run ${requestId}`);
    return { ok: true };
  }
  // Cancel everything if no specific id given.
  let count = 0;
  for (const controller of activeRuns.values()) {
    controller.abort();
    count += 1;
  }
  appendLog(`[agents:cancel] aborted ${count} active run(s)`);
  return { ok: count > 0 };
});

ipcMain.handle("logs:path", () => logFile);

ipcMain.handle("workspace:choose", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose workspace",
    properties: ["openDirectory"]
  });
  if (result.canceled) {
    return undefined;
  }
  const selected = result.filePaths[0];
  return selected;
});

ipcMain.handle("settings:get", () => store.store);

ipcMain.handle("settings:save", (_event, settings: AppSettings) => {
  const safeSettings = {
    defaultWorkspacePath: settings.defaultWorkspacePath,
    maxIterations: Math.max(1, Math.min(settings.maxIterations || 20, 20)),
    skills: settings.skills ?? [],
    executionMode: settings.executionMode === "workspace_write" ? "workspace_write" : "read_only"
  } satisfies AppSettings;
  store.set(safeSettings);
  return store.store;
});

ipcMain.handle("patch:apply", (_event, workspacePath: string, patch: string) => {
  return applyUnifiedPatch(runner, workspacePath, patch);
});

ipcMain.handle("chats:list", () => {
  return [...(store.get("chats") ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
});

ipcMain.handle("chats:create", () => {
  const now = new Date().toISOString();
  const chat: ChatSession = {
    id: randomUUID(),
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    roles: { worker: "openai", reviewer: "anthropic" },
    workspacePath: store.get("defaultWorkspacePath"),
    messages: []
  };
  const chats = [chat, ...(store.get("chats") ?? [])];
  store.set("chats", chats);
  return chat;
});

ipcMain.handle("chats:save", (_event, chat: ChatSession) => {
  const chats = store.get("chats") ?? [];
  const nextChat = {
    ...chat,
    title: chat.title.trim() || titleFromMessages(chat) || "New chat",
    updatedAt: new Date().toISOString()
  };
  const next = [nextChat, ...chats.filter((item) => item.id !== chat.id)]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  store.set("chats", next);
  return nextChat;
});

ipcMain.handle("chats:delete", (_event, chatId: string) => {
  const next = (store.get("chats") ?? []).filter((chat) => chat.id !== chatId);
  store.set("chats", next);
  return next;
});

ipcMain.handle("chat:export-pdf", async (event, request: ExportChatPdfRequest): Promise<ExportChatPdfResult> => {
  if (!request || typeof request.html !== "string" || request.html.length === 0) {
    return { ok: false, message: "Nothing to export." };
  }

  // Anchor the save dialog to the window the request originated from so the sheet
  // is modal on macOS instead of detached.
  const parentWin = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined;

  const safeStem = (request.suggestedFileName || "two-agents-chat").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "chat";
  const dateStamp = new Date().toISOString().slice(0, 10);
  const defaultPath = path.join(app.getPath("downloads"), `${safeStem}-${dateStamp}.pdf`);

  const saveDialogOptions = {
    title: "Export chat as PDF",
    defaultPath,
    filters: [{ name: "PDF", extensions: ["pdf"] }]
  };
  const saveResult = parentWin
    ? await dialog.showSaveDialog(parentWin, saveDialogOptions)
    : await dialog.showSaveDialog(saveDialogOptions);

  if (saveResult.canceled || !saveResult.filePath) {
    return { ok: false, cancelled: true };
  }

  // Hidden window does the rendering. We avoid `show:false` interactions with
  // some compositors by using `paintWhenInitiallyHidden`.
  const printWin = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: false
    }
  });

  try {
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(request.html)}`;
    await printWin.loadURL(dataUrl);
    // Give the renderer one tick to lay out fonts/CSS before snapshotting.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const pdfBuffer = await printWin.webContents.printToPDF({
      printBackground: true,
      pageSize: "A4",
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 }
    });
    fs.writeFileSync(saveResult.filePath, pdfBuffer);
    appendLog(`[chat:export-pdf] wrote ${pdfBuffer.byteLength} bytes -> ${saveResult.filePath}`);
    return { ok: true, filePath: saveResult.filePath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(`[chat:export-pdf] failed: ${message}`);
    return { ok: false, message };
  } finally {
    if (!printWin.isDestroyed()) {
      printWin.destroy();
    }
  }
});

function titleFromMessages(chat: ChatSession) {
  const firstUserMessage = chat.messages.find((message) => message.role === "user")?.content.trim();
  if (!firstUserMessage) {
    return undefined;
  }
  return firstUserMessage.length > 46 ? `${firstUserMessage.slice(0, 43)}...` : firstUserMessage;
}

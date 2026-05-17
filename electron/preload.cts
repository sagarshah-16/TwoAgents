import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentLogEvent,
  AgentRunRequest,
  AppSettings,
  BridgeApi,
  ChatSession,
  ExportChatPdfRequest,
  LoginProvider,
  RunStartedEvent
} from "../shared/types.js";

const api: BridgeApi = {
  getProviderStatuses: () => ipcRenderer.invoke("providers:statuses"),
  launchLogin: (provider: LoginProvider) => ipcRenderer.invoke("providers:login", provider),
  runAgents: (request: AgentRunRequest) => ipcRenderer.invoke("agents:run", request),
  cancelAgents: (requestId?: string) => ipcRenderer.invoke("agents:cancel", requestId),
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings: AppSettings) => ipcRenderer.invoke("settings:save", settings),
  applyPatch: (workspacePath: string, patch: string) => ipcRenderer.invoke("patch:apply", workspacePath, patch),
  listChats: () => ipcRenderer.invoke("chats:list"),
  createChat: () => ipcRenderer.invoke("chats:create"),
  saveChat: (chat: ChatSession) => ipcRenderer.invoke("chats:save", chat),
  deleteChat: (chatId: string) => ipcRenderer.invoke("chats:delete", chatId),
  onAgentLog: (callback: (event: AgentLogEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AgentLogEvent) => callback(payload);
    ipcRenderer.on("agent:log", listener);
    return () => ipcRenderer.off("agent:log", listener);
  },
  onAgentRunStarted: (callback: (event: RunStartedEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: RunStartedEvent) => callback(payload);
    ipcRenderer.on("agent:run-started", listener);
    return () => ipcRenderer.off("agent:run-started", listener);
  },
  getLogFilePath: () => ipcRenderer.invoke("logs:path"),
  exportChatPdf: (request: ExportChatPdfRequest) => ipcRenderer.invoke("chat:export-pdf", request)
};

contextBridge.exposeInMainWorld("twoAgents", api);

import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Cog,
  FileDown,
  FileText,
  FolderOpen,
  KeyRound,
  Loader2,
  Maximize2,
  MessageSquare,
  Minimize2,
  Paperclip,
  Plus,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  User,
  X
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AgentLogEvent,
  AgentSkill,
  AgentSkillTarget,
  AgentRunResult,
  ChatAttachment,
  ChatMessage,
  ChatSession,
  ExecutionMode,
  IterationTiming,
  LoginLaunchResult,
  ProviderId,
  ProviderStatus,
  RoleSelection,
  RunTimings,
  SkippedAgent
} from "./shared/types";
import "./styles.css";

const providerNames: Record<ProviderId, string> = {
  openai: "OpenAI Codex",
  anthropic: "Claude Code"
};

const providerShort: Record<ProviderId, string> = {
  openai: "Codex",
  anthropic: "Claude"
};

const defaultRoles: RoleSelection = { worker: "openai", reviewer: "anthropic" };

type RunPhase = "worker" | "reviewer";

type RunTracker = RunTimings & {
  currentIteration?: number;
  currentPhase?: RunPhase;
  currentProvider?: ProviderId;
  currentLabel?: string;
  phaseStartedAt?: number;
  /** The latest non-trivial activity message from any agent — for "what is it doing right now". */
  lastDetail?: string;
};

export function newTracker(now: number): RunTracker {
  return {
    startedAt: now,
    workerTotalMs: 0,
    reviewerTotalMs: 0,
    iterations: []
  };
}

const PHASE_LINE = /Iteration\s+(\d+)\s*\/\s*\d+\s*[—–-]\s*(worker|reviewer)\s+turn\s+\(([^)]+)\)/i;

function providerFromLabel(label: string): ProviderId {
  return /claude|anthropic/i.test(label) ? "anthropic" : "openai";
}

export function applyLogToTracker(prev: RunTracker, event: AgentLogEvent): RunTracker {
  const now = Date.now();
  const message = event.message;
  const phaseMatch = message.match(PHASE_LINE);
  if (phaseMatch) {
    const iter = Number(phaseMatch[1]);
    const phase = phaseMatch[2].toLowerCase() as RunPhase;
    const label = phaseMatch[3].trim();
    const provider = providerFromLabel(label);
    let next: RunTracker = { ...prev, iterations: [...prev.iterations] };
    // Close out the previous phase, if any.
    if (prev.currentPhase && prev.phaseStartedAt && prev.currentIteration != null) {
      const elapsed = now - prev.phaseStartedAt;
      if (prev.currentPhase === "worker") {
        next.workerTotalMs += elapsed;
      } else {
        next.reviewerTotalMs += elapsed;
      }
      const idx = prev.currentIteration - 1;
      const slot: IterationTiming = next.iterations[idx] ?? { iteration: prev.currentIteration };
      if (prev.currentPhase === "worker") {
        slot.workerMs = (slot.workerMs ?? 0) + elapsed;
        slot.workerProvider = prev.currentProvider;
      } else {
        slot.reviewerMs = (slot.reviewerMs ?? 0) + elapsed;
        slot.reviewerProvider = prev.currentProvider;
      }
      next.iterations[idx] = slot;
    }
    // Begin the new phase.
    const idx = iter - 1;
    while (next.iterations.length <= idx) {
      next.iterations.push({ iteration: next.iterations.length + 1 });
    }
    next.iterations[idx] = { ...(next.iterations[idx] ?? { iteration: iter }), iteration: iter };
    if (phase === "worker") {
      next.iterations[idx].workerProvider = provider;
    } else {
      next.iterations[idx].reviewerProvider = provider;
    }
    next.currentIteration = iter;
    next.currentPhase = phase;
    next.currentProvider = provider;
    next.currentLabel = label;
    next.phaseStartedAt = now;
    return next;
  }
  // Track "what is it doing" — surface the latest non-trivial line from claude/codex/orchestrator.
  if (event.source === "claude" || event.source === "codex" || event.source === "orchestrator" || event.source === "brief") {
    const trimmed = message.trim();
    if (trimmed && !PHASE_LINE.test(trimmed)) {
      return { ...prev, lastDetail: trimmed };
    }
  }
  return prev;
}

export function finalizeTracker(prev: RunTracker): RunTracker {
  const now = Date.now();
  let next: RunTracker = { ...prev, iterations: [...prev.iterations] };
  if (prev.currentPhase && prev.phaseStartedAt && prev.currentIteration != null) {
    const elapsed = now - prev.phaseStartedAt;
    if (prev.currentPhase === "worker") {
      next.workerTotalMs += elapsed;
    } else {
      next.reviewerTotalMs += elapsed;
    }
    const idx = prev.currentIteration - 1;
    const slot: IterationTiming = next.iterations[idx] ?? { iteration: prev.currentIteration };
    if (prev.currentPhase === "worker") {
      slot.workerMs = (slot.workerMs ?? 0) + elapsed;
      slot.workerProvider = prev.currentProvider;
    } else {
      slot.reviewerMs = (slot.reviewerMs ?? 0) + elapsed;
      slot.reviewerProvider = prev.currentProvider;
    }
    next.iterations[idx] = slot;
  }
  next.currentPhase = undefined;
  next.currentProvider = undefined;
  next.currentLabel = undefined;
  next.phaseStartedAt = undefined;
  next.finishedAt = now;
  return next;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fileLinkUrl(workspacePath: string | undefined, file: string): string {
  // Generated files come back as workspace-relative paths. Encode each segment so spaces /
  // unicode survive the file:// link, but keep the slashes so the link still resolves.
  const encodeSegments = (input: string) => input.split("/").map(encodeURIComponent).join("/");
  if (!workspacePath) {
    return `file://${encodeSegments(file)}`;
  }
  const trimmedRoot = workspacePath.replace(/\/+$/, "");
  const trimmedFile = file.replace(/^\/+/, "");
  return `file://${encodeSegments(trimmedRoot)}/${encodeSegments(trimmedFile)}`;
}

export function buildChatPdfHtml(
  chat: ChatSession,
  roles: RoleSelection,
  workspacePath: string | undefined
): string {
  const exportedAt = new Date();
  const messageBlocks = chat.messages
    .map((message) => {
      const isUser = message.role === "user";
      const heading = isUser ? "You" : "Reviewed answer";
      const ts = new Date(message.createdAt).toLocaleString();
      const body = escapeHtml(message.content || "").replace(/\n/g, "<br />");

      let extras = "";
      if (message.attachments?.length) {
        const items = message.attachments
          .map((attachment) => {
            const label = `${attachment.name} (${formatBytes(attachment.size)})`;
            return `<li>${escapeHtml(label)}<br /><span>${escapeHtml(attachment.path)}</span></li>`;
          })
          .join("");
        extras += `<div class="files-block"><div class="files-title">Attached files</div><ul>${items}</ul></div>`;
      }
      const result = message.result;
      if (!isUser && result) {
        const stat: string[] = [];
        stat.push(`Status: ${escapeHtml(result.status.replace(/_/g, " "))}`);
        if (result.iterations.length) {
          stat.push(`${result.iterations.length} iteration${result.iterations.length === 1 ? "" : "s"}`);
        }
        const files = result.changedFiles ?? [];
        if (files.length) {
          stat.push(`${files.length} generated file${files.length === 1 ? "" : "s"}`);
        }
        extras += `<div class="msg-meta-line">${stat.join(" · ")}</div>`;

        // Per the user request: only LINKS to generated files in the PDF — never the diff or contents.
        if (files.length) {
          const items = files
            .map((file) => {
              const safeFile = escapeHtml(file);
              const href = fileLinkUrl(workspacePath, file);
              return `<li><a href="${escapeHtml(href)}">${safeFile}</a></li>`;
            })
            .join("");
          extras += `<div class="files-block"><div class="files-title">Generated files</div><ul>${items}</ul></div>`;
        }
      }

      return `
        <article class="msg ${isUser ? "user" : "assistant"}">
          <header class="msg-head">
            <span class="msg-role">${escapeHtml(heading)}</span>
            <span class="msg-time">${escapeHtml(ts)}</span>
          </header>
          <div class="msg-body">${body || "<em class=\"muted\">(empty)</em>"}</div>
          ${extras}
        </article>
      `;
    })
    .join("\n");

  const title = escapeHtml(chat.title?.trim() || "Two Agents chat");
  const workerLabel = escapeHtml(providerNames[roles.worker] ?? roles.worker);
  const reviewerLabel = escapeHtml(providerNames[roles.reviewer] ?? roles.reviewer);
  const wsLine = workspacePath
    ? `<span class="meta-chip">Workspace: ${escapeHtml(workspacePath)}</span>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 28px 32px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    color: #1f2329;
    background: #ffffff;
    font-size: 12px;
    line-height: 1.5;
  }
  header.doc-head {
    border-bottom: 1px solid #d8d4ca;
    padding-bottom: 14px;
    margin-bottom: 18px;
  }
  h1.doc-title {
    margin: 0 0 6px;
    font-size: 20px;
    font-weight: 600;
  }
  .doc-meta {
    color: #5b6168;
    font-size: 11px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
  }
  .meta-chip {
    background: #f1efe8;
    border-radius: 4px;
    padding: 2px 8px;
  }
  article.msg {
    page-break-inside: avoid;
    border: 1px solid #e6e2d8;
    border-radius: 8px;
    padding: 12px 14px;
    margin-bottom: 12px;
    background: #fdfcf8;
  }
  article.msg.user { background: #f4f1ea; }
  article.msg.assistant { background: #fdfcf8; }
  .msg-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 6px;
    font-size: 11px;
    color: #4a5159;
  }
  .msg-role { font-weight: 600; color: #1f2329; }
  .msg-time { font-variant-numeric: tabular-nums; }
  .msg-body {
    white-space: pre-wrap;
    word-wrap: break-word;
    font-size: 12px;
  }
  .msg-meta-line {
    margin-top: 8px;
    font-size: 10.5px;
    color: #5b6168;
  }
  .files-block {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px dashed #cfcabd;
  }
  .files-title {
    font-size: 11px;
    font-weight: 600;
    margin-bottom: 4px;
    color: #1f2329;
  }
  .files-block ul {
    margin: 0;
    padding-left: 18px;
  }
  .files-block li {
    font-size: 11px;
    word-break: break-all;
  }
  .files-block a { color: #1c5f53; text-decoration: underline; }
  .muted { color: #8b8f97; }
  @page { margin: 14mm; }
</style>
</head>
<body>
  <header class="doc-head">
    <h1 class="doc-title">${title}</h1>
    <div class="doc-meta">
      <span class="meta-chip">Worker · ${workerLabel}</span>
      <span class="meta-chip">Reviewer · ${reviewerLabel}</span>
      ${wsLine}
      <span class="meta-chip">Exported ${escapeHtml(exportedAt.toLocaleString())}</span>
      <span class="meta-chip">${chat.messages.length} message${chat.messages.length === 1 ? "" : "s"}</span>
    </div>
  </header>
  <main>
    ${messageBlocks || "<p class=\"muted\">No messages.</p>"}
  </main>
</body>
</html>`;
}

function trackerToTimings(tracker: RunTracker | undefined): RunTimings | undefined {
  if (!tracker) return undefined;
  return {
    startedAt: tracker.startedAt,
    finishedAt: tracker.finishedAt ?? Date.now(),
    workerTotalMs: tracker.workerTotalMs,
    reviewerTotalMs: tracker.reviewerTotalMs,
    iterations: tracker.iterations
  };
}

function App() {
  const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
  const [chats, setChats] = useState<ChatSession[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | undefined>();
  const [roles, setRoles] = useState<RoleSelection>(defaultRoles);
  const [defaultWorkspacePath, setDefaultWorkspacePath] = useState<string | undefined>();
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("read_only");
  const [input, setInput] = useState("");
  const [maxIterations, setMaxIterations] = useState(20);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [loginResult, setLoginResult] = useState<LoginLaunchResult | undefined>();
  const [agentLogs, setAgentLogs] = useState<AgentLogEvent[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | undefined>();
  const [runStartedAt, setRunStartedAt] = useState<number | undefined>();
  const [runTracker, setRunTracker] = useState<RunTracker | undefined>();
  const trackerRef = useRef<RunTracker | undefined>(undefined);
  trackerRef.current = runTracker;
  const agentLogsRef = useRef<AgentLogEvent[]>([]);
  agentLogsRef.current = agentLogs;
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const loginRefreshTimersRef = useRef<number[]>([]);
  const dragDepthRef = useRef(0);

  const ready = statuses.length === 2 && statuses.every((status) => status.installed && status.loggedIn);
  const activeChat = chats.find((chat) => chat.id === activeChatId);
  const activeRoles = activeChat?.roles ?? roles;
  const activeWorkspacePath = activeChat?.workspacePath || defaultWorkspacePath;
  const canSend = ready && (input.trim().length > 0 || attachments.length > 0) && !running;
  const canAttach = true;
  const statusMap = useMemo(() => new Map(statuses.map((status) => [status.provider, status])), [statuses]);

  useEffect(() => {
    void loadInitialState();
    const offLog = window.twoAgents.onAgentLog((event) => {
      setAgentLogs((logs) => [...logs.slice(-499), event]);
      setRunTracker((current) => (current ? applyLogToTracker(current, event) : current));
    });
    const offRun = window.twoAgents.onAgentRunStarted?.(({ requestId }) => {
      setActiveRunId(requestId);
      setRunStartedAt(Date.now());
    });
    return () => {
      offLog();
      offRun?.();
      clearLoginRefreshTimers();
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeChat?.messages.length, running, agentLogs.length]);

  async function loadInitialState() {
    const [settings, savedChats] = await Promise.all([
      window.twoAgents.getSettings(),
      window.twoAgents.listChats(),
      refreshStatuses()
    ]);
    setDefaultWorkspacePath(settings.defaultWorkspacePath);
    setMaxIterations(settings.maxIterations);
    setSkills(settings.skills ?? []);
    setExecutionMode(settings.executionMode === "workspace_write" ? "workspace_write" : "read_only");
    if (savedChats.length > 0) {
      setChats(savedChats);
      setActiveChatId(savedChats[0].id);
      setRoles(savedChats[0].roles ?? defaultRoles);
    } else {
      const chat = await window.twoAgents.createChat();
      setChats([chat]);
      setActiveChatId(chat.id);
      setRoles(chat.roles ?? defaultRoles);
    }
  }

  async function refreshStatuses() {
    setRefreshing(true);
    try {
      setStatuses(await window.twoAgents.getProviderStatuses());
    } finally {
      setRefreshing(false);
    }
  }

  async function createChat() {
    const chat = await window.twoAgents.createChat();
    const nextChat = {
      ...chat,
      roles,
      workspacePath: chat.workspacePath || defaultWorkspacePath
    };
    await window.twoAgents.saveChat(nextChat);
    setChats((items) => [nextChat, ...items]);
    setActiveChatId(nextChat.id);
    setInput("");
    setAttachments([]);
    setAgentLogs([]);
  }

  async function deleteChat(chatId: string) {
    const next = await window.twoAgents.deleteChat(chatId);
    if (next.length === 0) {
      const chat = await window.twoAgents.createChat();
      const nextChat = { ...chat, roles, workspacePath: chat.workspacePath || defaultWorkspacePath };
      await window.twoAgents.saveChat(nextChat);
      setChats([nextChat]);
      setActiveChatId(nextChat.id);
      return;
    }
    setChats(next);
    if (activeChatId === chatId) {
      setActiveChatId(next[0].id);
    }
  }

  async function launchLogin(provider: ProviderId) {
    const response = await window.twoAgents.launchLogin(provider);
    setNotice(response.message);
    setLoginResult(response);
    scheduleLoginStatusRefreshes(provider);
  }

  function clearLoginRefreshTimers() {
    for (const timer of loginRefreshTimersRef.current) {
      window.clearTimeout(timer);
    }
    loginRefreshTimersRef.current = [];
  }

  function scheduleLoginStatusRefreshes(provider: ProviderId) {
    clearLoginRefreshTimers();
    const refreshDelaysMs = [1_000, 3_000, 8_000, 15_000, 30_000, 60_000, 120_000];
    loginRefreshTimersRef.current = refreshDelaysMs.map((delay) =>
      window.setTimeout(async () => {
        const nextStatuses = await window.twoAgents.getProviderStatuses();
        setStatuses(nextStatuses);
        if (nextStatuses.find((status) => status.provider === provider)?.loggedIn) {
          clearLoginRefreshTimers();
          setNotice(`${providerNames[provider]} is connected.`);
          setLoginResult(undefined);
        }
      }, delay)
    );
  }

  async function setWorker(worker: ProviderId) {
    const nextRoles: RoleSelection = {
      worker,
      reviewer: worker === "openai" ? "anthropic" : "openai"
    };
    setRoles(nextRoles);

    if (activeChat) {
      const saved = await window.twoAgents.saveChat({ ...activeChat, roles: nextRoles });
      upsertChat(saved);
    }
  }

  async function chooseChatWorkspace() {
    const selected = await window.twoAgents.chooseWorkspace();
    if (selected && activeChat) {
      const saved = await window.twoAgents.saveChat({ ...activeChat, workspacePath: selected });
      upsertChat(saved);
    }
  }

  async function chooseDefaultWorkspace() {
    const selected = await window.twoAgents.chooseWorkspace();
    if (selected) {
      setDefaultWorkspacePath(selected);
      await window.twoAgents.saveSettings({
        defaultWorkspacePath: selected,
        maxIterations,
        skills,
        executionMode
      });
    }
  }

  async function saveExecutionMode(mode: ExecutionMode) {
    setExecutionMode(mode);
    await window.twoAgents.saveSettings({
      defaultWorkspacePath,
      maxIterations,
      skills,
      executionMode: mode
    });
  }

  async function chooseAttachments() {
    if (!canAttach) {
      return;
    }
    fileInputRef.current?.click();
  }

  async function attachFiles(files: FileList | File[]) {
    const selectedFiles = Array.from(files).slice(0, 10);
    if (!canAttach || selectedFiles.length === 0) {
      return;
    }
    const selected = await Promise.all(selectedFiles.map(readFileAttachment));
    setAttachments((current) => mergeAttachments(current, selected));
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  function handleDragEnter(event: React.DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event) || !canAttach) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setDraggingFiles(true);
  }

  function handleDragOver(event: React.DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event) || !canAttach) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: React.DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event)) {
      return;
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDraggingFiles(false);
    }
  }

  function handleDrop(event: React.DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event) || !canAttach) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = 0;
    setDraggingFiles(false);
    void attachFiles(event.dataTransfer.files);
  }

  async function sendMessage(overrideContent?: string, overrideAttachments?: ChatAttachment[]) {
    const content = (overrideContent ?? input).trim();
    const messageAttachments = overrideAttachments ?? attachments;
    if (!ready || running || (!content && messageAttachments.length === 0)) {
      return;
    }

    const chat = activeChat ?? (await window.twoAgents.createChat());
    if (!activeChat) {
      setChats((items) => [chat, ...items]);
      setActiveChatId(chat.id);
    }

    const chatRoles = chat.roles ?? roles;
    const displayContent = content || "Uploaded files";
    const userMessage = makeMessage("user", displayContent, undefined, messageAttachments);
    // If the last message in the chat is already the same user content with no reply,
    // treat this as a retry rather than appending a duplicate.
    const lastMessage = chat.messages.at(-1);
    const isRetry =
      Boolean(lastMessage) &&
      lastMessage?.role === "user" &&
      lastMessage.content.trim() === displayContent &&
      sameAttachments(lastMessage.attachments, messageAttachments);
    const messagesForChat = isRetry ? chat.messages : [...chat.messages, userMessage];
    const chatWithUser = normalizeChatTitle({
      ...chat,
      roles: chatRoles,
      messages: messagesForChat
    });
    if (overrideContent === undefined) {
      setInput("");
      setAttachments([]);
    }
    const startNow = Date.now();
    setRunning(true);
    setActiveRunId(undefined);
    setRunStartedAt(startNow);
    setAgentLogs([]);
    setRunTracker(newTracker(startNow));
    const chatWorkspacePath = chat.workspacePath || defaultWorkspacePath;
    upsertChat(chatWithUser);
    if (!isRetry) {
      await window.twoAgents.saveChat(chatWithUser);
    }

    let response: AgentRunResult;
    try {
      response = await window.twoAgents.runAgents({
        task: taskWithAttachments(displayContent, messageAttachments),
        conversationMessages: isRetry ? chat.messages.slice(0, -1) : chat.messages,
        roles: chatRoles,
        skills,
        workspacePath: chatWorkspacePath,
        maxIterations,
        executionMode: chatWorkspacePath ? executionMode : "read_only"
      });
    } catch (error) {
      // Defensive: the IPC handler already converts errors into a `failed` payload, but if
      // anything bubbles out anyway we still write an assistant message instead of leaving the
      // chat with an orphaned user message.
      response = {
        status: "failed",
        failureReason: error instanceof Error ? error.message : String(error),
        iterations: [],
        changedFiles: []
      };
    }

    try {
      // Snapshot the live tracker into the run result so historical chats keep the per-agent times.
      const finalTracker = trackerRef.current ? finalizeTracker(trackerRef.current) : undefined;
      // Capture the live log into the message so the user can scroll back through this run later.
      // Cap to the most recent 250 events to keep the on-disk chat file reasonable.
      const capturedLogs = agentLogsRef.current.slice(-250);
      const enriched: AgentRunResult = {
        ...response,
        timings: response.timings ?? trackerToTimings(finalTracker),
        runLogs: response.runLogs ?? capturedLogs
      };
      const assistantMessage = makeMessage("assistant", resultText(enriched), enriched);
      const finalChat = normalizeChatTitle({
        ...chatWithUser,
        messages: [...chatWithUser.messages, assistantMessage]
      });
      const saved = await window.twoAgents.saveChat(finalChat);
      upsertChat(saved);
      setActiveChatId(saved.id);
    } finally {
      setRunning(false);
      setActiveRunId(undefined);
      setRunStartedAt(undefined);
      setRunTracker(undefined);
      window.setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  async function cancelCurrentRun() {
    if (!running) {
      return;
    }
    try {
      await window.twoAgents.cancelAgents(activeRunId);
    } catch {
      /* swallow — cancel is best-effort */
    }
  }

  async function retryLastUserMessage() {
    const last = activeChat?.messages.at(-1);
    if (!last || last.role !== "user") {
      return;
    }
    await sendMessage(last.content, last.attachments ?? []);
  }

  async function applyPatch(diff?: string) {
    if (!activeWorkspacePath || !diff) {
      return;
    }
    const response = await window.twoAgents.applyPatch(activeWorkspacePath, diff);
    setNotice(response.message);
  }

  async function exportChatPdf() {
    if (!activeChat || activeChat.messages.length === 0) {
      setNotice("Nothing to export yet — send a message first.");
      return;
    }
    const html = buildChatPdfHtml(activeChat, activeRoles, activeWorkspacePath);
    const stem = activeChat.title?.trim() || "two-agents-chat";
    try {
      const result = await window.twoAgents.exportChatPdf({ suggestedFileName: stem, html });
      if (result.cancelled) {
        return;
      }
      if (result.ok && result.filePath) {
        setNotice(`Exported PDF to ${result.filePath}`);
      } else {
        setNotice(`Export failed: ${result.message ?? "unknown error"}`);
      }
    } catch (error) {
      setNotice(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function upsertChat(chat: ChatSession) {
    setChats((items) =>
      [chat, ...items.filter((item) => item.id !== chat.id)].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt)
      )
    );
  }

  async function saveMaxIterations(value: number) {
    const safeValue = Math.max(1, Math.min(value || 20, 20));
    setMaxIterations(safeValue);
    await window.twoAgents.saveSettings({
      defaultWorkspacePath,
      maxIterations: safeValue,
      skills,
      executionMode
    });
  }

  async function saveSkills(nextSkills: AgentSkill[]) {
    setSkills(nextSkills);
    await window.twoAgents.saveSettings({
      defaultWorkspacePath,
      maxIterations,
      skills: nextSkills,
      executionMode
    });
  }

  const showWelcome = !activeChat?.messages.length && !running;

  return (
    <main className="app-frame">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Sparkles size={18} />
          </div>
          <div>
            <div className="brand-name">Two Agents</div>
            <div className="brand-tag">Worker · Reviewer</div>
          </div>
        </div>

        <button className="new-chat" onClick={createChat}>
          <Plus size={16} />
          New chat
        </button>

        <div className="sidebar-section-label">Recent</div>
        <div className="history-list">
          {chats.length === 0 ? (
            <div className="history-empty">No chats yet.</div>
          ) : (
            chats.map((chat) => (
              <button
                key={chat.id}
                className={`history-item ${chat.id === activeChatId ? "active" : ""}`}
                onClick={() => {
                  setActiveChatId(chat.id);
                  setRoles(chat.roles ?? defaultRoles);
                  setAgentLogs([]);
                }}
              >
                <MessageSquare size={15} />
                <span title={chat.title}>{chat.title}</span>
                <span
                  className="history-delete"
                  role="button"
                  aria-label="Delete chat"
                  onClick={(event) => {
                    event.stopPropagation();
                    void deleteChat(chat.id);
                  }}
                >
                  <Trash2 size={14} />
                </span>
              </button>
            ))
          )}
        </div>

        <div className="sidebar-footer">
          <ProviderPill status={statusMap.get("openai")} />
          <ProviderPill status={statusMap.get("anthropic")} />
          <button className="sidebar-settings" onClick={() => setSettingsOpen((value) => !value)}>
            <Cog size={16} />
            <span>Settings</span>
          </button>
        </div>
      </aside>

      <section
        className={`chat-shell ${draggingFiles ? "dragging-files" : ""}`}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <header className="chat-topbar">
          <div className="topbar-title">
            <h1>{activeChat?.title ?? "New chat"}</h1>
            <p>
              <span className="role-chip role-worker">Worker · {providerShort[activeRoles.worker]}</span>
              <span className="role-chip role-reviewer">Reviewer · {providerShort[activeRoles.reviewer]}</span>
              {activeWorkspacePath ? (
                <span className="role-chip role-ws" title={activeWorkspacePath}>
                  <FolderOpen size={12} /> {shortPath(activeWorkspacePath)}
                </span>
              ) : null}
              <ExecutionModeChip
                mode={executionMode}
                hasWorkspace={Boolean(activeWorkspacePath)}
                onToggle={() =>
                  void saveExecutionMode(executionMode === "workspace_write" ? "read_only" : "workspace_write")
                }
                onPickWorkspace={() => void chooseChatWorkspace()}
              />
            </p>
          </div>
          <div className="topbar-actions">
            <button
              className="ghost-button"
              onClick={refreshStatuses}
              disabled={refreshing}
              title="Refresh provider status"
            >
              {refreshing ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
              <span>Status</span>
            </button>
            <button
              className="ghost-button"
              onClick={() => void exportChatPdf()}
              disabled={!activeChat || activeChat.messages.length === 0 || running}
              title={
                !activeChat || activeChat.messages.length === 0
                  ? "Nothing to export yet"
                  : running
                    ? "Wait for the run to finish before exporting"
                    : "Export this chat as a PDF"
              }
              aria-label="Export chat as PDF"
            >
              <FileDown size={16} />
              <span>Export PDF</span>
            </button>
            <button
              className={`ghost-button ${settingsOpen ? "active" : ""}`}
              onClick={() => setSettingsOpen((value) => !value)}
              title="Open settings"
            >
              <Cog size={16} />
              <span>Settings</span>
            </button>
          </div>
        </header>

        {settingsOpen ? (
          <SettingsDrawer
            statuses={statuses}
            onLogin={launchLogin}
            defaultWorkspacePath={defaultWorkspacePath}
            onChooseDefaultWorkspace={chooseDefaultWorkspace}
            activeWorkspacePath={activeWorkspacePath}
            onChooseChatWorkspace={chooseChatWorkspace}
            activeRoles={activeRoles}
            onSetWorker={(provider) => void setWorker(provider)}
            maxIterations={maxIterations}
            onMaxIterationsChange={(value) => setMaxIterations(value)}
            onMaxIterationsCommit={(value) => void saveMaxIterations(value)}
            skills={skills}
            onSkillsChange={(next) => void saveSkills(next)}
            executionMode={executionMode}
            onExecutionModeChange={(mode) => void saveExecutionMode(mode)}
            hasWorkspace={Boolean(activeWorkspacePath)}
            onClose={() => setSettingsOpen(false)}
          />
        ) : null}

        {notice ? (
          <div className="notice">
            <div className="notice-body">
              <strong>{notice}</strong>
              {loginResult?.url ? (
                <a href={loginResult.url} target="_blank" rel="noreferrer">
                  Open login link
                </a>
              ) : null}
              {loginResult?.deviceCode ? <code>{loginResult.deviceCode}</code> : null}
            </div>
            <button
              className="icon-button-bare"
              onClick={() => {
                setNotice(undefined);
                setLoginResult(undefined);
              }}
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
        ) : null}

        {draggingFiles ? (
          <div className="drop-overlay" aria-hidden="true">
            <div className="drop-target">
              <Paperclip size={20} />
              <span>Drop files to attach</span>
            </div>
          </div>
        ) : null}

        <section className="messages">
          {showWelcome ? (
            <WelcomePanel ready={ready} statuses={statuses} onOpenSettings={() => setSettingsOpen(true)} />
          ) : null}

          {activeChat?.messages.map((message) => (
            <MessageBlock
              key={message.id}
              message={message}
              roles={activeRoles}
              workspacePath={activeWorkspacePath}
              onApplyPatch={applyPatch}
            />
          ))}

          {running ? (
            <RunningPanel
              roles={activeRoles}
              logs={agentLogs}
              tracker={runTracker}
              startedAt={runStartedAt}
              maxIterations={maxIterations}
              onCancel={() => void cancelCurrentRun()}
              onClearLogs={() => setAgentLogs([])}
              cancelling={Boolean(activeRunId === undefined && running && runStartedAt && Date.now() - runStartedAt > 60_000)}
            />
          ) : null}

          {!running && hasOrphanedUserMessage(activeChat) ? (
            <StaleTailBanner onRetry={() => void retryLastUserMessage()} />
          ) : null}

          {!running && pendingClarification(activeChat) ? (
            <ClarificationPrompt
              question={pendingClarification(activeChat)?.question ?? ""}
              suggestions={pendingClarification(activeChat)?.suggestions ?? []}
              onSubmit={(answer) => void sendMessage(answer)}
              onPick={(text) => setInput(text)}
            />
          ) : null}

          <div ref={bottomRef} />
        </section>

        <footer className="composer-bar">
          <div className="composer-shell">
            <input
              ref={fileInputRef}
              className="file-input"
              type="file"
              multiple
              onChange={(event) => {
                void attachFiles(event.currentTarget.files ?? []);
                event.currentTarget.value = "";
              }}
              tabIndex={-1}
            />
            {attachments.length ? (
              <div className="attachment-tray" aria-label="Attached files">
                {attachments.map((attachment) => (
                  <AttachmentChip
                    key={attachment.id}
                    attachment={attachment}
                    onRemove={() => removeAttachment(attachment.id)}
                  />
                ))}
              </div>
            ) : null}
            <textarea
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  void sendMessage();
                }
              }}
              disabled={!ready || running}
              placeholder={
                ready
                  ? activeChat?.messages.length
                    ? "Ask a follow-up — every response is reviewed."
                    : "Ask a question or describe a task — the worker drafts, the reviewer checks."
                  : "Connect both agents in Settings to begin."
              }
              rows={1}
            />
            <div className="composer-actions">
              <div className="composer-left-actions">
                <button
                  className="icon-button-soft"
                  onClick={() => void chooseAttachments()}
                  disabled={!canAttach}
                  title="Attach files"
                  aria-label="Attach files"
                >
                  <Paperclip size={16} />
                </button>
                <span className="composer-hint">⌘ + Return to send</span>
              </div>
              <button
                className="primary-button"
                onClick={() => void sendMessage()}
                disabled={!canSend}
                title={ready ? "Send reviewed turn" : "Connect both agents first"}
              >
                {running ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
                <span>{running ? "Working" : "Send"}</span>
              </button>
            </div>
          </div>
        </footer>
      </section>
    </main>
  );
}

function pendingClarification(chat?: ChatSession): { question: string; suggestions: string[] } | undefined {
  if (!chat || chat.messages.length === 0) return undefined;
  const last = chat.messages[chat.messages.length - 1];
  if (last.role !== "assistant") return undefined;
  const result = last.result;
  if (!result || result.status !== "clarification_needed") return undefined;
  const question = result.clarificationQuestion?.trim();
  if (!question) return undefined;
  const suggestions = (result.clarificationSuggestions ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length < 120);
  return { question, suggestions };
}

function ClarificationPrompt({
  question,
  suggestions,
  onSubmit,
  onPick
}: {
  question: string;
  suggestions: string[];
  onSubmit: (answer: string) => void;
  onPick: (text: string) => void;
}) {
  const [reply, setReply] = useState("");
  return (
    <div className="clarification-card">
      <div className="clarification-head">
        <MessageSquare size={16} />
        <strong>The agents need a quick answer from you</strong>
      </div>
      <pre className="clarification-question">{question}</pre>
      {suggestions.length > 0 ? (
        <div className="clarification-chips">
          {suggestions.map((suggestion, i) => (
            <button
              type="button"
              key={`${i}-${suggestion}`}
              className="clarification-chip"
              onClick={() => onSubmit(suggestion)}
              title={`Send: ${suggestion}`}
            >
              {suggestion}
            </button>
          ))}
          {suggestions.map((suggestion, i) => (
            <button
              type="button"
              key={`edit-${i}-${suggestion}`}
              className="clarification-chip-edit"
              onClick={() => onPick(suggestion)}
              title="Place this in the composer to edit before sending"
            >
              Edit “{shortDetail(suggestion)}”
            </button>
          ))}
        </div>
      ) : null}
      <div className="clarification-reply">
        <textarea
          rows={2}
          placeholder="Type a free-form answer…"
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              const trimmed = reply.trim();
              if (trimmed) {
                onSubmit(trimmed);
                setReply("");
              }
            }
          }}
        />
        <button
          type="button"
          className="primary-button"
          disabled={!reply.trim()}
          onClick={() => {
            const trimmed = reply.trim();
            if (trimmed) {
              onSubmit(trimmed);
              setReply("");
            }
          }}
        >
          <Send size={14} />
          <span>Send reply</span>
        </button>
      </div>
    </div>
  );
}

function hasOrphanedUserMessage(chat?: ChatSession) {
  if (!chat || chat.messages.length === 0) {
    return false;
  }
  return chat.messages[chat.messages.length - 1].role === "user";
}

function StaleTailBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="stale-tail">
      <AlertTriangle size={16} />
      <div>
        <strong>This message hasn't been answered yet.</strong>
        <span className="muted small">
          The previous run was interrupted or failed. Retry to ask the agents again — your message
          won't be duplicated.
        </span>
      </div>
      <button className="ghost-button" onClick={onRetry}>
        <RefreshCw size={14} />
        <span>Retry</span>
      </button>
    </div>
  );
}

function ProviderPill({ status }: { status?: ProviderStatus }) {
  const healthy = Boolean(status?.installed && status?.loggedIn);
  const label = status?.label ?? "Provider";
  const detail = !status?.installed
    ? "Not installed"
    : !status.loggedIn
      ? "Not signed in"
      : "Connected";
  return (
    <div className={`provider-pill ${healthy ? "ok" : "warn"}`} title={status?.detail ?? ""}>
      <span className="provider-dot" />
      <span className="provider-pill-label">{label}</span>
      <span className="provider-pill-detail">{detail}</span>
    </div>
  );
}

function SettingsDrawer({
  statuses,
  onLogin,
  defaultWorkspacePath,
  onChooseDefaultWorkspace,
  activeWorkspacePath,
  onChooseChatWorkspace,
  activeRoles,
  onSetWorker,
  maxIterations,
  onMaxIterationsChange,
  onMaxIterationsCommit,
  skills,
  onSkillsChange,
  executionMode,
  onExecutionModeChange,
  hasWorkspace,
  onClose
}: {
  statuses: ProviderStatus[];
  onLogin: (provider: ProviderId) => void;
  defaultWorkspacePath?: string;
  onChooseDefaultWorkspace: () => void;
  activeWorkspacePath?: string;
  onChooseChatWorkspace: () => void;
  activeRoles: RoleSelection;
  onSetWorker: (provider: ProviderId) => void;
  maxIterations: number;
  onMaxIterationsChange: (value: number) => void;
  onMaxIterationsCommit: (value: number) => void;
  skills: AgentSkill[];
  onSkillsChange: (skills: AgentSkill[]) => void;
  executionMode: ExecutionMode;
  onExecutionModeChange: (mode: ExecutionMode) => void;
  hasWorkspace: boolean;
  onClose: () => void;
}) {
  const statusMap = new Map(statuses.map((status) => [status.provider, status]));
  return (
    <section className="settings-drawer">
      <div className="settings-head">
        <strong>Workspace settings</strong>
        <button className="icon-button-bare" onClick={onClose} aria-label="Close settings">
          <X size={16} />
        </button>
      </div>

      <div className="settings-grid two">
        <ProviderPanel status={statusMap.get("openai")} onLogin={() => onLogin("openai")} />
        <ProviderPanel status={statusMap.get("anthropic")} onLogin={() => onLogin("anthropic")} />
      </div>

      <div className="settings-grid two">
        <div className="role-panel">
          <span className="label">Worker / reviewer for this chat</span>
          <div className="segmented">
            <button
              className={activeRoles.worker === "openai" ? "active" : ""}
              onClick={() => onSetWorker("openai")}
            >
              Codex worker · Claude reviewer
            </button>
            <button
              className={activeRoles.worker === "anthropic" ? "active" : ""}
              onClick={() => onSetWorker("anthropic")}
            >
              Claude worker · Codex reviewer
            </button>
          </div>
        </div>

        <div className="iteration-panel">
          <label htmlFor="maxIterations">Max review iterations</label>
          <input
            id="maxIterations"
            type="number"
            min={1}
            max={20}
            value={maxIterations}
            onChange={(event) => onMaxIterationsChange(Number(event.target.value))}
            onBlur={(event) => onMaxIterationsCommit(Number(event.target.value))}
          />
          <span className="muted small">Cap on worker ↔ reviewer back-and-forth before stopping.</span>
        </div>
      </div>

      <div className="settings-grid two">
        <div className="workspace-strip">
          <div>
            <span className="label">Default workspace for new chats</span>
            <strong title={defaultWorkspacePath}>{defaultWorkspacePath || "No default folder selected"}</strong>
          </div>
          <button className="ghost-button" onClick={onChooseDefaultWorkspace}>
            <FolderOpen size={16} />
            <span>Choose</span>
          </button>
        </div>
        <div className="workspace-strip">
          <div>
            <span className="label">Workspace for this chat</span>
            <strong title={activeWorkspacePath}>{activeWorkspacePath || "Inheriting default"}</strong>
          </div>
          <button className="ghost-button" onClick={onChooseChatWorkspace}>
            <FolderOpen size={16} />
            <span>Choose</span>
          </button>
        </div>
      </div>

      <ExecutionModePanel
        mode={executionMode}
        hasWorkspace={hasWorkspace}
        onChange={onExecutionModeChange}
      />

      <SkillSettings skills={skills} onChange={onSkillsChange} />
    </section>
  );
}

function ExecutionModePanel({
  mode,
  hasWorkspace,
  onChange
}: {
  mode: ExecutionMode;
  hasWorkspace: boolean;
  onChange: (mode: ExecutionMode) => void;
}) {
  const effectiveMode: ExecutionMode = mode === "workspace_write" && hasWorkspace ? "workspace_write" : "read_only";
  const writeAllowed = effectiveMode === "workspace_write";
  return (
    <section className={`execution-panel ${writeAllowed ? "write" : "read"}`}>
      <div className="execution-head">
        <div className={`execution-icon ${writeAllowed ? "write" : "read"}`}>
          {writeAllowed ? <ShieldAlert size={16} /> : <ShieldCheck size={16} />}
        </div>
        <div>
          <strong>Workspace permissions</strong>
          <span className="muted small">
            Controls whether the agents may create files, edit files, and run commands inside the chat's workspace.
          </span>
        </div>
      </div>
      <div className="segmented">
        <button
          className={mode === "read_only" ? "active" : ""}
          onClick={() => onChange("read_only")}
        >
          Read-only · Propose diffs
        </button>
        <button
          className={mode === "workspace_write" ? "active" : ""}
          onClick={() => onChange("workspace_write")}
          disabled={!hasWorkspace}
          title={hasWorkspace ? undefined : "Choose a workspace to enable write mode"}
        >
          Workspace write · Create / edit / run
        </button>
      </div>
      {mode === "workspace_write" && !hasWorkspace ? (
        <p className="execution-warning">
          <AlertTriangle size={14} /> Choose a workspace before enabling write mode. Falls back to
          read-only otherwise.
        </p>
      ) : writeAllowed ? (
        <p className="execution-warning">
          <AlertTriangle size={14} /> Agents may modify files and execute shell commands inside the
          workspace. Use a clean branch and review changes carefully.
        </p>
      ) : (
        <p className="muted small">
          Agents will read the workspace but only return a unified diff for you to apply manually.
        </p>
      )}
    </section>
  );
}

function ExecutionModeChip({
  mode,
  hasWorkspace,
  onToggle,
  onPickWorkspace
}: {
  mode: ExecutionMode;
  hasWorkspace: boolean;
  onToggle: () => void;
  onPickWorkspace: () => void;
}) {
  const writeAllowed = mode === "workspace_write" && hasWorkspace;
  if (!hasWorkspace) {
    return (
      <button
        type="button"
        className="role-chip role-warn role-chip-button"
        onClick={onPickWorkspace}
        title="Choose a workspace folder to enable file create / edit / run."
      >
        <AlertTriangle size={12} /> No workspace · read-only
      </button>
    );
  }
  if (writeAllowed) {
    return (
      <button
        type="button"
        className="role-chip role-write role-chip-button"
        onClick={onToggle}
        title="Agents can create and edit files and run commands in this workspace. Click to switch back to read-only."
      >
        <ShieldAlert size={12} /> Workspace write — click to disable
      </button>
    );
  }
  return (
    <button
      type="button"
      className="role-chip role-read role-chip-button"
      onClick={onToggle}
      title="Read-only: agents only propose diffs; they cannot touch your files. Click to allow them to create / edit files and run commands."
    >
      <ShieldCheck size={12} /> Read-only — click to enable file write &amp; run
    </button>
  );
}

function SkillSettings({
  skills,
  onChange
}: {
  skills: AgentSkill[];
  onChange: (skills: AgentSkill[]) => void;
}) {
  function updateSkill(id: string, patch: Partial<AgentSkill>) {
    onChange(skills.map((skill) => (skill.id === id ? { ...skill, ...patch } : skill)));
  }

  function addSkill() {
    onChange([
      ...skills,
      {
        id: crypto.randomUUID(),
        name: "New skill",
        instructions: "",
        target: "both",
        enabled: true
      }
    ]);
  }

  function removeSkill(id: string) {
    onChange(skills.filter((skill) => skill.id !== id));
  }

  return (
    <section className="skills-panel">
      <div className="section-head">
        <strong>Skills</strong>
        <button className="ghost-button" onClick={addSkill}>
          <Plus size={14} />
          <span>Add skill</span>
        </button>
      </div>
      {skills.length === 0 ? (
        <p className="muted-panel">
          Reusable instructions you can attach to the worker, reviewer, or both for every run.
        </p>
      ) : null}
      <div className="skill-list">
        {skills.map((skill) => (
          <article className="skill-card" key={skill.id}>
            <div className="skill-card-head">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={skill.enabled}
                  onChange={(event) => updateSkill(skill.id, { enabled: event.target.checked })}
                />
                <span>Enabled</span>
              </label>
              <select
                value={skill.target}
                onChange={(event) =>
                  updateSkill(skill.id, { target: event.target.value as AgentSkillTarget })
                }
              >
                <option value="both">Worker + reviewer</option>
                <option value="worker">Worker only</option>
                <option value="reviewer">Reviewer only</option>
              </select>
              <button
                className="danger-button"
                onClick={() => removeSkill(skill.id)}
                title="Delete skill"
                aria-label="Delete skill"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <input
              aria-label="Skill name"
              className="skill-name"
              value={skill.name}
              onChange={(event) => updateSkill(skill.id, { name: event.target.value })}
              placeholder="Skill name"
            />
            <textarea
              value={skill.instructions}
              onChange={(event) => updateSkill(skill.id, { instructions: event.target.value })}
              placeholder="Describe what this skill should make the selected agent do..."
            />
          </article>
        ))}
      </div>
    </section>
  );
}

function ProviderPanel({ status, onLogin }: { status?: ProviderStatus; onLogin: () => void }) {
  const healthy = Boolean(status?.installed && status?.loggedIn);
  return (
    <article className={`provider-panel ${healthy ? "ok" : "warn"}`}>
      <div className="provider-title">
        <div className={`provider-icon ${healthy ? "ok" : "warn"}`}>
          {healthy ? <Check size={16} /> : <CircleAlert size={16} />}
        </div>
        <div>
          <strong>{status?.label ?? "Checking provider"}</strong>
          <span className="muted small">{status?.version || status?.command || "Detecting CLI..."}</span>
        </div>
      </div>
      <p className="muted small">{status?.detail ?? "Reading local CLI status."}</p>
      <button className="ghost-button" onClick={onLogin}>
        <KeyRound size={15} />
        <span>{healthy ? "Re-authenticate" : "Login"}</span>
      </button>
    </article>
  );
}

function WelcomePanel({
  ready,
  statuses,
  onOpenSettings
}: {
  ready: boolean;
  statuses: ProviderStatus[];
  onOpenSettings: () => void;
}) {
  return (
    <div className="welcome-panel">
      <div className="welcome-mark">
        <Sparkles size={22} />
      </div>
      <h2>Two reviewers on every answer.</h2>
      <p>
        Ask anything. The worker drafts, the reviewer checks for correctness — and we only show you the
        final, reviewed answer. Conversations carry context across follow-ups.
      </p>
      {!ready ? (
        <div className="welcome-warning">
          <AlertTriangle size={16} />
          <div>
            Connect both agents to start.{" "}
            {statuses.length === 0 ? "Detecting CLIs..." : "Open Settings → Login for any provider that's not connected."}
          </div>
          <button className="ghost-button" onClick={onOpenSettings}>
            Open Settings
          </button>
        </div>
      ) : (
        <ul className="welcome-tips">
          <li>Use ⌘ + Return to send.</li>
          <li>Pick a workspace to allow code reviews against your repo.</li>
          <li>If one agent runs out of credit, the other carries the turn through.</li>
        </ul>
      )}
    </div>
  );
}

function RunningPanel({
  roles,
  logs,
  tracker,
  startedAt,
  maxIterations,
  onCancel,
  onClearLogs,
  cancelling
}: {
  roles: RoleSelection;
  logs: AgentLogEvent[];
  tracker?: RunTracker;
  startedAt?: number;
  maxIterations: number;
  onCancel: () => void;
  onClearLogs: () => void;
  cancelling?: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const userScrolledRef = useRef<boolean>(false);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);

  // Auto-follow the bottom unless the user has scrolled up themselves.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 80 || !userScrolledRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs.length]);

  const totalElapsedMs = startedAt ? Math.max(0, now - startedAt) : 0;
  const currentIteration = tracker?.currentIteration ?? 1;

  const phaseElapsedMs = tracker?.phaseStartedAt ? now - tracker.phaseStartedAt : 0;
  const liveWorkerMs = (tracker?.workerTotalMs ?? 0) + (tracker?.currentPhase === "worker" ? phaseElapsedMs : 0);
  const liveReviewerMs = (tracker?.reviewerTotalMs ?? 0) + (tracker?.currentPhase === "reviewer" ? phaseElapsedMs : 0);

  const workerProvider = tracker?.iterations.find((i) => i.workerProvider)?.workerProvider ?? roles.worker;
  const reviewerProvider = tracker?.iterations.find((i) => i.reviewerProvider)?.reviewerProvider ?? roles.reviewer;

  const workerActive = tracker?.currentPhase === "worker";
  const reviewerActive = tracker?.currentPhase === "reviewer";

  return (
    <div className={`running-panel ${expanded ? "expanded" : ""}`}>
      <div className="running-panel-head">
        <div className="iter-pill">
          <Loader2 size={14} className="spin" />
          <span>Iteration {currentIteration} / {maxIterations}</span>
        </div>
        <div className="run-total-clock" title="Total elapsed">{formatElapsedMs(totalElapsedMs)}</div>
        <button
          className="ghost-button danger-ghost"
          onClick={onCancel}
          disabled={cancelling}
          title="Stop the run and show the latest worker draft"
        >
          {cancelling ? <Loader2 size={14} className="spin" /> : <X size={14} />}
          <span>{cancelling ? "Stopping" : "Stop"}</span>
        </button>
      </div>

      <div className="agent-rows">
        <AgentRow
          role="Worker"
          provider={workerProvider}
          active={workerActive}
          phaseLabel={workerActive ? "drafting" : tracker?.iterations.length ? "idle" : "queued"}
          phaseElapsedMs={workerActive ? phaseElapsedMs : undefined}
          totalMs={liveWorkerMs}
          detail={workerActive ? tracker?.lastDetail : undefined}
        />
        <AgentRow
          role="Reviewer"
          provider={reviewerProvider}
          active={reviewerActive}
          phaseLabel={reviewerActive ? "reviewing" : tracker?.iterations.some((i) => i.reviewerMs) ? "idle" : "queued"}
          phaseElapsedMs={reviewerActive ? phaseElapsedMs : undefined}
          totalMs={liveReviewerMs}
          detail={reviewerActive ? tracker?.lastDetail : undefined}
        />
      </div>

      <div className="activity-section">
        <div className="activity-head">
          <span className="activity-title">Live activity</span>
          <span className="activity-count muted small">{logs.length} event{logs.length === 1 ? "" : "s"}</span>
          <span className="activity-spacer" />
          <button className="icon-button-bare" onClick={onClearLogs} title="Clear log buffer">
            Clear
          </button>
          <button className="icon-button-bare" onClick={() => setExpanded((v) => !v)} title={expanded ? "Collapse" : "Expand"}>
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
        <div
          className="activity-body"
          ref={scrollRef}
          onScroll={() => {
            const el = scrollRef.current;
            if (!el) return;
            const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
            userScrolledRef.current = distanceFromBottom > 80;
          }}
        >
          {logs.length === 0 ? (
            <div className="activity-empty muted small">Waiting for the agent to log something…</div>
          ) : (
            logs.map((log, index) => <LogLine key={`${log.timestamp}-${index}`} log={log} />)
          )}
        </div>
      </div>

      {tracker && tracker.iterations.length > 0 ? (
        <div className="iteration-strip">
          {tracker.iterations.map((entry) => (
            <div className="iteration-cell" key={entry.iteration}>
              <span className="iteration-label">#{entry.iteration}</span>
              <span className="iteration-times">
                <span title="Worker time">W {formatMs(entry.workerMs)}</span>
                <span title="Reviewer time">R {formatMs(entry.reviewerMs)}</span>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AgentRow({
  role,
  provider,
  active,
  phaseLabel,
  phaseElapsedMs,
  totalMs,
  detail
}: {
  role: "Worker" | "Reviewer";
  provider: ProviderId;
  active: boolean;
  phaseLabel: string;
  phaseElapsedMs?: number;
  totalMs: number;
  detail?: string;
}) {
  return (
    <div className={`agent-row ${active ? "active" : ""}`}>
      <div className={`agent-dot ${active ? "active" : ""}`} aria-hidden>
        {active ? <Loader2 size={10} className="spin" /> : null}
      </div>
      <div className="agent-name-block">
        <strong>{providerNames[provider]}</strong>
        <span className="agent-role-tag">{role}</span>
      </div>
      <div className="agent-status">
        <span className={`agent-phase ${active ? "active" : ""}`}>{phaseLabel}</span>
        {detail ? <span className="agent-detail" title={detail}>{shortDetail(detail)}</span> : null}
      </div>
      <div className="agent-clocks">
        {phaseElapsedMs != null ? (
          <span className="agent-phase-clock" title="Current phase">{formatElapsedMs(phaseElapsedMs)}</span>
        ) : null}
        <span className="agent-total-clock" title="Cumulative time across iterations">{formatElapsedMs(totalMs)}</span>
      </div>
    </div>
  );
}

function SavedLogViewer({ logs }: { logs: AgentLogEvent[] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="saved-log">
      <div className="saved-log-head">
        <span className="muted small">{logs.length} event{logs.length === 1 ? "" : "s"} captured during this run.</span>
        <button className="icon-button-bare" onClick={() => setExpanded((v) => !v)} title={expanded ? "Collapse" : "Expand"}>
          {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      </div>
      <div className={`saved-log-body ${expanded ? "expanded" : ""}`}>
        {logs.map((log, i) => (
          <LogLine key={`${log.timestamp}-${i}`} log={log} />
        ))}
      </div>
    </div>
  );
}

function LogLine({ log }: { log: AgentLogEvent }) {
  const sourceClass = `source-${log.source.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <div className={`log-line ${sourceClass}`}>
      <span className="log-time">{formatLogTime(log.timestamp)}</span>
      <span className="log-source">{log.source}</span>
      <span className="log-message">{log.message}</span>
    </div>
  );
}

function shortDetail(detail: string) {
  const oneLine = detail.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 70) return oneLine;
  return `${oneLine.slice(0, 67)}…`;
}

function formatLogTime(iso: string): string {
  try {
    const d = new Date(iso);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return "";
  }
}

function pad(n: number) {
  return n.toString().padStart(2, "0");
}

function formatElapsedMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function formatMs(ms?: number): string {
  if (ms == null) return "—";
  return formatElapsedMs(ms);
}

function MessageBlock({
  message,
  roles,
  workspacePath,
  onApplyPatch
}: {
  message: ChatMessage;
  roles: RoleSelection;
  workspacePath?: string;
  onApplyPatch: (diff?: string) => void;
}) {
  const isUser = message.role === "user";
  return (
    <article className={`bubble-row ${isUser ? "user" : "assistant"}`}>
      <div className="bubble-avatar" aria-hidden="true">
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>
      <div className="bubble-stack">
        <div className="bubble-meta">
          <span>{isUser ? "You" : "Reviewed answer"}</span>
          <span className="muted small">{formatTime(message.createdAt)}</span>
        </div>
        <div className={`bubble ${isUser ? "user" : "assistant"}`}>
          <MessageContent content={message.content} />
          {message.attachments?.length ? <MessageAttachments attachments={message.attachments} /> : null}
        </div>
        {!isUser && message.result ? (
          <AssistantExtras
            result={message.result}
            roles={roles}
            workspacePath={workspacePath}
            onApplyPatch={onApplyPatch}
          />
        ) : null}
      </div>
    </article>
  );
}

function MessageAttachments({ attachments }: { attachments: ChatAttachment[] }) {
  return (
    <div className="message-attachments" aria-label="Attached files">
      {attachments.map((attachment) => (
        <div className="message-attachment" key={attachment.id} title={attachment.path}>
          <FileText size={14} />
          <span>{attachment.name}</span>
          <small>{formatBytes(attachment.size)}</small>
        </div>
      ))}
    </div>
  );
}

function AttachmentChip({
  attachment,
  onRemove
}: {
  attachment: ChatAttachment;
  onRemove: () => void;
}) {
  return (
    <div className={`attachment-chip ${attachment.error ? "warn" : ""}`} title={attachment.path}>
      <FileText size={14} />
      <span>{attachment.name}</span>
      <small>{attachment.error || formatBytes(attachment.size)}</small>
      <button className="icon-button-bare" onClick={onRemove} aria-label={`Remove ${attachment.name}`}>
        <X size={13} />
      </button>
    </div>
  );
}

function AssistantExtras({
  result,
  roles,
  workspacePath,
  onApplyPatch
}: {
  result: AgentRunResult;
  roles: RoleSelection;
  workspacePath?: string;
  onApplyPatch: (diff?: string) => void;
}) {
  const timings = result.timings;
  return (
    <div className="assistant-extras">
      <div className="status-row">
        <StatusBadge status={result.status} />
        {result.iterations.length ? (
          <span className="muted small">
            {result.iterations.length} iteration{result.iterations.length === 1 ? "" : "s"}
          </span>
        ) : null}
        {result.changedFiles.length ? (
          <span className="muted small">
            {result.changedFiles.length} file{result.changedFiles.length === 1 ? "" : "s"} changed
          </span>
        ) : null}
        {timings ? (
          <span className="muted small">
            ⏱ total {formatElapsedMs((timings.finishedAt ?? Date.now()) - timings.startedAt)} ·
            {" "}worker {formatElapsedMs(timings.workerTotalMs)} · reviewer {formatElapsedMs(timings.reviewerTotalMs)}
          </span>
        ) : null}
      </div>
      {result.skippedAgents?.length
        ? result.skippedAgents.map((skipped) => <SkippedNotice key={`${skipped.provider}-${skipped.role}`} skipped={skipped} />)
        : null}
      {result.failureReason ? (
        <Collapsible title="Raw failure output" defaultOpen={false}>
          <pre className="code-block">{result.failureReason}</pre>
        </Collapsible>
      ) : null}
      {timings && timings.iterations.length > 0 ? (
        <Collapsible title="Per-iteration timings" defaultOpen={false}>
          <div className="timing-table">
            <div className="timing-row head">
              <span>#</span>
              <span>Worker</span>
              <span>time</span>
              <span>Reviewer</span>
              <span>time</span>
            </div>
            {timings.iterations.map((entry) => (
              <div className="timing-row" key={entry.iteration}>
                <span>{entry.iteration}</span>
                <span>{entry.workerProvider ? providerNames[entry.workerProvider] : "—"}</span>
                <span className="mono">{formatMs(entry.workerMs)}</span>
                <span>{entry.reviewerProvider ? providerNames[entry.reviewerProvider] : "—"}</span>
                <span className="mono">{formatMs(entry.reviewerMs)}</span>
              </div>
            ))}
          </div>
        </Collapsible>
      ) : null}
      {result.runLogs && result.runLogs.length > 0 ? (
        <Collapsible title={`Run logs (${result.runLogs.length} event${result.runLogs.length === 1 ? "" : "s"})`} defaultOpen={false}>
          <SavedLogViewer logs={result.runLogs} />
        </Collapsible>
      ) : null}
      <Collapsible title="Review trail" defaultOpen={false}>
        <div className="run-details">
          {result.iterations.map((iteration) => (
            <details key={iteration.iteration}>
              <summary>
                Pass {iteration.iteration} ·{" "}
                <span className="muted">{iteration.reviewerDecision.replaceAll("_", " ")}</span>
              </summary>
              <h4>Worker output</h4>
              <pre className="code-block">{iteration.workerOutput}</pre>
              <h4>Reviewer feedback</h4>
              <pre className="code-block">{iteration.reviewerFeedback}</pre>
            </details>
          ))}
        </div>
      </Collapsible>
      {result.brief ? (
        <Collapsible title="Refined brief" defaultOpen={false}>
          <div className="run-details">
            <details open>
              <summary>Task summary</summary>
              <pre className="code-block">{result.brief.summary}</pre>
            </details>
            <details>
              <summary>Worker prompt — {providerNames[roles.worker]}</summary>
              <pre className="code-block">{result.brief.workerPrompt}</pre>
            </details>
            <details>
              <summary>Reviewer prompt — {providerNames[roles.reviewer]}</summary>
              <pre className="code-block">{result.brief.reviewerPrompt}</pre>
            </details>
          </div>
        </Collapsible>
      ) : null}
      {result.proposedDiff ? (
        <Collapsible title={`Proposed diff${workspacePath ? "" : " (no workspace selected)"}`} defaultOpen={false}>
          <div className="diff-block">
            <div className="diff-actions">
              <button
                className="primary-button"
                disabled={result.status !== "approved" || !workspacePath}
                onClick={() => onApplyPatch(result.proposedDiff)}
              >
                Apply approved patch
              </button>
              {result.changedFiles.length ? (
                <span className="muted small">{result.changedFiles.join(", ")}</span>
              ) : null}
            </div>
            <pre className="code-block">{result.proposedDiff}</pre>
          </div>
        </Collapsible>
      ) : null}
    </div>
  );
}

function SkippedNotice({ skipped }: { skipped: SkippedAgent }) {
  const isTimeout = /timed?\s*out|timeout|did\s+not\s+finish/i.test(skipped.reason);
  return (
    <div className="skipped-notice">
      <AlertTriangle size={14} />
      <div>
        <strong>
          {providerNames[skipped.provider]} {skipped.role} skipped
          {isTimeout ? " (timed out)" : ""}
        </strong>
        <span className="muted small">
          {skipped.role === "worker"
            ? isTimeout
              ? "Took too long — handed the turn to the other agent."
              : "Credits/quota exhausted — handed the turn to the other agent."
            : isTimeout
              ? "Took too long — using the worker's output as the final answer."
              : "Credits/quota exhausted — using the worker's output as the final answer."}
        </span>
        <span className="muted small skipped-reason" title={skipped.reason}>
          {skipped.reason}
        </span>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: AgentRunResult["status"] }) {
  const map: Record<AgentRunResult["status"], { label: string; tone: string }> = {
    approved: { label: "Approved", tone: "ok" },
    clarification_needed: { label: "Needs clarification", tone: "info" },
    blocked: { label: "Blocked", tone: "warn" },
    max_iterations: { label: "Max iterations", tone: "warn" },
    failed: { label: "Failed", tone: "warn" }
  };
  const entry = map[status] ?? { label: status, tone: "info" };
  return <span className={`status-badge ${entry.tone}`}>{entry.label}</span>;
}

function Collapsible({
  title,
  children,
  defaultOpen
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  return (
    <div className={`collapsible ${open ? "open" : ""}`}>
      <button className="collapsible-head" onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>{title}</span>
      </button>
      {open ? <div className="collapsible-body">{children}</div> : null}
    </div>
  );
}

function MessageContent({ content }: { content: string }) {
  // Split out fenced code blocks so we can render them with monospace styling.
  const parts = useMemo(() => splitContent(content), [content]);
  return (
    <div className="message-content">
      {parts.map((part, index) =>
        part.type === "code" ? (
          <pre className="code-block inline" key={index}>
            {part.value}
          </pre>
        ) : (
          <p className="message-text" key={index}>
            {part.value}
          </p>
        )
      )}
    </div>
  );
}

type ContentPart = { type: "text"; value: string } | { type: "code"; value: string };

function splitContent(content: string): ContentPart[] {
  if (!content) {
    return [{ type: "text", value: "" }];
  }
  const parts: ContentPart[] = [];
  const regex = /```([\s\S]*?)```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match.index > cursor) {
      const text = content.slice(cursor, match.index).trim();
      if (text) {
        parts.push({ type: "text", value: text });
      }
    }
    const inner = match[1].replace(/^[a-zA-Z0-9_+-]+\n/, "").trimEnd();
    parts.push({ type: "code", value: inner });
    cursor = match.index + match[0].length;
  }
  if (cursor < content.length) {
    const tail = content.slice(cursor).trim();
    if (tail) {
      parts.push({ type: "text", value: tail });
    }
  }
  if (parts.length === 0) {
    parts.push({ type: "text", value: content });
  }
  return parts;
}

function makeMessage(
  role: ChatMessage["role"],
  content: string,
  result?: AgentRunResult,
  attachments?: ChatAttachment[]
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    attachments: attachments?.length ? attachments : undefined,
    result,
    createdAt: new Date().toISOString()
  };
}

function mergeAttachments(current: ChatAttachment[], selected: ChatAttachment[]): ChatAttachment[] {
  const byPath = new Map(current.map((attachment) => [attachment.path, attachment]));
  for (const attachment of selected) {
    byPath.set(attachment.path, attachment);
  }
  return [...byPath.values()].slice(0, 10);
}

async function readFileAttachment(file: File): Promise<ChatAttachment> {
  const maxBytes = 1_000_000;
  const bytes = new Uint8Array(await file.slice(0, maxBytes).arrayBuffer());
  const hasBinaryBytes = bytes.includes(0);
  const fileWithOptionalPath = file as File & { path?: string };
  const path = fileWithOptionalPath.path || file.webkitRelativePath || file.name;
  return {
    id: crypto.randomUUID(),
    name: file.name,
    path,
    size: file.size,
    content: hasBinaryBytes ? undefined : new TextDecoder("utf-8").decode(bytes),
    truncated: file.size > maxBytes,
    error: hasBinaryBytes ? "Binary file attached by name only." : undefined
  };
}

function hasDraggedFiles(event: React.DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function sameAttachments(a: ChatAttachment[] | undefined, b: ChatAttachment[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((attachment, index) => attachment.path === right[index]?.path);
}

function taskWithAttachments(content: string, attachments: ChatAttachment[]): string {
  if (!attachments.length) {
    return content;
  }
  let remainingContentChars = 180_000;
  const sections = attachments.map((attachment, index) => {
    const embeddedContent = attachment.content?.slice(0, Math.max(0, remainingContentChars));
    remainingContentChars -= embeddedContent?.length ?? 0;
    const clippedForPrompt = Boolean(attachment.content && embeddedContent !== attachment.content);
    const header = [
      `Attachment ${index + 1}: ${attachment.name}`,
      `Path: ${attachment.path}`,
      `Size: ${formatBytes(attachment.size)}`,
      attachment.truncated ? "Note: stored content was truncated to the first 1 MB." : undefined,
      clippedForPrompt ? "Note: content was clipped in this prompt to fit the chat request limit." : undefined,
      attachment.error ? `Note: ${attachment.error}` : undefined
    ]
      .filter(Boolean)
      .join("\n");
    const body = embeddedContent
      ? `\n\nContent:\n\`\`\`\n${embeddedContent}\n\`\`\``
      : "\n\nContent was not embedded. Use the path above only if it is inside the selected workspace.";
    return `${header}${body}`;
  });
  return `${content}\n\nAttached files:\n\n${sections.join("\n\n---\n\n")}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function resultText(result: AgentRunResult) {
  if (result.finalAnswer) {
    return result.finalAnswer;
  }
  if (result.clarificationQuestion) {
    return result.clarificationQuestion;
  }
  if (result.failureReason) {
    return summarizeFailure(result.failureReason);
  }
  return "The run completed without a final answer.";
}

export function summarizeFailure(raw: string): string {
  const text = raw.trim();
  if (!text) {
    return "The run failed without a reason.";
  }
  const lower = text.toLowerCase();
  const usagePatterns = [
    /usage\s+limit/i,
    /credit\s+(balance|exhaust|exceed)/i,
    /\bquota\b/i,
    /payment\s+required/i,
    /\b402\b/,
    /rate\s+limit/i,
    /out\s+of\s+(credit|tokens|quota)/i,
    /insufficient\s+(credit|quota|balance|funds)/i,
    /exceeded\s+your\s+(plan|usage|quota)/i
  ];
  // SIGTERM / SIGKILL / explicit "timed out".
  const timeoutPatterns = [
    /timed?\s*out/i,
    /\btimeout\b/i,
    /did\s+not\s+finish\s+within/i,
    /exited\s+with\s+code\s+143/i,
    /exited\s+with\s+code\s+137/i
  ];
  const hitsUsage = usagePatterns.some((p) => p.test(lower));
  const hitsTimeout = timeoutPatterns.some((p) => p.test(lower));
  const headerLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const usageLine = headerLines.find((line) => usagePatterns.some((p) => p.test(line)));
  const timeoutLine = headerLines.find((line) => timeoutPatterns.some((p) => p.test(line)));
  const errorLine = headerLines.find((line) => /^error\b/i.test(line) || /\b(cannot|forbidden|unauthorized|unreachable|not found)\b/i.test(line));
  const fallbackLine = headerLines.find((line) => !/^[a-z]+\s+failed\s+with\s+exit\s+code/i.test(line));
  const headline = usageLine || timeoutLine || errorLine || fallbackLine || headerLines[0] || text.slice(0, 200);
  const cleanHeadline = headline.replace(/^ERROR:\s*/i, "").slice(0, 280);
  if (hitsTimeout) {
    return `⏱ The agent ran out of time.\n\n${cleanHeadline}\n\nThe other agent took the turn if it could; otherwise try again, shorten the request, or raise the timeout.`;
  }
  if (hitsUsage) {
    return `⚠️ Usage / credit limit reached.\n\n${cleanHeadline}\n\nOpen Settings → switch the worker / reviewer roles, or wait for credits to refresh.`;
  }
  return `⚠️ The run failed.\n\n${cleanHeadline}`;
}

function normalizeChatTitle(chat: ChatSession): ChatSession {
  const firstUserMessage = chat.messages.find((message) => message.role === "user")?.content.trim();
  const title = firstUserMessage
    ? firstUserMessage.length > 46
      ? `${firstUserMessage.slice(0, 43)}...`
      : firstUserMessage
    : "New chat";
  return {
    ...chat,
    title,
    updatedAt: new Date().toISOString()
  };
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function shortPath(path: string): string {
  if (path.length <= 36) {
    return path;
  }
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 2) {
    return `…/${segments[segments.length - 1] ?? path}`;
  }
  return `…/${segments.slice(-2).join("/")}`;
}

// Guard the auto-mount so unit tests can import helpers from this module
// without React trying to render into a missing #root.
const rootElement = typeof document !== "undefined" ? document.getElementById("root") : null;
if (rootElement) {
  createRoot(rootElement).render(<App />);
}

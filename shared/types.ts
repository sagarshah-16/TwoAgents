export type ProviderId = "openai" | "anthropic";

export type ProviderStatus = {
  provider: ProviderId;
  label: string;
  installed: boolean;
  loggedIn: boolean;
  authMethod?: string;
  detail: string;
  command: string;
  version?: string;
};

export type RoleSelection = {
  worker: ProviderId;
  reviewer: ProviderId;
};

export type AgentDecision =
  | "approved_final"
  | "changes_requested"
  | "needs_user_clarification"
  | "blocked";

export type ExecutionMode = "read_only" | "workspace_write";

export type AgentRunRequest = {
  task: string;
  conversationMessages?: ChatMessage[];
  roles: RoleSelection;
  skills?: AgentSkill[];
  workspacePath?: string;
  maxIterations: number;
  executionMode?: ExecutionMode;
};

export type RefinedBrief = {
  originalTask: string;
  summary: string;
  workerPrompt: string;
  reviewerPrompt: string;
};

export type IterationRecord = {
  iteration: number;
  workerProvider: ProviderId;
  reviewerProvider: ProviderId;
  workerOutput: string;
  reviewerDecision: AgentDecision;
  reviewerFeedback: string;
  proposedDiff?: string;
  changedFiles: string[];
};

export type SkippedAgent = {
  provider: ProviderId;
  role: "worker" | "reviewer";
  reason: string;
};

export type IterationTiming = {
  iteration: number;
  workerProvider?: ProviderId;
  reviewerProvider?: ProviderId;
  workerMs?: number;
  reviewerMs?: number;
};

export type RunTimings = {
  startedAt: number;
  finishedAt?: number;
  workerTotalMs: number;
  reviewerTotalMs: number;
  iterations: IterationTiming[];
};

export type AgentRunResult = {
  status: "approved" | "clarification_needed" | "blocked" | "max_iterations" | "failed";
  finalAnswer?: string;
  clarificationQuestion?: string;
  /** Optional suggested answers the user can pick from to keep the conversation moving. */
  clarificationSuggestions?: string[];
  failureReason?: string;
  brief?: RefinedBrief;
  iterations: IterationRecord[];
  proposedDiff?: string;
  changedFiles: string[];
  skippedAgents?: SkippedAgent[];
  timings?: RunTimings;
  /** Snapshot of the live activity log captured at the time the run finished. */
  runLogs?: AgentLogEvent[];
};

export type ApplyPatchResult = {
  ok: boolean;
  message: string;
};

export type LoginLaunchResult = {
  ok: boolean;
  message: string;
  url?: string;
  deviceCode?: string;
};

export type AgentLogEvent = {
  timestamp: string;
  source: string;
  message: string;
};

export type ChatAttachment = {
  id: string;
  name: string;
  path: string;
  size: number;
  content?: string;
  truncated?: boolean;
  error?: string;
};

export type AgentSkillTarget = "worker" | "reviewer" | "both";

export type AgentSkill = {
  id: string;
  name: string;
  instructions: string;
  target: AgentSkillTarget;
  enabled: boolean;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  attachments?: ChatAttachment[];
  result?: AgentRunResult;
};

export type ChatSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  roles?: RoleSelection;
  workspacePath?: string;
  messages: ChatMessage[];
};

export type AppSettings = {
  defaultWorkspacePath?: string;
  maxIterations: number;
  skills: AgentSkill[];
  executionMode?: ExecutionMode;
};

export type LoginProvider = ProviderId;

export type RunStartedEvent = {
  requestId: string;
};

export type BridgeApi = {
  getProviderStatuses: () => Promise<ProviderStatus[]>;
  launchLogin: (provider: LoginProvider) => Promise<LoginLaunchResult>;
  runAgents: (request: AgentRunRequest) => Promise<AgentRunResult>;
  cancelAgents: (requestId?: string) => Promise<{ ok: boolean }>;
  chooseWorkspace: () => Promise<string | undefined>;
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: AppSettings) => Promise<AppSettings>;
  applyPatch: (workspacePath: string, patch: string) => Promise<ApplyPatchResult>;
  listChats: () => Promise<ChatSession[]>;
  createChat: () => Promise<ChatSession>;
  saveChat: (chat: ChatSession) => Promise<ChatSession>;
  deleteChat: (chatId: string) => Promise<ChatSession[]>;
  onAgentLog: (callback: (event: AgentLogEvent) => void) => () => void;
  onAgentRunStarted: (callback: (event: RunStartedEvent) => void) => () => void;
  getLogFilePath: () => Promise<string>;
  exportChatPdf: (request: ExportChatPdfRequest) => Promise<ExportChatPdfResult>;
};

export type ExportChatPdfRequest = {
  /** Suggested file name (without extension) for the save dialog. */
  suggestedFileName: string;
  /** Self-contained printable HTML document for the chat. */
  html: string;
};

export type ExportChatPdfResult = {
  ok: boolean;
  /** Absolute path the PDF was written to (only set on ok). */
  filePath?: string;
  /** Set when the user cancelled the save dialog. */
  cancelled?: boolean;
  /** Human-readable error when ok is false and not cancelled. */
  message?: string;
};

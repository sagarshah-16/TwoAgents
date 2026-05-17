import { EventEmitter } from "node:events";

export type AgentLogEvent = {
  timestamp: string;
  source: string;
  message: string;
};

const bus = new EventEmitter();

export function emitAgentLog(source: string, message: string) {
  const clean = message.trim();
  if (!clean) {
    return;
  }
  bus.emit("agent-log", {
    timestamp: new Date().toISOString(),
    source,
    message: clean
  } satisfies AgentLogEvent);
}

export function onAgentLog(listener: (event: AgentLogEvent) => void) {
  bus.on("agent-log", listener);
  return () => bus.off("agent-log", listener);
}

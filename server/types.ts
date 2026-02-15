export type AgentName = "gemini" | "codex";
export type PanelName = "left" | "center" | "right";
export type AgentStatus = "idle" | "connecting" | "ready" | "error";
export type DebateStatus =
  | "idle"
  | "running"
  | "pause_requested"
  | "paused"
  | "stopping"
  | "stopped"
  | "completed";

export interface AgentSession {
  agent: AgentName;
  sessionId: string;
  status: AgentStatus;
  lastConnectedAt: string;
  lastError?: string;
}

export interface DebateConfig {
  topic: string;
  maxRounds: number;
  consensusRegex: string;
  turnTimeoutMs: number;
}

export interface TranscriptEntry {
  runId: string;
  ts: string;
  round: number;
  from: AgentName;
  to: AgentName;
  prompt: string;
  response: string;
  rawStdout: string;
  rawStderr: string;
}

export interface DebateStateSnapshot {
  status: DebateStatus;
  runId: string;
  round: number;
  topic: string;
  maxRounds: number;
  reason?: string;
}

export interface RuntimeConfig {
  port: number;
  defaultMaxRounds: number;
  turnTimeoutMs: number;
  consensusRegex: RegExp;
  commandTemplates: Record<AgentName, { start: string; resume: string }>;
}

export type ServerEvent =
  | {
      type: "agent_status";
      payload: { agent: AgentName; status: AgentStatus; sessionId?: string; error?: string };
    }
  | {
      type: "debate_state";
      payload: {
        status: DebateStatus;
        runId?: string;
        round?: number;
        reason?: string;
        topic?: string;
        maxRounds?: number;
      };
    }
  | { type: "turn_log"; payload: TranscriptEntry }
  | { type: "panel_output"; payload: { panel: PanelName; line: string } }
  | { type: "error"; payload: { code: string; message: string; detail?: string } };

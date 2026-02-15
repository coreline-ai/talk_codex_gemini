export type AgentName = "gemini" | "codex";
export type AgentStatus = "idle" | "connecting" | "ready" | "error";
export type DebateStatus =
  | "idle"
  | "running"
  | "pause_requested"
  | "paused"
  | "stopping"
  | "stopped"
  | "completed";

export interface UiAgentState {
  status: AgentStatus;
  sessionId: string;
  error?: string;
}

export interface UiDebateState {
  status: DebateStatus;
  runId: string;
  round: number;
  topic: string;
  maxRounds: number;
  reason?: string;
}

export interface UiState {
  topicInput: string;
  maxRoundsInput: number;
  agents: Record<AgentName, UiAgentState>;
  debate: UiDebateState;
  panels: {
    left: string[];
    center: string[];
    right: string[];
  };
  errorBanner: string;
}

export interface ControlAvailability {
  canStart: boolean;
  canPause: boolean;
  canResume: boolean;
  canStop: boolean;
}

export const initialUiState: UiState = {
  topicInput: "",
  maxRoundsInput: 6,
  agents: {
    gemini: { status: "idle", sessionId: "" },
    codex: { status: "idle", sessionId: "" },
  },
  debate: {
    status: "idle",
    runId: "",
    round: 0,
    topic: "",
    maxRounds: 6,
  },
  panels: {
    left: [],
    center: [],
    right: [],
  },
  errorBanner: "",
};

export function getControlAvailability(state: UiState): ControlAvailability {
  const bothReady = state.agents.gemini.status === "ready" && state.agents.codex.status === "ready";
  const topicFilled = state.topicInput.trim().length > 0;
  return {
    canStart:
      bothReady &&
      topicFilled &&
      !["running", "pause_requested", "paused", "stopping"].includes(state.debate.status),
    canPause: state.debate.status === "running",
    canResume: state.debate.status === "paused",
    canStop: ["running", "pause_requested", "paused", "stopping"].includes(state.debate.status),
  };
}

export type UiAction =
  | { type: "set_topic"; topic: string }
  | { type: "set_max_rounds"; value: number }
  | { type: "agent_status"; payload: { agent: AgentName; status: AgentStatus; sessionId?: string; error?: string } }
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
  | { type: "panel_output"; payload: { panel: "left" | "center" | "right"; line: string } }
  | { type: "error"; message: string }
  | { type: "clear_error" }
  | { type: "reset_panels" }
  | { type: "hydrate"; payload: Partial<UiState> };

function pushLine(lines: string[], line: string, max = 2000): string[] {
  const next = [...lines, line];
  if (next.length > max) {
    return next.slice(next.length - max);
  }
  return next;
}

export function uiReducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "set_topic":
      return { ...state, topicInput: action.topic };
    case "set_max_rounds":
      return { ...state, maxRoundsInput: action.value };
    case "agent_status": {
      const current = state.agents[action.payload.agent];
      return {
        ...state,
        agents: {
          ...state.agents,
          [action.payload.agent]: {
            ...current,
            status: action.payload.status,
            sessionId: action.payload.sessionId ?? current.sessionId,
            error: action.payload.error,
          },
        },
      };
    }
    case "debate_state":
      return {
        ...state,
        debate: {
          ...state.debate,
          status: action.payload.status,
          runId: action.payload.runId ?? state.debate.runId,
          round: action.payload.round ?? state.debate.round,
          topic: action.payload.topic ?? state.debate.topic,
          maxRounds: action.payload.maxRounds ?? state.debate.maxRounds,
          reason: action.payload.reason,
        },
      };
    case "panel_output":
      return {
        ...state,
        panels: {
          ...state.panels,
          [action.payload.panel]: pushLine(state.panels[action.payload.panel], action.payload.line),
        },
      };
    case "error":
      return { ...state, errorBanner: action.message };
    case "clear_error":
      return { ...state, errorBanner: "" };
    case "reset_panels":
      return { ...state, panels: { left: [], center: [], right: [] } };
    case "hydrate":
      return {
        ...state,
        ...action.payload,
        agents: { ...state.agents, ...(action.payload.agents ?? {}) },
        debate: { ...state.debate, ...(action.payload.debate ?? {}) },
        panels: { ...state.panels, ...(action.payload.panels ?? {}) },
      };
    default:
      return state;
  }
}

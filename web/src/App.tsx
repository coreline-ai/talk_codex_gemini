import { useEffect, useMemo, useReducer, useRef } from "react";
import { TerminalPane } from "./terminal-pane";
import { connectWs } from "./ws-client";
import { getControlAvailability, initialUiState, uiReducer, type AgentName } from "./state";

type ApiResult<T> = { ok: true; [key: string]: unknown } & T;
type DebateStatus = "idle" | "running" | "pause_requested" | "paused" | "stopping" | "stopped" | "completed";
type AgentStatus = "idle" | "connecting" | "ready" | "error";

interface ServerStateShape {
  debate: {
    status: DebateStatus;
    runId: string;
    round: number;
    topic: string;
    maxRounds: number;
    reason?: string;
  };
  agents: {
    gemini: { status: AgentStatus; sessionId: string; lastError?: string };
    codex: { status: AgentStatus; sessionId: string; lastError?: string };
  };
}

async function postJson<T>(url: string, body?: Record<string, unknown>): Promise<ApiResult<T>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const payload = (await response.json()) as { ok?: boolean; error?: string } & T;
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }
  return payload as ApiResult<T>;
}

async function getJson<T>(url: string): Promise<ApiResult<T>> {
  const response = await fetch(url);
  const payload = (await response.json()) as { ok?: boolean; error?: string } & T;
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }
  return payload as ApiResult<T>;
}

export default function App() {
  const [state, dispatch] = useReducer(uiReducer, initialUiState);
  const wsRef = useRef<{ close: () => void } | null>(null);

  const controls = useMemo(() => getControlAvailability(state), [state]);

  const applyServerState = (serverState: ServerStateShape) => {
    dispatch({
      type: "debate_state",
      payload: {
        status: serverState.debate.status,
        runId: serverState.debate.runId,
        round: serverState.debate.round,
        topic: serverState.debate.topic,
        maxRounds: serverState.debate.maxRounds,
        reason: serverState.debate.reason,
      },
    });
    dispatch({
      type: "agent_status",
      payload: {
        agent: "gemini",
        status: serverState.agents.gemini.status,
        sessionId: serverState.agents.gemini.sessionId,
        error: serverState.agents.gemini.lastError,
      },
    });
    dispatch({
      type: "agent_status",
      payload: {
        agent: "codex",
        status: serverState.agents.codex.status,
        sessionId: serverState.agents.codex.sessionId,
        error: serverState.agents.codex.lastError,
      },
    });
  };

  useEffect(() => {
    getJson<{ state: ServerStateShape }>("/api/debate/state")
      .then((data) => {
        applyServerState(data.state);
      })
      .catch((error) => {
        dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
      });

    wsRef.current = connectWs(
      (event) => {
        if (event.type === "agent_status") {
          const payload = event.payload as {
            agent: AgentName;
            status: "idle" | "connecting" | "ready" | "error";
            sessionId?: string;
            error?: string;
          };
          dispatch({ type: "agent_status", payload });
          return;
        }
        if (event.type === "debate_state") {
          const payload = event.payload as {
            status: "idle" | "running" | "pause_requested" | "paused" | "stopping" | "stopped" | "completed";
            runId?: string;
            round?: number;
            reason?: string;
            topic?: string;
            maxRounds?: number;
          };
          dispatch({ type: "debate_state", payload });
          return;
        }
        if (event.type === "panel_output") {
          const payload = event.payload as { panel: "left" | "center" | "right"; line: string };
          dispatch({ type: "panel_output", payload });
          return;
        }
        if (event.type === "error") {
          const payload = event.payload as { message: string; detail?: string };
          dispatch({
            type: "error",
            message: payload.detail ? `${payload.message}: ${payload.detail}` : payload.message,
          });
        }
      },
      (error) => {
        dispatch({ type: "error", message: error });
      },
    );

    return () => {
      wsRef.current?.close();
    };
  }, []);

  const runConnect = async (agent: AgentName) => {
    dispatch({ type: "clear_error" });
    dispatch({
      type: "agent_status",
      payload: { agent, status: "connecting" },
    });
    dispatch({
      type: "panel_output",
      payload: { panel: "center", line: `[${agent}] 연결 요청 전송...` },
    });
    try {
      const data = await postJson<{
        session: { agent: AgentName; status: AgentStatus; sessionId: string; lastConnectedAt: string };
      }>(`/api/agents/${agent}/connect`);
      dispatch({
        type: "agent_status",
        payload: {
          agent: data.session.agent,
          status: data.session.status,
          sessionId: data.session.sessionId,
        },
      });
      dispatch({
        type: "panel_output",
        payload: { panel: "center", line: `[${agent}] 연결 API 성공 (${data.session.sessionId})` },
      });
    } catch (error) {
      dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const runStart = async () => {
    dispatch({ type: "clear_error" });
    dispatch({ type: "reset_panels" });
    try {
      const data = await postJson<{ state: ServerStateShape }>("/api/debate/start", {
        topic: state.topicInput,
        maxRounds: state.maxRoundsInput,
      });
      applyServerState(data.state);
    } catch (error) {
      dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const runPause = async () => {
    dispatch({ type: "clear_error" });
    try {
      const data = await postJson<{ state: ServerStateShape }>("/api/debate/pause");
      applyServerState(data.state);
    } catch (error) {
      dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const runResume = async () => {
    dispatch({ type: "clear_error" });
    try {
      const data = await postJson<{ state: ServerStateShape }>("/api/debate/resume");
      applyServerState(data.state);
    } catch (error) {
      dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const runStop = async () => {
    dispatch({ type: "clear_error" });
    try {
      const data = await postJson<{ state: ServerStateShape }>("/api/debate/stop");
      applyServerState(data.state);
    } catch (error) {
      dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <main className="page">
      <header className="topbar">
        <div className="field-wrap">
          <label htmlFor="topic">토론 주제</label>
          <input
            id="topic"
            placeholder="예: Next.js 컴포넌트 최적화 방안"
            value={state.topicInput}
            onChange={(event) => dispatch({ type: "set_topic", topic: event.target.value })}
          />
        </div>
        <div className="field-wrap small">
          <label htmlFor="max-rounds">최대 턴</label>
          <input
            id="max-rounds"
            type="number"
            min={1}
            max={30}
            value={state.maxRoundsInput}
            onChange={(event) =>
              dispatch({
                type: "set_max_rounds",
                value: Number.isFinite(Number(event.target.value))
                  ? Math.max(1, Number(event.target.value))
                  : 6,
              })
            }
          />
        </div>
        <button disabled={!controls.canStart} onClick={runStart}>
          토론 시작
        </button>
        <button disabled={!controls.canPause} onClick={runPause}>
          일시정지
        </button>
        <button disabled={!controls.canResume} onClick={runResume}>
          재개
        </button>
        <button disabled={!controls.canStop} onClick={runStop}>
          중지
        </button>
        <div className="meta">
          <span>상태: {state.debate.status}</span>
          <span>라운드: {state.debate.round}</span>
          <span>runId: {state.debate.runId || "-"}</span>
        </div>
      </header>

      {state.errorBanner ? <div className="error-banner">{state.errorBanner}</div> : null}

      <section className="panel-grid">
        <TerminalPane
          title="Gemini CLI"
          status={`${state.agents.gemini.status} ${state.agents.gemini.sessionId ? `(${state.agents.gemini.sessionId})` : ""}`}
          lines={state.panels.left}
        />
        <TerminalPane
          title="Debate Relay"
          status={`${state.debate.status} / round ${state.debate.round}`}
          lines={state.panels.center}
        />
        <TerminalPane
          title="Codex CLI"
          status={`${state.agents.codex.status} ${state.agents.codex.sessionId ? `(${state.agents.codex.sessionId})` : ""}`}
          lines={state.panels.right}
        />
      </section>

      <footer className="agent-bar">
        <button onClick={() => runConnect("gemini")} disabled={state.debate.status === "running"}>
          Gemini 구동/재연결
        </button>
        <span className="session-text">
          session: {state.agents.gemini.sessionId || "-"} / status: {state.agents.gemini.status}
        </span>
        <button onClick={() => runConnect("codex")} disabled={state.debate.status === "running"}>
          Codex 구동/재연결
        </button>
        <span className="session-text">
          session: {state.agents.codex.sessionId || "-"} / status: {state.agents.codex.status}
        </span>
      </footer>
    </main>
  );
}

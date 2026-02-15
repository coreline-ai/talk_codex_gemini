import { useEffect, useMemo, useReducer, useRef } from "react";
import { connectWs } from "./ws-client";
import {
  getControlAvailability,
  initialUiState,
  uiReducer,
  type AgentName,
  type DebateStatus,
  type MessageRole,
} from "./state";

type ApiResult<T> = { ok: true; [key: string]: unknown } & T;
type AgentStatus = "idle" | "connecting" | "ready" | "error";

interface ServerStateShape {
  debate: {
    status: DebateStatus;
    runId: string;
    round: number;
    topic: string;
    maxRounds: number;
    textLimit: number;
    reason?: string;
  };
  agents: {
    gemini: { status: AgentStatus; sessionId: string; lastError?: string };
    codex: { status: AgentStatus; sessionId: string; lastError?: string };
  };
}

interface TurnLogPayload {
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

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "").trim();
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeMessageId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return d.toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function debateStatusText(status: DebateStatus, reason?: string): string {
  switch (status) {
    case "running":
      return "토론이 시작되었습니다.";
    case "pause_requested":
      return "일시정지 요청됨. 현재 턴 완료 후 멈춥니다.";
    case "paused":
      return "토론이 일시정지되었습니다.";
    case "stopping":
      return "토론 중지 요청됨.";
    case "stopped":
      return `토론이 중지되었습니다.${reason ? ` (${reason})` : ""}`;
    case "completed":
      return `토론이 완료되었습니다.${reason ? ` (${reason})` : ""}`;
    default:
      return "";
  }
}

async function postJson<T>(
  url: string,
  body?: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: controller.signal,
  });
  window.clearTimeout(timeout);
  const payload = (await response.json()) as { ok?: boolean; error?: string } & T;
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }
  return payload as ApiResult<T>;
}

async function getJson<T>(url: string, timeoutMs = 10_000): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(url, { signal: controller.signal });
  window.clearTimeout(timeout);
  const payload = (await response.json()) as { ok?: boolean; error?: string } & T;
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }
  return payload as ApiResult<T>;
}

export default function App() {
  const [state, dispatch] = useReducer(uiReducer, initialUiState);
  const wsRef = useRef<{ close: () => void } | null>(null);
  const wsErrorVisibleRef = useRef(false);
  const debateStatusRef = useRef<DebateStatus>("idle");
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const leftDebugRef = useRef<HTMLDivElement | null>(null);
  const rightDebugRef = useRef<HTMLDivElement | null>(null);

  const controls = useMemo(() => getControlAvailability(state), [state]);

  const appendSystemMessage = (text: string, label = "SYSTEM") => {
    const clean = stripAnsi(text);
    if (!clean) return;
    dispatch({
      type: "append_message",
      payload: {
        id: makeMessageId("sys"),
        role: "system",
        text: clean,
        ts: nowIso(),
        label,
      },
    });
  };

  const applyServerState = (serverState: ServerStateShape) => {
    dispatch({
      type: "debate_state",
      payload: {
        status: serverState.debate.status,
        runId: serverState.debate.runId,
        round: serverState.debate.round,
        topic: serverState.debate.topic,
        maxRounds: serverState.debate.maxRounds,
        textLimit: serverState.debate.textLimit,
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
    debateStatusRef.current = serverState.debate.status;
  };

  useEffect(() => {
    getJson<{ state: ServerStateShape }>("/api/debate/state")
      .then((data) => {
        applyServerState(data.state);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        dispatch({ type: "error", message });
        appendSystemMessage(message, "ERROR");
      });

    wsRef.current = connectWs(
      (event) => {
        if (event.type === "agent_status") {
          const payload = event.payload as {
            agent: AgentName;
            status: AgentStatus;
            sessionId?: string;
            error?: string;
          };
          dispatch({ type: "agent_status", payload });
          if (payload.status === "error" && payload.error) {
            appendSystemMessage(`[${payload.agent}] ${payload.error}`, "ERROR");
          }
          return;
        }

        if (event.type === "debate_state") {
          const payload = event.payload as {
            status: DebateStatus;
            runId?: string;
            round?: number;
            reason?: string;
            topic?: string;
            maxRounds?: number;
            textLimit?: number;
          };
          dispatch({ type: "debate_state", payload });

          if (payload.status && payload.status !== debateStatusRef.current) {
            const text = debateStatusText(payload.status, payload.reason);
            if (text) appendSystemMessage(text, "STATE");
            debateStatusRef.current = payload.status;
          }
          return;
        }

        if (event.type === "turn_log") {
          const payload = event.payload as TurnLogPayload;
          dispatch({
            type: "append_message",
            payload: {
              id: makeMessageId(payload.from),
              role: payload.from,
              text: payload.response || "(empty)",
              ts: payload.ts || nowIso(),
              round: payload.round,
              label: `R${payload.round}`,
            },
          });
          return;
        }

        if (event.type === "panel_output") {
          const payload = event.payload as { panel: "left" | "center" | "right"; line: string };
          dispatch({ type: "panel_output", payload });
          return;
        }

        if (event.type === "error") {
          const payload = event.payload as { message: string; detail?: string };
          const message = payload.detail ? `${payload.message}: ${payload.detail}` : payload.message;
          dispatch({ type: "error", message });
          appendSystemMessage(message, "ERROR");
        }
      },
      (error) => {
        wsErrorVisibleRef.current = true;
        dispatch({ type: "error", message: error });
        appendSystemMessage(error, "WS");
      },
      () => {
        if (wsErrorVisibleRef.current) {
          dispatch({ type: "clear_error" });
          wsErrorVisibleRef.current = false;
          appendSystemMessage("WebSocket 재연결 성공", "WS");
        }
      },
    );

    return () => {
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!chatScrollRef.current) return;
    chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
  }, [state.messages]);

  useEffect(() => {
    if (!leftDebugRef.current) return;
    leftDebugRef.current.scrollTop = leftDebugRef.current.scrollHeight;
  }, [state.panels.left]);

  useEffect(() => {
    if (!rightDebugRef.current) return;
    rightDebugRef.current.scrollTop = rightDebugRef.current.scrollHeight;
  }, [state.panels.right]);

  const runConnect = async (agent: AgentName) => {
    dispatch({ type: "clear_error" });
    dispatch({
      type: "agent_status",
      payload: { agent, status: "connecting" },
    });
    appendSystemMessage(`[${agent}] 연결 요청 전송...`, "CONNECT");

    try {
      const data = await postJson<{
        session: { agent: AgentName; status: AgentStatus; sessionId: string; lastConnectedAt: string };
      }>(`/api/agents/${agent}/connect`, {}, 150_000);

      dispatch({
        type: "agent_status",
        payload: {
          agent: data.session.agent,
          status: data.session.status,
          sessionId: data.session.sessionId,
        },
      });
      appendSystemMessage(`[${agent}] 연결 완료 (${data.session.sessionId})`, "CONNECT");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatch({
        type: "agent_status",
        payload: { agent, status: "error" },
      });
      dispatch({ type: "error", message });
      appendSystemMessage(`[${agent}] 연결 실패: ${message}`, "ERROR");
    }
  };

  const runStart = async () => {
    dispatch({ type: "clear_error" });
    dispatch({ type: "reset_panels" });

    try {
      const data = await postJson<{ state: ServerStateShape }>("/api/debate/start", {
        topic: state.topicInput,
        maxRounds: state.maxRoundsInput,
        textLimit: state.textLimitInput,
      });
      applyServerState(data.state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: "error", message });
      appendSystemMessage(message, "ERROR");
    }
  };

  const runPause = async () => {
    dispatch({ type: "clear_error" });
    try {
      const data = await postJson<{ state: ServerStateShape }>("/api/debate/pause");
      applyServerState(data.state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: "error", message });
      appendSystemMessage(message, "ERROR");
    }
  };

  const runResume = async () => {
    dispatch({ type: "clear_error" });
    try {
      const data = await postJson<{ state: ServerStateShape }>("/api/debate/resume");
      applyServerState(data.state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: "error", message });
      appendSystemMessage(message, "ERROR");
    }
  };

  const runStop = async () => {
    dispatch({ type: "clear_error" });
    try {
      const data = await postJson<{ state: ServerStateShape }>("/api/debate/stop");
      applyServerState(data.state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatch({ type: "error", message });
      appendSystemMessage(message, "ERROR");
    }
  };

  const roleLabel = (role: MessageRole): string => {
    if (role === "gemini") return "Gemini";
    if (role === "codex") return "Codex";
    return "System";
  };

  return (
    <main className="page messenger-page">
      <header className="topbar messenger-topbar">
        <div className="field-wrap topic-field">
          <label htmlFor="topic">토론 주제</label>
          <input
            id="topic"
            placeholder="예: Next.js 컴포넌트 최적화 방안"
            value={state.topicInput}
            onChange={(event) => dispatch({ type: "set_topic", topic: event.target.value })}
          />
        </div>
        <div className="field-wrap small">
          <label htmlFor="text-limit">텍스트 제한(자)</label>
          <input
            id="text-limit"
            type="number"
            min={1}
            max={2000}
            value={state.textLimitInput}
            onChange={(event) =>
              dispatch({
                type: "set_text_limit",
                value: Number.isFinite(Number(event.target.value))
                  ? Math.max(1, Number(event.target.value))
                  : 100,
              })
            }
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
          <span>
            상태: {state.debate.status} | 라운드: {state.debate.round} | 텍스트 제한: {state.debate.textLimit} |
            runId: {state.debate.runId || "-"}
          </span>
        </div>
      </header>

      {state.errorBanner ? <div className="error-banner">{state.errorBanner}</div> : null}

      <section className="chat-shell">
        <aside className="debug-pane">
          <header className="debug-head">
            <strong>Gemini RAW</strong>
            <span>{state.agents.gemini.status}</span>
          </header>
          <small className="debug-session">{state.agents.gemini.sessionId || "session: -"}</small>
          <div ref={leftDebugRef} className="debug-body">
            {state.panels.left.length === 0 ? (
              <div className="debug-empty">RAW 출력 대기 중...</div>
            ) : (
              state.panels.left.map((line, idx) => (
                <div key={`left-${idx}`} className="debug-line">
                  {line}
                </div>
              ))
            )}
          </div>
        </aside>

        <section className="chat-center">
          <div ref={chatScrollRef} className="chat-stream">
            {state.messages.length === 0 ? (
              <div className="chat-empty">토론 시작 후 대화가 여기에 버블 형태로 표시됩니다.</div>
            ) : (
              state.messages.map((message) => {
                const side = message.role === "system" ? "center" : message.role === "gemini" ? "left" : "right";
                return (
                  <div key={message.id} className={`message-row ${side}`}>
                    <article className={`bubble ${side}`}>
                      <header className="bubble-head">
                        <strong>{message.label ?? roleLabel(message.role)}</strong>
                        <span>{formatTime(message.ts)}</span>
                      </header>
                      <p>{message.text}</p>
                    </article>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <aside className="debug-pane">
          <header className="debug-head">
            <strong>Codex RAW</strong>
            <span>{state.agents.codex.status}</span>
          </header>
          <small className="debug-session">{state.agents.codex.sessionId || "session: -"}</small>
          <div ref={rightDebugRef} className="debug-body">
            {state.panels.right.length === 0 ? (
              <div className="debug-empty">RAW 출력 대기 중...</div>
            ) : (
              state.panels.right.map((line, idx) => (
                <div key={`right-${idx}`} className="debug-line">
                  {line}
                </div>
              ))
            )}
          </div>
        </aside>
      </section>

      <footer className="agent-bar messenger-agent-bar">
        <button onClick={() => runConnect("gemini")} disabled={state.debate.status === "running"}>
          Gemini 구동/재연결
        </button>
        <button onClick={() => runConnect("codex")} disabled={state.debate.status === "running"}>
          Codex 구동/재연결
        </button>
      </footer>
    </main>
  );
}

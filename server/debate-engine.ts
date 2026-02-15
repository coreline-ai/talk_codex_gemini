import path from "node:path";
import type {
  AgentName,
  AgentSession,
  DebateStateSnapshot,
  DebateStatus,
  RuntimeConfig,
  ServerEvent,
  TranscriptEntry,
} from "./types.js";
import type { AgentRunResult, AgentRunner } from "./cli-runner.js";
import { RunLogStore, type RunSummary } from "./run-log-store.js";
import { SessionStore } from "./session-store.js";

const CONNECT_PROMPT = "세션 연결 상태 점검입니다. 짧게 OK로만 응답하세요.";
const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_MAGENTA = "\x1b[35m";

function panelForAgent(agent: AgentName): "left" | "right" {
  return agent === "gemini" ? "left" : "right";
}

function otherAgent(agent: AgentName): AgentName {
  return agent === "gemini" ? "codex" : "gemini";
}

function nowIso(): string {
  return new Date().toISOString();
}

function colorAgent(agent: AgentName): string {
  return agent === "codex"
    ? `${ANSI_CYAN}CODEX${ANSI_RESET}`
    : `${ANSI_GREEN}GEMINI${ANSI_RESET}`;
}

function turnSlot(from: AgentName): "A" | "B" {
  return from === "codex" ? "A" : "B";
}

function relayDivider(round: number): string {
  return `${ANSI_DIM}━━━━━━━━━━━━━━━━━ ROUND ${round} ━━━━━━━━━━━━━━━━━${ANSI_RESET}`;
}

function relayRequestLine(round: number, from: AgentName, to: AgentName): string {
  const slot = turnSlot(from);
  return (
    `${ANSI_BOLD}${ANSI_YELLOW}[R${round}-T${slot}]${ANSI_RESET} ` +
    `${colorAgent(from)} ${ANSI_MAGENTA}→${ANSI_RESET} ${colorAgent(to)} ` +
    `${ANSI_BOLD}요청 실행${ANSI_RESET}`
  );
}

function relayResponseLine(round: number, from: AgentName, response: string): string {
  const slot = turnSlot(from);
  return (
    `${ANSI_BOLD}${ANSI_YELLOW}[R${round}-T${slot}]${ANSI_RESET} ` +
    `${colorAgent(from)} ${ANSI_BOLD}응답${ANSI_RESET}: ${response || "(empty)"}`
  );
}

export interface DebateEngineState {
  debate: DebateStateSnapshot;
  agents: Record<AgentName, AgentSession>;
}

interface ControlFlags {
  pauseRequested: boolean;
  stopRequested: boolean;
}

interface WaitHandle {
  promise: Promise<void>;
  resolve: () => void;
}

export class DebateEngine {
  private state: DebateEngineState;
  private currentRun: RunSummary | null = null;
  private executionPromise: Promise<void> | null = null;
  private control: ControlFlags = { pauseRequested: false, stopRequested: false };
  private pauseWait: WaitHandle | null = null;
  private consecutiveEmptyResponses = 0;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly runner: AgentRunner,
    private readonly sessionStore: SessionStore,
    private readonly runLogStore: RunLogStore,
    private readonly emit: (event: ServerEvent) => void,
  ) {
    const persisted = sessionStore.read();
    this.state = {
      debate: {
        status: "idle",
        runId: "",
        round: 0,
        topic: "",
        maxRounds: config.defaultMaxRounds,
      },
      agents: {
        gemini: {
          agent: "gemini",
          sessionId: persisted.gemini,
          status: persisted.gemini ? "idle" : "idle",
          lastConnectedAt: "",
        },
        codex: {
          agent: "codex",
          sessionId: persisted.codex,
          status: persisted.codex ? "idle" : "idle",
          lastConnectedAt: "",
        },
      },
    };
  }

  getState(): DebateEngineState {
    return JSON.parse(JSON.stringify(this.state)) as DebateEngineState;
  }

  getRun(runId: string) {
    return this.runLogStore.readRun(runId);
  }

  private setDebateStatus(status: DebateStatus, reason?: string): void {
    this.state.debate.status = status;
    this.state.debate.reason = reason;
    this.emit({
      type: "debate_state",
      payload: {
        status,
        runId: this.state.debate.runId || undefined,
        round: this.state.debate.round || undefined,
        reason,
        topic: this.state.debate.topic || undefined,
        maxRounds: this.state.debate.maxRounds || undefined,
      },
    });
  }

  private setAgentStatus(
    agent: AgentName,
    status: AgentSession["status"],
    details?: { sessionId?: string; error?: string },
  ): void {
    this.state.agents[agent].status = status;
    this.state.agents[agent].lastError = details?.error;
    if (details?.sessionId) {
      this.state.agents[agent].sessionId = details.sessionId;
      this.state.agents[agent].lastConnectedAt = nowIso();
    }
    this.emit({
      type: "agent_status",
      payload: {
        agent,
        status,
        sessionId: (details?.sessionId ?? this.state.agents[agent].sessionId) || undefined,
        error: details?.error,
      },
    });
  }

  private panelOutput(panel: "left" | "center" | "right", line: string): void {
    this.emit({ type: "panel_output", payload: { panel, line } });
  }

  async connectAgent(agent: AgentName, resumeSessionId?: string): Promise<AgentSession> {
    if (this.state.debate.status === "running" || this.state.debate.status === "pause_requested") {
      throw new Error("토론 실행 중에는 에이전트 재연결을 할 수 없습니다.");
    }

    const currentSessionId = this.state.agents[agent].sessionId;
    const resolvedSessionId = resumeSessionId ?? currentSessionId;

    this.setAgentStatus(agent, "connecting");
    this.panelOutput("center", `[${agent}] 연결 시도 중...`);

    try {
      const result = await this.runner.runAgent({
        agent,
        prompt: CONNECT_PROMPT,
        sessionId: resolvedSessionId || undefined,
        timeoutMs: this.config.turnTimeoutMs,
        commandTemplates: this.config.commandTemplates[agent],
        onStdoutLine: (line) => this.panelOutput(panelForAgent(agent), line),
        onStderrLine: (line) => this.panelOutput(panelForAgent(agent), `ERR: ${line}`),
      });

      if (!result.sessionId) {
        throw new Error(`${agent} session id를 추출하지 못했습니다.`);
      }

      this.sessionStore.upsert(agent, result.sessionId);
      this.setAgentStatus(agent, "ready", { sessionId: result.sessionId });
      this.panelOutput("center", `[${agent}] 연결 완료 (${result.sessionId})`);
      return this.state.agents[agent];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setAgentStatus(agent, "error", { error: message });
      this.panelOutput("center", `[${agent}] 연결 실패: ${message}`);
      throw error;
    }
  }

  async startDebate(topic: string, maxRounds?: number): Promise<void> {
    const trimmedTopic = topic.trim();
    if (!trimmedTopic) throw new Error("토론 주제가 비어 있습니다.");
    if (this.executionPromise) throw new Error("이미 실행 중인 토론이 있습니다.");
    if (this.state.agents.gemini.status !== "ready" || this.state.agents.codex.status !== "ready") {
      throw new Error("Gemini와 Codex 모두 ready 상태여야 시작할 수 있습니다.");
    }

    this.control = { pauseRequested: false, stopRequested: false };
    this.consecutiveEmptyResponses = 0;
    const run = this.runLogStore.createRun(trimmedTopic, maxRounds ?? this.config.defaultMaxRounds);
    this.currentRun = run;

    this.state.debate = {
      status: "running",
      runId: run.runId,
      round: 0,
      topic: trimmedTopic,
      maxRounds: maxRounds ?? this.config.defaultMaxRounds,
    };
    this.setDebateStatus("running");
    this.panelOutput("center", `=== 토론 시작: ${trimmedTopic} (runId=${run.runId}) ===`);

    this.executionPromise = this.runLoop().finally(() => {
      this.executionPromise = null;
    });
    await Promise.resolve();
  }

  pauseDebate(): void {
    if (this.state.debate.status !== "running") {
      throw new Error("running 상태에서만 일시정지 가능합니다.");
    }
    this.control.pauseRequested = true;
    this.setDebateStatus("pause_requested", "pause requested");
    this.panelOutput("center", "일시정지 요청됨. 현재 라운드 완료 후 정지합니다.");
  }

  resumeDebate(): void {
    if (this.state.debate.status !== "paused") {
      throw new Error("paused 상태에서만 재개 가능합니다.");
    }
    this.control.pauseRequested = false;
    this.setDebateStatus("running", "resumed");
    this.panelOutput("center", "토론을 재개합니다.");
    if (this.pauseWait) {
      this.pauseWait.resolve();
      this.pauseWait = null;
    }
  }

  stopDebate(): void {
    if (
      this.state.debate.status !== "running" &&
      this.state.debate.status !== "pause_requested" &&
      this.state.debate.status !== "paused"
    ) {
      throw new Error("현재 중지할 수 있는 토론이 없습니다.");
    }
    this.control.stopRequested = true;
    this.setDebateStatus("stopping", "stop requested");
    this.panelOutput("center", "중지 요청됨. 실행 중 프로세스를 종료합니다.");
    this.runner.cancelActive();
    if (this.pauseWait) {
      this.pauseWait.resolve();
      this.pauseWait = null;
    }
  }

  private async runLoop(): Promise<void> {
    if (!this.currentRun) return;
    let finalStatus: DebateStatus = "completed";
    let finalReason = "completed";

    try {
      let latestGemini = "";

      for (let round = 1; round <= this.state.debate.maxRounds; round += 1) {
        if (this.control.stopRequested) {
          finalStatus = "stopped";
          finalReason = "manual stop";
          break;
        }

        this.state.debate.round = round;
        this.setDebateStatus(this.state.debate.status, this.state.debate.reason);

        const codexPrompt =
          round === 1
            ? [
                `토론 주제: ${this.state.debate.topic}`,
                "당신은 Codex 역할입니다. 토론을 시작하세요.",
                "형식: 주장 2개, 예상 리스크 1개.",
              ].join("\n")
            : [
                `토론 주제: ${this.state.debate.topic}`,
                `토론 라운드: ${round}`,
                `상대(Gemini) 최신 의견:\n${latestGemini}`,
                "상대 의견을 반박/수용으로 나누어 답변하세요.",
              ].join("\n");

        const codex = await this.invokeTurn("codex", "gemini", round, codexPrompt);
        if (this.control.stopRequested) {
          finalStatus = "stopped";
          finalReason = "manual stop";
          break;
        }

        const geminiPrompt = [
          `토론 주제: ${this.state.debate.topic}`,
          `토론 라운드: ${round}`,
          `상대(Codex) 최신 의견:\n${codex.text}`,
          "상대 의견에 대한 반박/수용과 개선안을 제시하세요.",
        ].join("\n");

        const gemini = await this.invokeTurn("gemini", "codex", round, geminiPrompt);
        latestGemini = gemini.text;

        if (this.control.stopRequested) {
          finalStatus = "stopped";
          finalReason = "manual stop";
          break;
        }

        if (
          this.config.consensusRegex.test(codex.text) ||
          this.config.consensusRegex.test(gemini.text)
        ) {
          finalStatus = "completed";
          finalReason = "consensus detected";
          this.panelOutput("center", `합의 키워드 감지로 라운드 ${round}에서 종료합니다.`);
          break;
        }

        if (this.control.pauseRequested) {
          this.setDebateStatus("paused", "paused at turn boundary");
          await this.waitUntilResumedOrStopped();
          if (this.control.stopRequested) {
            finalStatus = "stopped";
            finalReason = "manual stop";
            break;
          }
        }
      }

      if (!this.control.stopRequested && this.state.debate.round >= this.state.debate.maxRounds) {
        if (finalReason === "completed") {
          finalReason = "max rounds reached";
        }
      }
    } catch (error) {
      finalStatus = "stopped";
      finalReason = error instanceof Error ? error.message : String(error);
      this.emit({
        type: "error",
        payload: {
          code: "RUN_LOOP_ERROR",
          message: "토론 실행 중 오류가 발생했습니다.",
          detail: finalReason,
        },
      });
      this.panelOutput("center", `토론 오류: ${finalReason}`);
    } finally {
      this.control.pauseRequested = false;
      this.control.stopRequested = false;

      this.setDebateStatus(finalStatus, finalReason);
      this.panelOutput("center", `=== 토론 종료: ${finalStatus} (${finalReason}) ===`);

      if (this.currentRun) {
        this.runLogStore.updateSummary(this.currentRun.runId, {
          status: finalStatus,
          round: this.state.debate.round,
          reason: finalReason,
        });
      }
    }
  }

  private async waitUntilResumedOrStopped(): Promise<void> {
    if (this.control.stopRequested) return;
    if (this.state.debate.status !== "paused") return;

    if (!this.pauseWait) {
      let resolve: () => void = () => {};
      const promise = new Promise<void>((res) => {
        resolve = res;
      });
      this.pauseWait = { promise, resolve };
    }
    await this.pauseWait.promise;
  }

  private async invokeTurn(
    from: AgentName,
    to: AgentName,
    round: number,
    prompt: string,
  ): Promise<AgentRunResult> {
    const runId = this.state.debate.runId;
    if (!runId) throw new Error("runId가 없습니다.");

    const panel = panelForAgent(from);
    this.panelOutput(panel, `\n$ Prompt (round ${round}):`);
    for (const line of prompt.split("\n")) {
      this.panelOutput(panel, line);
    }
    this.panelOutput("center", relayDivider(round));
    this.panelOutput("center", relayRequestLine(round, from, to));

    const currentSession = this.state.agents[from].sessionId;
    const result = await this.runner.runAgent({
      agent: from,
      prompt,
      sessionId: currentSession || undefined,
      timeoutMs: this.config.turnTimeoutMs,
      commandTemplates: this.config.commandTemplates[from],
      onStdoutLine: (line) => this.panelOutput(panel, line),
      onStderrLine: (line) => this.panelOutput(panel, `ERR: ${line}`),
    });

    // runtime 중 session id가 바뀌면 즉시 반영
    if (result.sessionId && result.sessionId !== this.state.agents[from].sessionId) {
      this.sessionStore.upsert(from, result.sessionId);
      this.setAgentStatus(from, "ready", { sessionId: result.sessionId });
    }

    const responseText = result.text.trim();
    if (!responseText) {
      this.consecutiveEmptyResponses += 1;
      if (this.consecutiveEmptyResponses >= 2) {
        throw new Error("연속 2회 빈 응답으로 토론을 중단합니다.");
      }
    } else {
      this.consecutiveEmptyResponses = 0;
    }

    const entry: TranscriptEntry = {
      runId,
      ts: nowIso(),
      round,
      from,
      to,
      prompt,
      response: responseText,
      rawStdout: result.stdout,
      rawStderr: result.stderr,
    };
    this.runLogStore.append(entry);
    this.runLogStore.updateSummary(runId, { round });
    this.emit({ type: "turn_log", payload: entry });

    const short = responseText.length > 300 ? `${responseText.slice(0, 300)}...` : responseText;
    this.panelOutput("center", relayResponseLine(round, from, short));
    return result;
  }
}

export function createDefaultStores(baseDir = process.cwd()): {
  sessions: SessionStore;
  runs: RunLogStore;
} {
  const logsDir = path.join(baseDir, "logs");
  return {
    sessions: new SessionStore(path.join(logsDir, "sessions.json")),
    runs: new RunLogStore(path.join(logsDir, "runs")),
  };
}

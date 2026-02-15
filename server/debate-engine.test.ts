import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunOptions, AgentRunResult, AgentRunner } from "./cli-runner.js";
import { DebateEngine } from "./debate-engine.js";
import { RunLogStore } from "./run-log-store.js";
import { SessionStore } from "./session-store.js";
import type { RuntimeConfig, ServerEvent } from "./types.js";

const baseConfig: RuntimeConfig = {
  port: 8787,
  defaultMaxRounds: 2,
  turnTimeoutMs: 2_000,
  consensusRegex: /(합의|동의|consensus|agreed)/i,
  commandTemplates: {
    gemini: { start: "gemini {prompt}", resume: "gemini --resume {session_id} {prompt}" },
    codex: { start: "codex {prompt}", resume: "codex --resume {session_id} {prompt}" },
  },
};

function makeStores() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "debate-engine-"));
  return {
    sessions: new SessionStore(path.join(root, "sessions.json")),
    runs: new RunLogStore(path.join(root, "runs")),
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error("wait timeout"));
      }
    }, 20);
  });
}

class StubRunner implements AgentRunner {
  public calls: AgentRunOptions[] = [];

  constructor(private readonly script: (opts: AgentRunOptions) => Promise<AgentRunResult>) {}

  runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
    this.calls.push(options);
    return this.script(options);
  }

  cancelActive(): void {
    // no-op for most tests
  }
}

describe("DebateEngine", () => {
  it("runs codex-first order and completes by consensus", async () => {
    const stores = makeStores();
    const events: ServerEvent[] = [];
    const runner = new StubRunner(async (opts) => {
      if (opts.prompt.includes("세션 연결 상태 점검")) {
        return {
          stdout: JSON.stringify({ session_id: `${opts.agent}-s1`, text: "OK" }),
          stderr: "",
          text: "OK",
          sessionId: `${opts.agent}-s1`,
          command: "stub",
        };
      }
      if (opts.agent === "codex") {
        return {
          stdout: JSON.stringify({ session_id: "codex-s1", text: "codex turn response" }),
          stderr: "",
          text: "codex turn response",
          sessionId: "codex-s1",
          command: "stub",
        };
      }
      return {
        stdout: JSON.stringify({ session_id: "gemini-s1", text: "합의: 동의합니다." }),
        stderr: "",
        text: "합의: 동의합니다.",
        sessionId: "gemini-s1",
        command: "stub",
      };
    });

    const engine = new DebateEngine(baseConfig, runner, stores.sessions, stores.runs, (event) => {
      events.push(event);
    });

    await engine.connectAgent("codex");
    await engine.connectAgent("gemini");
    await engine.startDebate("테스트 주제", 3);
    await waitFor(() => engine.getState().debate.status === "completed");

    const turnCalls = runner.calls.filter((call) => !call.prompt.includes("세션 연결 상태 점검"));
    expect(turnCalls[0]?.agent).toBe("codex");
    expect(turnCalls[1]?.agent).toBe("gemini");

    const runId = engine.getState().debate.runId;
    const run = engine.getRun(runId);
    expect(run?.entries.length).toBeGreaterThanOrEqual(2);
    expect(events.some((event) => event.type === "turn_log")).toBe(true);
  });

  it("pauses at turn boundary and resumes", async () => {
    const stores = makeStores();
    const runner = new StubRunner(async (opts) => {
      if (opts.prompt.includes("세션 연결 상태 점검")) {
        return {
          stdout: JSON.stringify({ session_id: `${opts.agent}-s2`, text: "OK" }),
          stderr: "",
          text: "OK",
          sessionId: `${opts.agent}-s2`,
          command: "stub",
        };
      }

      await new Promise((resolve) => setTimeout(resolve, 60));
      const text =
        opts.agent === "codex"
          ? "codex response"
          : opts.prompt.includes("라운드: 2")
            ? "합의: 동의"
            : "gemini response";
      return {
        stdout: JSON.stringify({ session_id: `${opts.agent}-s2`, text }),
        stderr: "",
        text,
        sessionId: `${opts.agent}-s2`,
        command: "stub",
      };
    });

    const engine = new DebateEngine(baseConfig, runner, stores.sessions, stores.runs, () => undefined);
    await engine.connectAgent("gemini");
    await engine.connectAgent("codex");
    await engine.startDebate("pause 테스트", 3);
    engine.pauseDebate();

    await waitFor(() => engine.getState().debate.status === "paused");
    expect(engine.getState().debate.round).toBe(1);

    engine.resumeDebate();
    await waitFor(() => engine.getState().debate.status === "completed");
    expect(engine.getState().debate.round).toBeGreaterThanOrEqual(2);
  });

  it("stops and cancels active process", async () => {
    const stores = makeStores();
    let rejectPending: ((error: Error) => void) | null = null;
    let cancelCount = 0;

    const runner: AgentRunner = {
      async runAgent(opts) {
        if (opts.prompt.includes("세션 연결 상태 점검")) {
          return {
            stdout: JSON.stringify({ session_id: `${opts.agent}-s3`, text: "OK" }),
            stderr: "",
            text: "OK",
            sessionId: `${opts.agent}-s3`,
            command: "stub",
          };
        }
        return new Promise<AgentRunResult>((_resolve, reject) => {
          rejectPending = reject;
        });
      },
      cancelActive() {
        cancelCount += 1;
        if (rejectPending) {
          rejectPending(new Error("canceled"));
          rejectPending = null;
        }
      },
    };

    const engine = new DebateEngine(baseConfig, runner, stores.sessions, stores.runs, () => undefined);
    await engine.connectAgent("gemini");
    await engine.connectAgent("codex");
    await engine.startDebate("stop 테스트", 2);
    engine.stopDebate();

    await waitFor(() =>
      engine.getState().debate.status === "stopped" || engine.getState().debate.status === "stopping",
    );
    expect(cancelCount).toBeGreaterThan(0);
  });
});

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { CliAgentRunner, ensureTemplate } from "./cli-runner.js";
import { createDefaultStores, DebateEngine } from "./debate-engine.js";
import type { AgentName, RuntimeConfig, ServerEvent } from "./types.js";

function parseIntWithDefault(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadRuntimeConfig(): RuntimeConfig {
  const geminiStart = process.env.GEMINI_START_CMD ?? "";
  const geminiResume = process.env.GEMINI_RESUME_CMD ?? "";
  const codexStart = process.env.CODEX_START_CMD ?? "";
  const codexResume = process.env.CODEX_RESUME_CMD ?? "";

  ensureTemplate("GEMINI_START_CMD", geminiStart, ["prompt"]);
  ensureTemplate("GEMINI_RESUME_CMD", geminiResume, ["session_id", "prompt"]);
  ensureTemplate("CODEX_START_CMD", codexStart, ["prompt"]);
  ensureTemplate("CODEX_RESUME_CMD", codexResume, ["session_id", "prompt"]);

  const consensusPattern = process.env.CONSENSUS_REGEX ?? "(합의|동의|consensus|agreed)";

  return {
    port: parseIntWithDefault(process.env.PORT, 8787),
    defaultMaxRounds: parseIntWithDefault(process.env.DEFAULT_MAX_ROUNDS, 6),
    turnTimeoutMs: parseIntWithDefault(process.env.TURN_TIMEOUT_MS, 120_000),
    consensusRegex: new RegExp(consensusPattern, "i"),
    commandTemplates: {
      gemini: { start: geminiStart, resume: geminiResume },
      codex: { start: codexStart, resume: codexResume },
    },
  };
}

function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

function normalizeAgent(value: string): AgentName {
  if (value !== "gemini" && value !== "codex") {
    throw new Error("agent는 gemini 또는 codex 이어야 합니다.");
  }
  return value;
}

function broadcast(clients: Set<WebSocket>, event: ServerEvent): void {
  const message = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
}

export async function createServer() {
  const config = loadRuntimeConfig();
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const clients = new Set<WebSocket>();
  const runner = new CliAgentRunner();
  const stores = createDefaultStores();

  const emit = (event: ServerEvent) => broadcast(clients, event);
  const engine = new DebateEngine(config, runner, stores.sessions, stores.runs, emit);

  app.post("/api/agents/:agent/connect", async (req, res) => {
    try {
      const agent = normalizeAgent(req.params.agent);
      const body = typeof req.body === "object" && req.body ? req.body : {};
      const resumeSessionId =
        typeof (body as Record<string, unknown>).resumeSessionId === "string"
          ? ((body as Record<string, unknown>).resumeSessionId as string)
          : undefined;
      const session = await engine.connectAgent(agent, resumeSessionId);
      res.json({ ok: true, session });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/debate/start", async (req, res) => {
    try {
      const body = typeof req.body === "object" && req.body ? req.body : {};
      const topic = typeof (body as Record<string, unknown>).topic === "string"
        ? ((body as Record<string, unknown>).topic as string)
        : "";
      const maxRoundsRaw = (body as Record<string, unknown>).maxRounds;
      const maxRounds = typeof maxRoundsRaw === "number" ? maxRoundsRaw : undefined;

      await engine.startDebate(topic, maxRounds);
      res.json({ ok: true, state: engine.getState() });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post("/api/debate/pause", (req, res) => {
    try {
      engine.pauseDebate();
      res.json({ ok: true, state: engine.getState() });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/debate/resume", (req, res) => {
    try {
      engine.resumeDebate();
      res.json({ ok: true, state: engine.getState() });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/debate/stop", (req, res) => {
    try {
      engine.stopDebate();
      res.json({ ok: true, state: engine.getState() });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/debate/state", (_req, res) => {
    res.json({ ok: true, state: engine.getState() });
  });

  app.get("/api/runs/:runId", (req, res) => {
    const run = engine.getRun(req.params.runId);
    if (!run) {
      res.status(404).json({ ok: false, error: "run not found" });
      return;
    }
    res.json({ ok: true, run });
  });

  const distWebDir = path.join(process.cwd(), "dist", "web");
  if (fs.existsSync(distWebDir)) {
    app.use(express.static(distWebDir));
    app.get(/.*/, (_req, res) => {
      res.sendFile(path.join(distWebDir, "index.html"));
    });
  }

  const server = http.createServer(app);
  const wsServer = new WebSocketServer({ server, path: "/ws" });

  wsServer.on("connection", (socket) => {
    clients.add(socket);
    const state = engine.getState();

    socket.send(
      JSON.stringify({
        type: "debate_state",
        payload: {
          status: state.debate.status,
          runId: state.debate.runId || undefined,
          round: state.debate.round || undefined,
          topic: state.debate.topic || undefined,
          maxRounds: state.debate.maxRounds || undefined,
          reason: state.debate.reason,
        },
      }),
    );
    (["gemini", "codex"] as AgentName[]).forEach((agent) => {
      socket.send(
        JSON.stringify({
          type: "agent_status",
          payload: {
            agent,
            status: state.agents[agent].status,
            sessionId: state.agents[agent].sessionId || undefined,
            error: state.agents[agent].lastError,
          },
        }),
      );
    });

    socket.on("message", (raw) => {
      const msg = safeJsonParse(raw.toString());
      if (
        msg &&
        typeof msg === "object" &&
        (msg as Record<string, unknown>).type === "ping"
      ) {
        socket.send(JSON.stringify({ type: "pong", payload: { ts: Date.now() } }));
      }
    });

    socket.on("close", () => {
      clients.delete(socket);
    });
  });

  return { app, server, config };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createServer()
    .then(({ server, config }) => {
      server.listen(config.port, () => {
        // eslint-disable-next-line no-console
        console.log(`Server started on http://localhost:${config.port}`);
      });
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}

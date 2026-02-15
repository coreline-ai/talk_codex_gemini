import fs from "node:fs";
import path from "node:path";
import type { AgentName } from "./types.js";

export interface SessionFileData {
  updatedAt: string;
  gemini: string;
  codex: string;
}

export class SessionStore {
  constructor(private readonly filePath: string) {}

  private ensureDir(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  read(): SessionFileData {
    this.ensureDir();
    if (!fs.existsSync(this.filePath)) {
      return { updatedAt: "", gemini: "", codex: "" };
    }
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw) as Partial<SessionFileData>;
      return {
        updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : "",
        gemini: typeof data.gemini === "string" ? data.gemini : "",
        codex: typeof data.codex === "string" ? data.codex : "",
      };
    } catch {
      return { updatedAt: "", gemini: "", codex: "" };
    }
  }

  upsert(agent: AgentName, sessionId: string): SessionFileData {
    const current = this.read();
    const next: SessionFileData = {
      updatedAt: new Date().toISOString(),
      gemini: agent === "gemini" ? sessionId : current.gemini,
      codex: agent === "codex" ? sessionId : current.codex,
    };
    this.ensureDir();
    fs.writeFileSync(this.filePath, JSON.stringify(next, null, 2), "utf8");
    return next;
  }
}

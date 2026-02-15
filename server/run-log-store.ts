import fs from "node:fs";
import path from "node:path";
import type { DebateStatus, TranscriptEntry } from "./types.js";

export interface RunSummary {
  runId: string;
  createdAt: string;
  updatedAt: string;
  topic: string;
  maxRounds: number;
  textLimit: number;
  status: DebateStatus;
  round: number;
  reason?: string;
}

export interface RunData {
  summary: RunSummary;
  entries: TranscriptEntry[];
}

export class RunLogStore {
  constructor(private readonly runsDir: string) {}

  private ensureDir(): void {
    fs.mkdirSync(this.runsDir, { recursive: true });
  }

  private makeRunId(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp =
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
      `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return `run_${stamp}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private summaryPath(runId: string): string {
    return path.join(this.runsDir, `${runId}.summary.json`);
  }

  private jsonlPath(runId: string): string {
    return path.join(this.runsDir, `${runId}.jsonl`);
  }

  createRun(topic: string, maxRounds: number, textLimit: number): RunSummary {
    this.ensureDir();
    const now = new Date().toISOString();
    const summary: RunSummary = {
      runId: this.makeRunId(),
      createdAt: now,
      updatedAt: now,
      topic,
      maxRounds,
      textLimit,
      status: "running",
      round: 0,
    };
    fs.writeFileSync(this.summaryPath(summary.runId), JSON.stringify(summary, null, 2), "utf8");
    fs.writeFileSync(this.jsonlPath(summary.runId), "", "utf8");
    return summary;
  }

  append(entry: TranscriptEntry): void {
    this.ensureDir();
    fs.appendFileSync(this.jsonlPath(entry.runId), `${JSON.stringify(entry)}\n`, "utf8");
  }

  updateSummary(runId: string, patch: Partial<RunSummary>): RunSummary {
    this.ensureDir();
    const previous = this.readSummary(runId);
    if (!previous) {
      throw new Error(`Run summary not found: ${runId}`);
    }
    const next: RunSummary = {
      ...previous,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.summaryPath(runId), JSON.stringify(next, null, 2), "utf8");
    return next;
  }

  readSummary(runId: string): RunSummary | null {
    const filePath = this.summaryPath(runId);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as RunSummary;
  }

  readRun(runId: string): RunData | null {
    const summary = this.readSummary(runId);
    if (!summary) return null;

    const logPath = this.jsonlPath(runId);
    const entries: TranscriptEntry[] = [];
    if (fs.existsSync(logPath)) {
      const lines = fs
        .readFileSync(logPath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as TranscriptEntry);
        } catch {
          // ignore malformed line
        }
      }
    }
    return { summary, entries };
  }
}

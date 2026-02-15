import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentName } from "./types.js";

export interface AgentRunOptions {
  agent: AgentName;
  prompt: string;
  sessionId?: string;
  timeoutMs: number;
  commandTemplates: { start: string; resume: string };
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface AgentRunResult {
  stdout: string;
  stderr: string;
  text: string;
  sessionId: string;
  command: string;
}

export interface AgentRunner {
  runAgent(options: AgentRunOptions): Promise<AgentRunResult>;
  cancelActive(): void;
}

export function ensureTemplate(name: string, template: string, keys: string[]): void {
  if (!template) {
    throw new Error(`Missing template: ${name}`);
  }
  for (const key of keys) {
    if (!template.includes(`{${key}}`)) {
      throw new Error(`${name} must include {${key}}`);
    }
  }
}

export function shQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  let rendered = template;
  for (const [key, value] of Object.entries(vars)) {
    rendered = rendered.replaceAll(`{${key}}`, shQuote(value));
  }
  return rendered;
}

export function tryParseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // no-op
  }
  const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      // no-op
    }
  }
  return null;
}

function deepFindString(input: unknown, keys: string[]): string {
  if (!input || typeof input !== "object") return "";
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const value of Object.values(input as Record<string, unknown>)) {
    if (typeof value === "object" && value) {
      const nested = deepFindString(value, keys);
      if (nested) return nested;
    }
  }
  return "";
}

export function extractSessionId(raw: string, parsed: unknown): string {
  const fromJson = deepFindString(parsed, [
    "session_id",
    "sessionId",
    "thread_id",
    "threadId",
    "conversation_id",
    "conversationId",
  ]);
  if (fromJson) return fromJson;
  const fromText =
    raw.match(/(?:session|thread|conversation)[-_ ]?id["'\s:=]+([A-Za-z0-9._:-]+)/i) ||
    raw.match(/id["'\s:=]+([A-Za-z0-9._:-]{6,})/i);
  return fromText ? fromText[1] : "";
}

export function extractText(raw: string, parsed: unknown): string {
  const fromJson = deepFindString(parsed, [
    "text",
    "output_text",
    "response",
    "content",
    "message",
    "answer",
  ]);
  if (fromJson) return fromJson;
  return raw.trim();
}

function streamLines(
  chunk: string,
  remainder: string,
  sink: (line: string) => void,
): string {
  const combined = remainder + chunk;
  const lines = combined.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i += 1) {
    if (lines[i]) sink(lines[i]);
  }
  return lines[lines.length - 1] ?? "";
}

export class CliAgentRunner implements AgentRunner {
  private activeChild: ChildProcessWithoutNullStreams | null = null;
  private activeKillTimer: NodeJS.Timeout | null = null;

  cancelActive(): void {
    if (!this.activeChild) return;
    this.activeChild.kill("SIGTERM");
    if (this.activeKillTimer) clearTimeout(this.activeKillTimer);
    this.activeKillTimer = setTimeout(() => {
      if (this.activeChild && !this.activeChild.killed) {
        this.activeChild.kill("SIGKILL");
      }
    }, 1500);
  }

  async runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
    const command = renderTemplate(
      options.sessionId ? options.commandTemplates.resume : options.commandTemplates.start,
      {
        prompt: options.prompt,
        session_id: options.sessionId ?? "",
      },
    );

    return new Promise<AgentRunResult>((resolve, reject) => {
      const child = spawn("zsh", ["-lc", command], { stdio: ["pipe", "pipe", "pipe"] });
      this.activeChild = child;

      let stdout = "";
      let stderr = "";
      let stdoutRemainder = "";
      let stderrRemainder = "";
      let timeoutId: NodeJS.Timeout | null = null;
      let settled = false;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (this.activeKillTimer) clearTimeout(this.activeKillTimer);
        this.activeKillTimer = null;
        if (this.activeChild === child) {
          this.activeChild = null;
        }
      };

      if (options.timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGTERM");
          cleanup();
          reject(new Error(`${options.agent} command timeout (${options.timeoutMs}ms)`));
        }, options.timeoutMs);
      }

      child.stdout.on("data", (buffer: Buffer) => {
        const chunk = buffer.toString();
        stdout += chunk;
        if (options.onStdoutLine) {
          stdoutRemainder = streamLines(chunk, stdoutRemainder, options.onStdoutLine);
        }
      });

      child.stderr.on("data", (buffer: Buffer) => {
        const chunk = buffer.toString();
        stderr += chunk;
        if (options.onStderrLine) {
          stderrRemainder = streamLines(chunk, stderrRemainder, options.onStderrLine);
        }
      });

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });

      child.on("close", (exitCode) => {
        if (settled) return;
        settled = true;

        if (stdoutRemainder && options.onStdoutLine) {
          options.onStdoutLine(stdoutRemainder);
        }
        if (stderrRemainder && options.onStderrLine) {
          options.onStderrLine(stderrRemainder);
        }

        cleanup();

        if ((exitCode ?? 1) !== 0) {
          reject(
            new Error(
              `${options.agent} command failed (exit=${exitCode ?? 1})` +
                (stderr ? `: ${stderr}` : ""),
            ),
          );
          return;
        }

        const parsed = tryParseJson(stdout);
        resolve({
          stdout,
          stderr,
          text: extractText(stdout, parsed),
          sessionId: extractSessionId(stdout, parsed) || options.sessionId || "",
          command,
        });
      });
    });
  }
}

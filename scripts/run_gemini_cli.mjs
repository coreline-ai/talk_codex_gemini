#!/usr/bin/env node

import { spawn } from "node:child_process";

function parseArgs(argv) {
  const args = { mode: "start", session: "", prompt: "", timeoutMs: 120000 };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode") args.mode = argv[++i] ?? "start";
    else if (arg === "--session") args.session = argv[++i] ?? "";
    else if (arg === "--prompt") args.prompt = argv[++i] ?? "";
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i] ?? "120000");
  }
  return args;
}

function tryParseJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // no-op
  }
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      // no-op
    }
  }
  return null;
}

function runCommand(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500);
      reject(new Error(`gemini timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    child.stdout.on("data", (buf) => {
      stdout += buf.toString();
    });
    child.stderr.on("data", (buf) => {
      stderr += buf.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if ((code ?? 1) !== 0) {
        reject(new Error(`gemini failed (exit=${code ?? 1}): ${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) {
    throw new Error("prompt is required");
  }

  const runArgs = ["-m", "gemini-2.5-flash-lite", "--output-format", "json"];
  if (args.mode === "resume") {
    runArgs.push("--resume", args.session || "latest");
  }
  runArgs.push(prompt);

  const { stdout } = await runCommand("gemini", runArgs, Number.isFinite(args.timeoutMs) ? args.timeoutMs : 120000);
  const parsed = tryParseJson(stdout);
  const text =
    (parsed && typeof parsed === "object" && typeof parsed.response === "string" && parsed.response) ||
    (parsed && typeof parsed === "object" && typeof parsed.text === "string" && parsed.text) ||
    String(stdout).trim();

  // Gemini CLI JSON output doesn't expose a durable session id in this mode.
  // "latest" keeps resume behavior stable for this single-project flow.
  const sessionId = args.mode === "resume" ? args.session || "latest" : "latest";

  process.stdout.write(
    JSON.stringify({
      session_id: sessionId,
      text: String(text ?? "").trim(),
    }),
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

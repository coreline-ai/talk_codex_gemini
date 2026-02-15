#!/usr/bin/env node

import { spawn } from "node:child_process";

const CODEX_MODEL = process.env.CODEX_MODEL || "gpt-5-codex";

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

function runCommand(cmd, args, timeoutMs, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500);
      reject(new Error(`codex timeout (${timeoutMs}ms)`));
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
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function parseCodexJsonl(stdout) {
  const lines = String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let sessionId = "";
  const texts = [];
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed?.type === "thread.started" && typeof parsed.thread_id === "string") {
      sessionId = parsed.thread_id;
    }
    if (parsed?.type === "item.completed" && parsed.item?.type === "agent_message") {
      if (typeof parsed.item.text === "string" && parsed.item.text.trim()) {
        texts.push(parsed.item.text.trim());
      }
    }
  }

  return {
    sessionId,
    text: texts.join("\n").trim(),
  };
}

async function runCodexStart(prompt, timeoutMs, sessionHint = "") {
  const result = await runCommand(
    "codex",
    ["exec", "--skip-git-repo-check", "--json", "-m", CODEX_MODEL, prompt],
    timeoutMs,
    sessionHint ? { CODEX_SESSION_HINT: sessionHint } : {},
  );

  if (result.code !== 0) {
    throw new Error(`codex start failed (exit=${result.code}): ${result.stderr || result.stdout}`);
  }

  const parsed = parseCodexJsonl(result.stdout);
  return {
    session_id: parsed.sessionId || sessionHint || "",
    text: parsed.text || result.stdout.trim(),
    stdout: result.stdout,
  };
}

function isFallbackableResumeError(outputText) {
  const text = String(outputText ?? "");
  return (
    /Not inside a trusted directory/i.test(text) ||
    /stream disconnected before completion/i.test(text) ||
    /model .* does not exist/i.test(text) ||
    /do not have access/i.test(text) ||
    /not supported when using Codex/i.test(text)
  );
}

async function runCodexResume(sessionId, prompt, timeoutMs) {
  // First try true resume. If environment requires trusted git dir and blocks this mode,
  // fallback to fresh non-interactive exec while preserving operation continuity.
  const resumeAttempt = await runCommand(
    "codex",
    ["exec", "resume", "-c", `model="${CODEX_MODEL}"`, sessionId, prompt],
    timeoutMs,
  );

  if (resumeAttempt.code === 0) {
    // resume subcommand is not json mode; use plain output as assistant text.
    return {
      session_id: sessionId,
      text: resumeAttempt.stdout.trim() || resumeAttempt.stderr.trim(),
      stdout: resumeAttempt.stdout,
    };
  }

  const combined = `${resumeAttempt.stderr}\n${resumeAttempt.stdout}`;
  if (!isFallbackableResumeError(combined)) {
    throw new Error(
      `codex resume failed (exit=${resumeAttempt.code}): ${resumeAttempt.stderr || resumeAttempt.stdout}`,
    );
  }

  const fallback = await runCodexStart(prompt, timeoutMs, sessionId);
  return {
    session_id: fallback.session_id || sessionId,
    text: fallback.text,
    stdout: fallback.stdout,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) {
    throw new Error("prompt is required");
  }
  const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : 120000;

  let output;
  if (args.mode === "resume") {
    output = await runCodexResume(args.session, prompt, timeoutMs);
  } else {
    output = await runCodexStart(prompt, timeoutMs);
  }

  process.stdout.write(
    JSON.stringify({
      session_id: output.session_id,
      text: output.text,
    }),
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

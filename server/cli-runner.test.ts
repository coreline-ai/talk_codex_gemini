import { describe, expect, it } from "vitest";
import {
  extractSessionId,
  extractText,
  renderTemplate,
  shQuote,
  tryParseJson,
} from "./cli-runner.js";

describe("cli-runner utilities", () => {
  it("quotes single quotes safely", () => {
    expect(shQuote("a'b")).toBe("'a'\"'\"'b'");
  });

  it("renders template placeholders", () => {
    const command = renderTemplate("codex --prompt {prompt} --resume {session_id}", {
      prompt: "hello",
      session_id: "abc-123",
    });
    expect(command).toContain("--prompt 'hello'");
    expect(command).toContain("--resume 'abc-123'");
  });

  it("extracts session id from parsed json", () => {
    const parsed = { session_id: "gem-1", text: "ok" };
    expect(extractSessionId("", parsed)).toBe("gem-1");
  });

  it("extracts session id from raw text fallback", () => {
    const raw = "session id: codex-session-77";
    expect(extractSessionId(raw, null)).toBe("codex-session-77");
  });

  it("extracts text from json or raw fallback", () => {
    expect(extractText("", { output_text: "hello" })).toBe("hello");
    expect(extractText("raw body", null)).toBe("raw body");
  });

  it("parses json by full text or last line", () => {
    expect(tryParseJson('{"x":1}')).toEqual({ x: 1 });
    expect(tryParseJson("noise\n{\"y\":2}\n")).toEqual({ y: 2 });
  });
});

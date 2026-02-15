import { describe, expect, it } from "vitest";
import { getControlAvailability, initialUiState, uiReducer } from "./state";

describe("ui state", () => {
  it("enables start only when both agents ready and topic set", () => {
    let state = { ...initialUiState };
    let controls = getControlAvailability(state);
    expect(controls.canStart).toBe(false);

    state = uiReducer(state, { type: "set_topic", topic: "테스트 주제" });
    state = uiReducer(state, {
      type: "agent_status",
      payload: { agent: "gemini", status: "ready", sessionId: "g1" },
    });
    controls = getControlAvailability(state);
    expect(controls.canStart).toBe(false);

    state = uiReducer(state, {
      type: "agent_status",
      payload: { agent: "codex", status: "ready", sessionId: "c1" },
    });
    controls = getControlAvailability(state);
    expect(controls.canStart).toBe(true);
  });

  it("sets control availability for pause/resume/stop", () => {
    let state = { ...initialUiState };
    state = uiReducer(state, {
      type: "debate_state",
      payload: { status: "running", round: 1, runId: "r1" },
    });
    let controls = getControlAvailability(state);
    expect(controls.canPause).toBe(true);
    expect(controls.canResume).toBe(false);
    expect(controls.canStop).toBe(true);

    state = uiReducer(state, {
      type: "debate_state",
      payload: { status: "paused", round: 1, runId: "r1" },
    });
    controls = getControlAvailability(state);
    expect(controls.canPause).toBe(false);
    expect(controls.canResume).toBe(true);
    expect(controls.canStop).toBe(true);
  });

  it("updates text limit input and debate text limit", () => {
    let state = { ...initialUiState };
    state = uiReducer(state, { type: "set_text_limit", value: 150 });
    expect(state.textLimitInput).toBe(150);

    state = uiReducer(state, {
      type: "debate_state",
      payload: { status: "idle", textLimit: 150 },
    });
    expect(state.debate.textLimit).toBe(150);
  });

  it("appends chat message and clears on reset", () => {
    let state = { ...initialUiState };
    state = uiReducer(state, {
      type: "append_message",
      payload: {
        id: "m1",
        role: "codex",
        text: "테스트 메시지",
        ts: new Date().toISOString(),
      },
    });
    expect(state.messages.length).toBe(1);

    state = uiReducer(state, { type: "reset_panels" });
    expect(state.messages.length).toBe(0);
  });
});

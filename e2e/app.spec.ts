import { test, expect } from "@playwright/test";

test.describe.skip("Gemini-Codex simulator UI", () => {
  test("renders 3 panel layout", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Gemini CLI")).toBeVisible();
    await expect(page.getByText("Debate Relay")).toBeVisible();
    await expect(page.getByText("Codex CLI")).toBeVisible();
  });
});

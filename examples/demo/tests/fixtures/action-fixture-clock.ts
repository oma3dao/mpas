import { afterEach, beforeEach, vi } from "vitest";

const ACTION_FIXTURE_NOW = new Date("2026-06-05T18:30:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ACTION_FIXTURE_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

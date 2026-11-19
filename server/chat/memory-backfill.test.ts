import { describe, expect, it, vi, beforeEach } from "vitest";

const findActiveMemoryBackfill = vi.fn();
const createMemoryBackfill = vi.fn();
const getMemoryBackfillById = vi.fn();
const updateMemoryBackfillProgress = vi.fn();
const setMemoryBackfillStatus = vi.fn();
const getPersonaById = vi.fn();
const getPersonaFileById = vi.fn();

vi.mock("../db", () => ({
  findActiveMemoryBackfill: (...a: unknown[]) => findActiveMemoryBackfill(...a),
  createMemoryBackfill: (...a: unknown[]) => createMemoryBackfill(...a),
  getMemoryBackfillById: (...a: unknown[]) => getMemoryBackfillById(...a),
  updateMemoryBackfillProgress: (...a: unknown[]) => updateMemoryBackfillProgress(...a),
  setMemoryBackfillStatus: (...a: unknown[]) => setMemoryBackfillStatus(...a),
  getPersonaById: (...a: unknown[]) => getPersonaById(...a),
  getPersonaFileById: (...a: unknown[]) => getPersonaFileById(...a),
}));

const storageReadText = vi.fn();
vi.mock("../storage", () => ({
  storageReadText: (...a: unknown[]) => storageReadText(...a),
}));

const extractMemories = vi.fn();
vi.mock("./memory-extract", () => ({
  extractMemories: (...a: unknown[]) => extractMemories(...a),
}));

import {
  previewBackfill,
  resumeMemoryBackfill,
  runBackfillBatches,
  startBackfillFromFile,
  startMemoryBackfill,
} from "./memory-backfill";
import type { ChatLogBatch } from "./log-parse";

/** An empty ChatLogBatch, or one holding the given messages. */
const batch = (messages: ChatLogBatch["messages"] = []): ChatLogBatch => ({
  messages,
  start: messages[0]?.at ?? null,
  end: messages[messages.length - 1]?.at ?? null,
  chars: 0,
});

/**
 * The memory backfill: a run that reads an uploaded chat log batch by
 * batch and stores what it finds as memories. The row is the progress,
 * so the tests check the row is written the way the run went.
 */

const NOW = new Date("2026-01-15T12:00:00Z");

const persona = { id: 1, userId: 1, name: "小A" } as any;
const file = { id: 5, personaId: 1, userId: 1, fileKey: "personas/1/1/log.txt" } as any;

const SAMPLE = [
  "[2026-08-10 15:30:00] 我：我们八月去看海吧",
  "[2026-08-10 15:31:00] TA：好呀，说定了",
  "[2026-08-10 15:32:00] 我：拉钩",
  "[2026-09-03 09:00:00] TA：生日快乐呀",
].join("\n");

beforeEach(() => {
  for (const fn of [
    findActiveMemoryBackfill,
    createMemoryBackfill,
    getMemoryBackfillById,
    updateMemoryBackfillProgress,
    setMemoryBackfillStatus,
    storageReadText,
    extractMemories,
  ]) {
    fn.mockReset();
  }
  findActiveMemoryBackfill.mockResolvedValue(null);
  createMemoryBackfill.mockResolvedValue(77);
  getPersonaById.mockResolvedValue(persona);
  getPersonaFileById.mockResolvedValue(file);
  getMemoryBackfillById.mockResolvedValue({ id: 77, status: "running" });
  updateMemoryBackfillProgress.mockResolvedValue(undefined);
  setMemoryBackfillStatus.mockResolvedValue(undefined);
  storageReadText.mockResolvedValue(SAMPLE);
  extractMemories.mockResolvedValue({ added: [{ id: 1, title: "x" }], readable: true });
});

describe("previewBackfill", () => {
  it("counts the messages and batches a file would cost", () => {
    const preview = previewBackfill(SAMPLE);
    expect(preview.messages).toBe(4);
    expect(preview.batches).toBeGreaterThan(0);
    expect(preview.estimatedCalls).toBe(preview.batches);
  });

  it("sees nothing in an empty file", () => {
    expect(previewBackfill("saya 4.2\n由 Moect 导出")).toEqual({
      messages: 0,
      batches: 0,
      estimatedCalls: 0,
    });
  });
});

describe("startMemoryBackfill", () => {
  it("refuses when a run is already alive", async () => {
    findActiveMemoryBackfill.mockResolvedValue({ id: 42, status: "running" });

    const result = await startMemoryBackfill({ persona, userId: 1, file, locale: "zh" });

    expect(result.started).toBe(false);
    expect(result.reason).toBe("running");
    // Nothing was read and nothing was created.
    expect(storageReadText).not.toHaveBeenCalled();
    expect(createMemoryBackfill).not.toHaveBeenCalled();
  });

  it("refuses a file that parses to nothing", async () => {
    storageReadText.mockResolvedValue("由 Moect 导出\n");

    const result = await startMemoryBackfill({ persona, userId: 1, file, locale: "zh" });

    expect(result.started).toBe(false);
    expect(result.reason).toBe("empty");
    expect(createMemoryBackfill).not.toHaveBeenCalled();
  });

  it("reads the file, batches it, and opens the progress row", async () => {
    const result = await startMemoryBackfill({ persona, userId: 1, file, locale: "zh" });

    expect(result.started).toBe(true);
    expect(storageReadText).toHaveBeenCalledWith("personas/1/1/log.txt");
    expect(createMemoryBackfill).toHaveBeenCalledWith(
      expect.objectContaining({ personaId: 1, userId: 1, fileId: 5, status: "running" }),
    );
    expect(result.done).toBeInstanceOf(Promise);
    await result.done;
  });
});

describe("runBackfillBatches", () => {
  it("hands every batch to the extraction with the backfill's words", async () => {
    await runBackfillBatches({ backfillId: 77, persona, userId: 1, locale: "zh", batches: [batch(), batch(), batch()], pauseMs: 0 });

    expect(extractMemories).toHaveBeenCalledTimes(3);
    const first = extractMemories.mock.calls[0][0];
    expect(first.promptOverride).toBeTruthy();
    expect(first.promptOverride).not.toContain("undefined");
    expect(first.persona).toBe(persona);
  });

  it("maps the transcript into history with the speakers the pipeline knows", async () => {
    const { batchChatLog, parseChatLog } = await import("./log-parse");
    const batches = batchChatLog(parseChatLog(SAMPLE));

    await runBackfillBatches({ backfillId: 77, persona, userId: 1, locale: "zh", batches, pauseMs: 0 });

    const history = extractMemories.mock.calls[0][0].history;
    expect(history).toHaveLength(4);
    expect(history[0]).toMatchObject({ role: "user", content: "我们八月去看海吧" });
    expect(history[1]).toMatchObject({ role: "assistant", content: "好呀，说定了" });
    expect(history[3]).toMatchObject({ role: "assistant", content: "生日快乐呀" });
    expect(history[0].createdAt.getFullYear()).toBe(2026);
    expect(history[0].createdAt.getMonth()).toBe(7);
  });

  it("stamps the lines so the model can date what it finds", async () => {
    const { batchChatLog, parseChatLog } = await import("./log-parse");
    const batches = batchChatLog(parseChatLog(SAMPLE));

    await runBackfillBatches({ backfillId: 77, persona, userId: 1, locale: "zh", batches, pauseMs: 0 });

    expect(extractMemories.mock.calls[0][0].withTimestamps).toBe(true);
  });

  it("writes the progress after every batch and closes as done", async () => {
    extractMemories.mockResolvedValue({ added: [{ id: 1 }, { id: 2 }], readable: true });

    await runBackfillBatches({ backfillId: 77, persona, userId: 1, locale: "zh", batches: [batch(), batch(), batch()], pauseMs: 0 });

    expect(updateMemoryBackfillProgress).toHaveBeenNthCalledWith(1, 77, 1, 1, 2);
    expect(updateMemoryBackfillProgress).toHaveBeenNthCalledWith(2, 77, 1, 2, 4);
    expect(updateMemoryBackfillProgress).toHaveBeenNthCalledWith(3, 77, 1, 3, 6);
    expect(setMemoryBackfillStatus).toHaveBeenLastCalledWith(77, 1, "done");
  });

  it("stops when the run was cancelled, without overwriting the cancel", async () => {
    getMemoryBackfillById.mockResolvedValueOnce({ id: 77, status: "running" })
      .mockResolvedValueOnce({ id: 77, status: "cancelled" });

    await runBackfillBatches({ backfillId: 77, persona, userId: 1, locale: "zh", batches: [batch(), batch(), batch()], pauseMs: 0 });

    expect(extractMemories).toHaveBeenCalledTimes(1);
    expect(setMemoryBackfillStatus).not.toHaveBeenCalled();
  });

  it("marks the run failed when a batch throws, keeping the progress", async () => {
    extractMemories.mockResolvedValueOnce({ added: [{ id: 1 }], readable: true })
      .mockRejectedValueOnce(new Error("provider down"));

    await runBackfillBatches({ backfillId: 77, persona, userId: 1, locale: "zh", batches: [batch(), batch(), batch()], pauseMs: 0 });

    expect(updateMemoryBackfillProgress).toHaveBeenCalledWith(77, 1, 1, 1);
    expect(setMemoryBackfillStatus).toHaveBeenCalledWith(77, 1, "failed", "provider down");
    // The third batch was never asked.
    expect(extractMemories).toHaveBeenCalledTimes(2);
  });

  it("picks up where a finished run left off", async () => {
    await runBackfillBatches({
      backfillId: 77, persona, userId: 1, locale: "zh", batches: [batch(), batch(), batch(), batch(), batch()], pauseMs: 0, startFrom: 3,
    });

    expect(extractMemories).toHaveBeenCalledTimes(2);
    expect(updateMemoryBackfillProgress).toHaveBeenNthCalledWith(1, 77, 1, 4, expect.any(Number));
    expect(updateMemoryBackfillProgress).toHaveBeenNthCalledWith(2, 77, 1, 5, expect.any(Number));
  });
});

describe("startBackfillFromFile", () => {
  it("refuses a persona that is not the caller's", async () => {
    getPersonaById.mockResolvedValue(null);

    const result = await startBackfillFromFile({ personaId: 1, userId: 1, fileId: 5, locale: "zh" });

    expect(result.started).toBe(false);
    expect(result.reason).toBe("persona");
    expect(getPersonaFileById).not.toHaveBeenCalled();
  });

  it("refuses a file that is not the caller's, or not this persona's", async () => {
    getPersonaFileById.mockResolvedValue({ ...file, personaId: 2 });

    const result = await startBackfillFromFile({ personaId: 1, userId: 1, fileId: 5, locale: "zh" });

    expect(result.started).toBe(false);
    expect(result.reason).toBe("file");
  });

  it("refuses a file that is not a chat log", async () => {
    getPersonaFileById.mockResolvedValue({ ...file, fileType: "image" });

    const result = await startBackfillFromFile({ personaId: 1, userId: 1, fileId: 5, locale: "zh" });

    expect(result.started).toBe(false);
    expect(result.reason).toBe("fileType");
    expect(storageReadText).not.toHaveBeenCalled();
  });

  it("starts the run with the persona and the file", async () => {
    getPersonaFileById.mockResolvedValue({ ...file, fileType: "chat_txt" });

    const result = await startBackfillFromFile({ personaId: 1, userId: 1, fileId: 5, locale: "zh" });

    expect(result.started).toBe(true);
    expect(createMemoryBackfill).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 5, personaId: 1, userId: 1 }),
    );
    await result.done;
  });
});

describe("resumeMemoryBackfill", () => {
  it("refuses a run that is not there", async () => {
    getMemoryBackfillById.mockResolvedValue(null);

    const result = await resumeMemoryBackfill({ backfillId: 77, userId: 1, locale: "zh" });

    expect(result.resumed).toBe(false);
    expect(result.reason).toBe("missing");
  });

  it("refuses a run that is done or still going", async () => {
    getMemoryBackfillById.mockResolvedValue({ id: 77, status: "done", doneBatches: 3, totalBatches: 3 });

    const result = await resumeMemoryBackfill({ backfillId: 77, userId: 1, locale: "zh" });

    expect(result.resumed).toBe(false);
    expect(result.reason).toBe("notResumable");
  });

  it("picks up from the row's progress and reopens it as running", async () => {
    // The row the resume reads, and then the row the loop sees — the
    // status write between the two is what the mock cannot follow, so
    // it is given by call order.
    getMemoryBackfillById.mockResolvedValueOnce({
      id: 77, personaId: 1, userId: 1, fileId: 5,
      status: "failed", doneBatches: 1, totalBatches: 2, memoriesAdded: 37,
    }).mockResolvedValue({ id: 77, status: "running" });
    // The same file, cut again: two batches, the first already done.
    storageReadText.mockResolvedValue(SAMPLE.repeat(300));

    const result = await resumeMemoryBackfill({ backfillId: 77, userId: 1, locale: "zh" });

    expect(result.resumed).toBe(true);
    expect(setMemoryBackfillStatus).toHaveBeenCalledWith(77, 1, "running");
    // The run is in the background; the progress lands when it is over.
    await result.done;
    // The second batch was the only one left; the memories counted
    // before stay counted.
    expect(updateMemoryBackfillProgress).toHaveBeenNthCalledWith(1, 77, 1, 2, expect.any(Number));
    expect(setMemoryBackfillStatus).toHaveBeenLastCalledWith(77, 1, "done");
  });

  it("marks the resume failed when the file has gone", async () => {
    getMemoryBackfillById.mockResolvedValue({
      id: 77, personaId: 1, userId: 1, fileId: 5,
      status: "failed", doneBatches: 4, totalBatches: 6, memoriesAdded: 37,
    });
    storageReadText.mockRejectedValue(new Error("ENOENT"));

    const result = await resumeMemoryBackfill({ backfillId: 77, userId: 1, locale: "zh" });

    expect(result.resumed).toBe(false);
    expect(result.reason).toBe("file");
    expect(setMemoryBackfillStatus).toHaveBeenCalledWith(77, 1, "failed", "ENOENT");
  });
});

/**
 * The memory backfill: a run that reads an uploaded chat log batch by
 * batch and stores what it finds as memories.
 *
 * The daily extraction reads the conversation as it happens and stops
 * at the present. The backfill reads the past — the months an export
 * holds that no distillation ever saw — so the persona not only sounds
 * right but remembers what actually happened.
 *
 * The run is long (dozens of model calls), so it is a background job
 * with its progress on a row: which batch it reached and how much it
 * added. The row is the resume point, so an interrupted run is taken up
 * again rather than paid for twice.
 */
import { copy } from "@shared/copy";
import type { InsertMemoryBackfill, Persona } from "../../drizzle/schema";
import {
  createMemoryBackfill,
  findActiveMemoryBackfill,
  getMemoryBackfillById,
  getPersonaById,
  getPersonaFileById,
  setMemoryBackfillStatus,
  updateMemoryBackfillProgress,
} from "../db";
import { storageReadText } from "../storage";
import { extractMemories } from "./memory-extract";
import { batchChatLog, parseChatLog, type ChatLogBatch, type ParsedLogMessage } from "./log-parse";

/** The shape a start (or its refusal) reports back to the caller. */
export interface BackfillStart {
  started: boolean;
  reason?: "running" | "empty";
  backfillId?: number;
  totalBatches?: number;
  /** Resolves when the whole run has finished — tests await it. */
  done?: Promise<void>;
}

/** What a file would cost, before the caller commits to it. */
export interface BackfillPreview {
  messages: number;
  batches: number;
  estimatedCalls: number;
}

export function previewBackfill(text: string): BackfillPreview {
  const batches = batchChatLog(parseChatLog(text));
  return {
    messages: batches.reduce((sum, b) => sum + b.messages.length, 0),
    batches: batches.length,
    estimatedCalls: batches.length,
  };
}

// i18n:allow-input — these are matched against what the user pasted in.
/**
 * The labels a pasted transcript uses for the two sides, mapped onto the
 * roles the extraction pipeline renders. Any other name — the export's
 * own — goes through unchanged, and the model sees it as it was.
 */
const LABEL_ROLES: Record<string, string> = {
  "我": "user",
  "我方": "user",
  "自己": "user",
  "TA": "assistant",
  "ta": "assistant",
};

function toHistory(messages: ParsedLogMessage[]): Array<{
  id: number;
  role: string;
  content: string;
  createdAt: Date;
}> {
  let last: Date | null = null;
  return messages.map((m) => {
    const at = m.at ?? last ?? new Date(0);
    if (m.at) last = m.at;
    return { id: 0, role: LABEL_ROLES[m.speaker] ?? m.speaker, content: m.content, createdAt: at };
  });
}

/**
 * Starts a backfill: reads the whole file once, batches it, opens the
 * progress row, and hands the loop to the background.
 *
 * At most one run per persona — an alive one (running and heard from
 * lately) refuses the new start, so a double click does not pay twice.
 */
export async function startMemoryBackfill(params: {
  persona: Persona;
  userId: number;
  file: { id: number; fileKey: string };
  locale?: "zh" | "en";
}): Promise<BackfillStart> {
  const { persona, userId, file, locale = "zh" } = params;

  const active = await findActiveMemoryBackfill(persona.id, userId);
  if (active) return { started: false, reason: "running" };

  // Read once, up front: the batches are cut from one string in memory,
  // and a file deleted mid-run cannot break a run that already holds it.
  const text = await storageReadText(file.fileKey);
  const batches = batchChatLog(parseChatLog(text));
  if (batches.length === 0) return { started: false, reason: "empty" };

  const input: InsertMemoryBackfill = {
    personaId: persona.id,
    userId,
    fileId: file.id,
    totalBatches: batches.length,
    status: "running",
  };
  const backfillId = await createMemoryBackfill(input);

  const done = runBackfillBatches({ backfillId, persona, userId, locale, batches })
    .catch(() => undefined);
  return { started: true, backfillId, totalBatches: batches.length, done };
}

/**
 * The loop. One extraction per batch, the progress written after each —
 * the write lands after the memories do, so a run killed between the two
 * re-reads one batch, and re-reading is safe.
 *
 * A cancelled run stops without closing: the cancel is already on the
 * row, and "done" must not overwrite it. A thrown batch marks the run
 * failed with the error, keeping the progress it reached.
 */
export async function runBackfillBatches(params: {
  backfillId: number;
  persona: Persona;
  userId: number;
  locale?: "zh" | "en";
  batches: ChatLogBatch[];
  pauseMs?: number;
  /** The batches already done — where a resumed run picks up. */
  startFrom?: number;
  /** Memories the row already counts, from before the resume. */
  startAdded?: number;
}): Promise<void> {
  const { backfillId, persona, userId, batches } = params;
  const locale = params.locale ?? "zh";
  const pauseMs = params.pauseMs ?? 1_000;
  const startFrom = params.startFrom ?? 0;
  const startAdded = params.startAdded ?? 0;
  const prompt = copy(locale, "prompts.memoryExtractionBackfill");

  try {
    let done = startFrom;
    let added = startAdded;
    for (let i = startFrom; i < batches.length; i++) {
      const row = await getMemoryBackfillById(backfillId, userId);
      if (!row || row.status === "cancelled") return;

      const result = await extractMemories({
        persona,
        userId,
        locale,
        history: toHistory(batches[i].messages),
        promptOverride: prompt,
        withTimestamps: true,
      });
      done += 1;
      added += result?.added?.length ?? 0;
      await updateMemoryBackfillProgress(backfillId, userId, done, added);

      if (pauseMs > 0 && i < batches.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
      }
    }
    const final = await getMemoryBackfillById(backfillId, userId);
    if (final && final.status === "running") {
      await setMemoryBackfillStatus(backfillId, userId, "done");
    }
  } catch (e) {
    // The status write is best effort — a run that cannot even record
    // its own failure must not throw out of the background loop.
    try {
      await setMemoryBackfillStatus(backfillId, userId, "failed", (e as Error).message);
    } catch {
      /* nothing more can be done here */
    }
  }
}

/**
 * The start the interface calls: it looks the persona and the file up
 * itself, so the caller only names them. The file has to be the
 * caller's, belong to the persona, and be a chat log — a photograph has
 * no transcript in it.
 */
/** A start that can also refuse on the persona, the file, or its kind. */
export type BackfillStartFromFile = Omit<BackfillStart, "reason"> & {
  reason?: "running" | "empty" | "persona" | "file" | "fileType";
};

export async function startBackfillFromFile(params: {
  personaId: number;
  userId: number;
  fileId: number;
  locale?: "zh" | "en";
}): Promise<BackfillStartFromFile> {
  const { personaId, userId, fileId, locale = "zh" } = params;

  const persona = await getPersonaById(personaId, userId);
  if (!persona) return { started: false, reason: "persona" };

  const file = await getPersonaFileById(fileId, userId);
  if (!file || file.personaId !== personaId) return { started: false, reason: "file" };
  if (file.fileType !== "chat_txt" && file.fileType !== "chat_csv") {
    return { started: false, reason: "fileType" };
  }

  return startMemoryBackfill({
    persona,
    userId,
    file: { id: file.id, fileKey: file.fileKey },
    locale,
  });
}

/**
 * Takes an interrupted run up again, from where its row says it got to.
 *
 * The batches are cut again from the same file — the cut is
 * deterministic, so "the fourth batch" names the same messages it did
 * the first time. A file that has gone marks the run failed again; it
 * does not lose the progress, only the hope of continuing it.
 */
export async function resumeMemoryBackfill(params: {
  backfillId: number;
  userId: number;
  locale?: "zh" | "en";
}): Promise<{
  resumed: boolean;
  reason?: "missing" | "notResumable" | "file" | "persona";
  backfillId?: number;
  totalBatches?: number;
  done?: Promise<void>;
}> {
  const { backfillId, userId, locale = "zh" } = params;

  const row = await getMemoryBackfillById(backfillId, userId);
  if (!row) return { resumed: false, reason: "missing" };
  if (row.status !== "failed" && row.status !== "cancelled") {
    return { resumed: false, reason: "notResumable" };
  }

  const persona = await getPersonaById(row.personaId, userId);
  if (!persona) return { resumed: false, reason: "persona" };

  const file = await getPersonaFileById(row.fileId, userId);
  if (!file) return { resumed: false, reason: "file" };

  let text: string;
  try {
    text = await storageReadText(file.fileKey);
  } catch (e) {
    await setMemoryBackfillStatus(backfillId, userId, "failed", (e as Error).message);
    return { resumed: false, reason: "file" };
  }
  const batches = batchChatLog(parseChatLog(text));
  const startFrom = Math.min(row.doneBatches, batches.length);
  if (startFrom >= batches.length) {
    await setMemoryBackfillStatus(backfillId, userId, "done");
    return { resumed: false, reason: "notResumable" };
  }

  await setMemoryBackfillStatus(backfillId, userId, "running");
  const done = runBackfillBatches({
    backfillId,
    persona,
    userId,
    locale,
    batches,
    startFrom,
    startAdded: row.memoriesAdded,
  }).catch(() => undefined);
  return { resumed: true, backfillId, totalBatches: batches.length, done };
}

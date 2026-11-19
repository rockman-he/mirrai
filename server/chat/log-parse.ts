/**
 * Reads an uploaded chat log into messages, and cuts the messages into
 * batches the extraction model can read one at a time.
 *
 * Two formats arrive at the upload:
 *
 * - A tool export (Moect and friends) writes a header line
 *   `[timestamp] Name` and puts the message on the lines below it.
 * - A hand-pasted transcript writes one message per line, with the
 *   speaker in front of a colon: `[timestamp] 我：...` or `我：...`.
 *
 * Both are read into the same shape, with the *original* speaker names
 * kept: the extraction model works out whose memory a fact is, and the
 * name it should see is the name the export had.
 */

export interface ParsedLogMessage {
  /** When the message was said, when the line carries a readable timestamp. */
  at: Date | null;
  /** The speaker as the export spelled it — never normalized. */
  speaker: string;
  content: string;
}

export interface ChatLogBatch {
  messages: ParsedLogMessage[];
  start: Date | null;
  end: Date | null;
  /** Rough prompt cost of the batch, in characters. */
  chars: number;
}

/** How big one extraction batch may get, in characters. */
export const DEFAULT_BATCH_CHAR_BUDGET = 30_000;

/** `[2026-07-15 10:35:32] ` — the timestamp some exports put in front. */
const TS_PREFIX = /^\[(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2}(?::\d{2})?)\]\s*/;
const TS_DATE = /^\[(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\]/;

/** `speaker：content` — the app's own transcript shape. */
const SPEAKER_LINE = /^([^\s:：]{1,30})\s*[：:]\s*(.*)$/;

/** Whole-content media placeholders the export tool left behind. */
const MEDIA_TOKEN = /^[\[［【]([^】］］\]]{1,12})[\]］】]$/;
// i18n:allow-input — these are matched against what the export wrote.
const MEDIA_TOKENS = new Set([
  "图片", "动画表情", "表情", "语音", "视频", "文件", "链接", "名片",
  "转账", "红包", "位置", "合并转发", "聊天记录", "音乐", "卡片", "贴纸",
]);

// i18n:allow-input — these are matched against what the export wrote.
/** One-off system notices that carry no personality. */
const NOISE_PATTERNS = [
  "我通过了你的朋友验证请求",
  "以上是打招呼的消息",
  "对方不是中国大陆的账号",
  "系統已駁回",
  "系统已驳回",
  "已按导出设置跳过",
];

function isNoise(content: string): boolean {
  const media = MEDIA_TOKEN.exec(content);
  if (media && MEDIA_TOKENS.has(media[1].trim())) return true;
  return NOISE_PATTERNS.some((p) => content.includes(p));
}

/**
 * Whether the text in front of a colon can be a speaker at all.
 *
 * The colon is also what a time expression ("等8：30再說"), a bare URL
 * ("https://…") and pasted content ("一、要点：…") are made of — each of
 * those used to be cut into a fake speaker and a beheaded message. A
 * real name is short, free of sentence punctuation and markdown, not a
 * number, and does not end on the hour side of a time.
 */
function isSpeakerCandidate(candidate: string, content: string): boolean {
  if (!candidate || candidate.length > 20) return false;
  if (/[，。！？、；～…（）()「」『』《》“”‘’*#|>]/.test(candidate)) return false;
  if (/^\d+$/.test(candidate)) return false;
  if (/^(https?|ftp)$/i.test(candidate)) return false;
  if (/\d$/.test(candidate) && /^\d/.test(content)) return false;
  return true;
}

// i18n:allow-input — these are matched against what the export wrote.
/** Speakers the platform itself posts under, never a person. */
const SYSTEM_SPEAKERS = new Set(["系统", "系統", "系统消息", "系統訊息"]);

function parseTimestamp(date: string, clock: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm, ss] = clock.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm, ss || 0);
}

export function parseChatLog(text: string): ParsedLogMessage[] {
  const messages: ParsedLogMessage[] = [];
  let cur: ParsedLogMessage | null = null;

  const flush = () => {
    if (!cur) return;
    const done = cur;
    cur = null;
    const content = done.content.trim();
    if (!content || isNoise(content) || SYSTEM_SPEAKERS.has(done.speaker)) return;
    messages.push({ at: done.at, speaker: done.speaker, content });
  };

  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    let rest = line;
    let at: Date | null = null;
    const ts = TS_PREFIX.exec(line);
    if (ts) {
      at = parseTimestamp(ts[1], ts[2]);
      rest = line.slice(ts[0].length).trim();
    }

    // `speaker：content` on one line — with or without the timestamp.
    const speakerLine = SPEAKER_LINE.exec(rest);
    if (speakerLine && speakerLine[2] && isSpeakerCandidate(speakerLine[1].trim(), speakerLine[2])) {
      flush();
      cur = { at, speaker: speakerLine[1].trim(), content: speakerLine[2].trim() };
      continue;
    }

    if (ts && rest && !/[，。！？、；～…]/.test(rest)) {
      // A tool export's header: the message starts on the lines below.
      flush();
      cur = { at, speaker: rest, content: "" };
      continue;
    }

    // Anything else continues the message above it.
    if (cur) {
      cur.content = cur.content ? `${cur.content} ${rest}` : rest;
    }
  }
  flush();
  return messages;
}

/** The prompt cost of one message: its text plus the timestamp and label around it. */
function messageChars(m: ParsedLogMessage): number {
  return m.content.length + m.speaker.length + 26;
}

/**
 * Fills batches under the char budget, one message at a time. A message
 * is never cut in half: when the next one would overflow the batch, the
 * batch closes and a new one starts with it.
 */
export function batchChatLog(
  messages: ParsedLogMessage[],
  options: { charBudget?: number } = {},
): ChatLogBatch[] {
  const budget = options.charBudget ?? DEFAULT_BATCH_CHAR_BUDGET;

  const batches: ChatLogBatch[] = [];
  let current: ParsedLogMessage[] = [];
  let currentChars = 0;

  const pushBatch = (batch: ParsedLogMessage[], chars: number) => {
    if (!batch.length) return;
    batches.push({
      messages: batch,
      chars,
      start: batch[0].at,
      end: batch[batch.length - 1].at,
    });
  };

  for (const msg of messages) {
    const cost = messageChars(msg);
    if (current.length && currentChars + cost > budget) {
      pushBatch(current, currentChars);
      current = [];
      currentChars = 0;
    }
    current.push(msg);
    currentChars += cost;
  }
  pushBatch(current, currentChars);
  return batches;
}

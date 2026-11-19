import { describe, expect, it } from "vitest";
import { batchChatLog, DEFAULT_BATCH_CHAR_BUDGET, parseChatLog } from "./log-parse";

/** A Moect-style export: `[ts] Name` on one line, the content on the lines below. */
const MOECT_SAMPLE = `saya 4.2
由 Moect 导出

[2026-07-15 10:35:32] saya 4.2
系統已駁回要求

[2026-07-15 10:38:27] RockMan
我说的是电影，靠

[2026-07-15 10:41:30] saya 4.2
对方不是中国大陆的账号，涉及金钱交易务必电话确认，保护个人财产和隐私安全。

[2026-07-15 10:41:48] saya 4.2
沒辦法

[2026-07-15 10:47:54] saya 4.2
我真的是台灣啊
第二行繼續說

[2026-07-15 11:20:00] RockMan
[动画表情]
已按导出设置跳过图片/动画表情，保留消息与已有元数据。

[2026-07-15 11:20:10] RockMan
修理完客户了？`;

/** The app's own canonical transcript: one message per line, `speaker：content`. */
const CANONICAL_SAMPLE = `[2026-11-18 18:09:35] TA：下班

[2026-11-18 18:10:06] 我：抱我
[2026-11-18 18:10:09] 我：哈哈
我说的下一句没有标签
[2026-11-18 18:10:20] TA：你好騷

我：没有时间戳的一句`;

describe("parseChatLog", () => {
  it("reads a Moect export into messages with the original speaker names", () => {
    const messages = parseChatLog(MOECT_SAMPLE);
    // The export banner and the noise are gone; the real messages stay.
    expect(messages).toHaveLength(4);
    expect(messages[0]).toMatchObject({ speaker: "RockMan", content: "我说的是电影，靠" });
    expect(messages[1]).toMatchObject({ speaker: "saya 4.2", content: "沒辦法" });
    expect(messages[3]).toMatchObject({ speaker: "RockMan", content: "修理完客户了？" });
  });

  it("keeps the timestamp of each Moect message", () => {
    const messages = parseChatLog(MOECT_SAMPLE);
    expect(messages[1].at).not.toBeNull();
    expect(messages[1].at!.getFullYear()).toBe(2026);
    expect(messages[1].at!.getMonth()).toBe(6);
    expect(messages[1].at!.getDate()).toBe(15);
    expect(messages[1].at!.getHours()).toBe(10);
    expect(messages[1].at!.getMinutes()).toBe(41);
  });

  it("joins the wrapped lines of one Moect message with a space", () => {
    const messages = parseChatLog(MOECT_SAMPLE);
    expect(messages[2].content).toBe("我真的是台灣啊 第二行繼續說");
  });

  it("drops media placeholders, export notes and system notices", () => {
    const messages = parseChatLog(MOECT_SAMPLE);
    const contents = messages.map((m) => m.content);
    expect(contents).not.toContain("[动画表情]");
    expect(contents.some((c) => c.includes("已按导出设置"))).toBe(false);
    expect(contents.some((c) => c.includes("对方不是中国大陆的账号"))).toBe(false);
    expect(contents.some((c) => c.includes("系統已駁回"))).toBe(false);
  });

  it("reads the canonical one-line format too", () => {
    const messages = parseChatLog(CANONICAL_SAMPLE);
    expect(messages.map((m) => m.content)).toEqual([
      "下班",
      "抱我",
      "哈哈 我说的下一句没有标签",
      "你好騷",
      "没有时间戳的一句",
    ]);
    expect(messages.map((m) => m.speaker)).toEqual(["TA", "我", "我", "TA", "我"]);
  });

  it("leaves the timestamp empty for a canonical line that has none", () => {
    const messages = parseChatLog(CANONICAL_SAMPLE);
    expect(messages[4].at).toBeNull();
  });

  it("reads nothing from an empty or garbage input", () => {
    expect(parseChatLog("")).toEqual([]);
    expect(parseChatLog("   \n  \n")).toEqual([]);
  });

  it("does not cut a message at a time expression like 4：30", () => {
    const text = [
      "[2026-07-15 10:00:00] RockMan",
      "等8：30再說",
      "",
      "[2026-07-15 10:01:00] saya 4.2",
      "沒有，我剛剛4：30才下班",
      "",
      "[2026-07-15 10:02:00] RockMan",
      "寶寶，都12：30了還不睡",
    ].join("\n");
    const messages = parseChatLog(text);
    expect(messages.map((m) => m.speaker)).toEqual(["RockMan", "saya 4.2", "RockMan"]);
    expect(messages.map((m) => m.content)).toEqual([
      "等8：30再說",
      "沒有，我剛剛4：30才下班",
      "寶寶，都12：30了還不睡",
    ]);
  });

  it("does not mistake a bare URL for a speaker", () => {
    const text = [
      "[2026-07-15 10:00:00] RockMan",
      "看这个 https://example.com/file?id=1",
    ].join("\n");
    const messages = parseChatLog(text);
    expect(messages).toHaveLength(1);
    expect(messages[0].speaker).toBe("RockMan");
    expect(messages[0].content).toContain("https://example.com/file?id=1");
  });

  it("drops messages posted under a system speaker", () => {
    const text = [
      "[2026-07-15 10:00:00] 系统",
      "对方开启了好友验证",
      "",
      "[2026-07-15 10:01:00] RockMan",
      " normal",
    ].join("\n");
    const messages = parseChatLog(text);
    expect(messages).toHaveLength(1);
    expect(messages[0].speaker).toBe("RockMan");
  });
});

function msg(speaker: string, content: string, at: Date | null): { at: Date | null; speaker: string; content: string } {
  return { at, speaker, content };
}

describe("batchChatLog", () => {
  it("opens a new batch when the char budget would be exceeded", () => {
    const long = "字".repeat(200);
    const messages = Array.from({ length: 250 }, (_, i) =>
      msg(i % 2 ? "我" : "TA", long, new Date(2026, 6, 15, 10, 0, i)),
    );
    const batches = batchChatLog(messages, { charBudget: DEFAULT_BATCH_CHAR_BUDGET });
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.chars).toBeLessThanOrEqual(DEFAULT_BATCH_CHAR_BUDGET);
    }
  });

  it("still splits a single conversation that alone exceeds the budget", () => {
    const long = "字".repeat(400);
    const messages = Array.from({ length: 120 }, (_, i) =>
      msg("TA", long, new Date(2026, 6, 15, 10, 0, i)),
    );
    const batches = batchChatLog(messages, { charBudget: DEFAULT_BATCH_CHAR_BUDGET });
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.chars).toBeLessThanOrEqual(DEFAULT_BATCH_CHAR_BUDGET);
    }
  });

  it("never splits a message in half", () => {
    const long = "字".repeat(500);
    const messages = Array.from({ length: 80 }, (_, i) =>
      msg("TA", long, new Date(2026, 6, 15, 10, 0, i)),
    );
    const batches = batchChatLog(messages, { charBudget: DEFAULT_BATCH_CHAR_BUDGET });
    const all = batches.flatMap((b) => b.messages);
    expect(all).toEqual(messages);
  });

  it("carries the first and last timestamp of the batch", () => {
    const messages = [
      msg("TA", "一", new Date(2026, 6, 15, 10, 0, 0)),
      msg("我", "二", new Date(2026, 6, 15, 10, 10, 0)),
      msg("TA", "三", new Date(2026, 6, 15, 11, 0, 0)),
    ];
    const [batch] = batchChatLog(messages);
    expect(batch.start).toEqual(new Date(2026, 6, 15, 10, 0, 0));
    expect(batch.end).toEqual(new Date(2026, 6, 15, 11, 0, 0));
  });

  it("returns one batch for nothing", () => {
    expect(batchChatLog([])).toEqual([]);
  });

  it("is deterministic — the same input batches the same way twice", () => {
    const messages = Array.from({ length: 40 }, (_, i) =>
      msg("TA", `消息${i}`, new Date(2026, 6, 15, 10, 0, i * 2)),
    );
    const first = batchChatLog(messages);
    const second = batchChatLog(messages);
    expect(first).toEqual(second);
  });
});

# -*- coding: utf-8 -*-
"""
Plan A: time-stratified sampling of a Moect WeChat export for persona distillation.

Input : Moect export  `[YYYY-MM-DD HH:MM:SS] Name` newline content, blank line between.
Output: app-canonical transcript, one message per line, newest chunk first:
        `[YYYY-MM-DD HH:MM:SS] 我：<content>`  /  `TA：<content>`

Why this format: server/skill-engine/micro-rules.ts parses `speaker: content`
(no spaces in the name), so "saya 4.2" / "RockMan" would never attribute.
`我` / `TA` are the app's own canonical labels (SELF_LABELS / PERSONA_LABELS).

Sampling: messages are grouped into conversation chunks (>30 min gap = new
chunk), chunks are bucketed by month, and a recency-weighted share of chunks
is kept per bucket (seeded shuffle, reproducible). Newest chunks come first
so the analyzer's 30k-char head start reads the most recent style.
Budget: output stays under the upload-side 500k-char extraction cap, so
nothing in the file is silently dropped on upload.
"""
import json
import random
import re
import sys
from collections import Counter
from datetime import datetime

HEADER = re.compile(r"^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] (.+)$")
TS_FMT = "%Y-%m-%d %H:%M:%S"

SPEAKER_MAP = {"saya 4.2": "TA", "RockMan": "我"}

# Whole-message placeholders (media the export skipped) — dropped.
MEDIA_TOKENS = {
    "图片", "动画表情", "表情", "语音", "视频", "文件", "链接", "名片",
    "转账", "红包", "位置", "合并转发", "聊天记录", "音乐", "卡片",
    "原始图片", "贴纸",
}
MEDIA_RE = re.compile(r"^[\[［【]([^】］］\]]+)[\]］】]$")
EXPORT_NOTE = "已按导出设置跳过"

# One-off system notices that carry no personality.
SYSTEM_PATTERNS = (
    "我通过了你的朋友验证请求",
    "以上是打招呼的消息",
    "对方不是中国大陆的账号",
    "系統已駁回",
    "系统已驳回",
)

# Recency weights: share of each month's chunks to keep.
BUCKET_RATIOS = {11: 0.40, 10: 0.22, 9: 0.12, 8: 0.08, 7: 0.05}

CHAR_BUDGET = 400_000   # target size of the output file
CHAR_CEILING = 480_000  # hard cap, safely under the 500k extraction slice
CHUNK_GAP_MINUTES = 30


def parse(path):
    messages = []
    dropped_noise = 0
    skipped_speakers = Counter()
    cur = None  # [dt, speaker, [lines]]
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for raw in f:
            line = raw.rstrip("\n").rstrip("\r")
            m = HEADER.match(line.strip())
            if m:
                if cur:
                    messages.append(cur)
                ts, speaker = m.group(1), m.group(2).strip()
                cur = [datetime.strptime(ts, TS_FMT), speaker, []]
                continue
            if not line.strip():
                continue
            if cur is not None:
                cur[2].append(line.strip())
    if cur:
        messages.append(cur)

    cleaned = []
    for dt, speaker, lines in messages:
        content = " ".join(l for l in lines if l).strip()
        if not content:
            continue
        if speaker not in SPEAKER_MAP:
            skipped_speakers[speaker] += 1
            continue
        media = MEDIA_RE.match(content)
        if media and media.group(1).strip() in MEDIA_TOKENS:
            dropped_noise += 1
            continue
        if EXPORT_NOTE in content or any(p in content for p in SYSTEM_PATTERNS):
            dropped_noise += 1
            continue
        cleaned.append({"dt": dt, "role": SPEAKER_MAP[speaker], "content": content})
    return cleaned, len(messages), dropped_noise, skipped_speakers


def chunkize(messages):
    """Split into conversation chunks at >30 min gaps or day changes."""
    chunks = []
    cur = []
    for msg in messages:
        if cur:
            gap = (msg["dt"] - cur[-1]["dt"]).total_seconds() / 60
            same_day = msg["dt"].date() == cur[-1]["dt"].date()
            if gap > CHUNK_GAP_MINUTES or not same_day:
                chunks.append(cur)
                cur = []
        cur.append(msg)
    if cur:
        chunks.append(cur)
    return chunks


def line_for(msg):
    return f"[{msg['dt'].strftime(TS_FMT)}] {msg['role']}：{msg['content']}"


def chunk_text(chunk):
    return "\n\n".join(line_for(m) for m in chunk) + "\n"


def main():
    if len(sys.argv) != 3:
        print("usage: python -I distill_sample.py <input.txt> <output.txt>")
        sys.exit(2)
    src, dst = sys.argv[1], sys.argv[2]

    cleaned, raw_total, dropped_noise, skipped_speakers = parse(src)
    print(f"parsed messages: {raw_total}")
    print(f"dropped noise/media/system: {dropped_noise}")
    if skipped_speakers:
        print(f"unmapped speakers (skipped): {dict(skipped_speakers)}")
    print(f"kept after cleaning: {len(cleaned)}")
    if not cleaned:
        sys.exit("nothing left after cleaning")

    chunks = chunkize(cleaned)
    print(f"conversation chunks (>30min gap): {len(chunks)}")

    # Bucket by month, recency-weighted seeded selection.
    by_month = {}
    for ch in chunks:
        by_month.setdefault(ch[0]["dt"].month, []).append(ch)

    selected = []
    per_bucket = {}
    for month in sorted(by_month, reverse=True):
        bucket = sorted(by_month[month], key=lambda c: c[0]["dt"])
        ratio = BUCKET_RATIOS.get(month, 0.05)
        rng = random.Random(42)
        shuffled = bucket[:]
        rng.shuffle(shuffled)
        keep_n = max(1, round(len(bucket) * ratio))
        picked = shuffled[:keep_n]
        selected.extend(picked)
        per_bucket[f"2026-{month:02d}"] = {
            "chunks_total": len(bucket),
            "chunks_kept": len(picked),
            "msgs_kept": sum(len(c) for c in picked),
        }

    # Newest chunks first; chronological within a chunk.
    selected.sort(key=lambda c: c[0]["dt"], reverse=True)

    # Enforce the char budget from the oldest end.
    out_lines, total_chars, used = [], 0, 0
    for ch in selected:
        text = chunk_text(ch)
        if used + len(text) > CHAR_BUDGET and used > 0:
            break
        out_lines.append(text.rstrip("\n"))
        used += len(text)
        total_chars += len(text)

    body = "\n\n".join(out_lines) + "\n"
    with open(dst, "w", encoding="utf-8", newline="\n") as f:
        f.write(body)

    kept_msgs = sum(len(c) for c in selected[: len(out_lines)])
    first = min(c[0]["dt"] for c in selected[: len(out_lines)])
    last = max(c[-1]["dt"] for c in selected[: len(out_lines)])
    print(json.dumps(per_bucket, ensure_ascii=False, indent=2))
    print(f"output: {dst}")
    print(f"output messages: {kept_msgs}, chars: {total_chars} (budget {CHAR_BUDGET})")
    print(f"coverage: {first:%Y-%m-%d} -> {last:%Y-%m-%d}")
    # Sanity: every line must match the app's parser rules.
    bad = [l for l in body.splitlines()
           if l and not re.match(r"^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] (我|TA)：", l)]
    print(f"lines failing app format check: {len(bad)}")
    if bad[:3]:
        for b in bad[:3]:
            print("  BAD:", b[:80])


if __name__ == "__main__":
    main()

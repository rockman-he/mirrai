// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { translate } from "@/i18n";

/**
 * The backfill panel, per state.
 *
 * The point is that the states are *different from each other*: choosing
 * a file shows what it costs, a running job shows its progress and can
 * be stopped, a failed job says what went wrong and can be picked up
 * again.
 */

const invalidate = vi.fn().mockResolvedValue(undefined);
const startMutate = vi.fn();
const cancelMutate = vi.fn();
const resumeMutate = vi.fn();
const uploadMutate = vi.fn();

let files = [
  { id: 1, personaId: 1, fileType: "chat_txt", originalName: "full-log.txt", fileSize: 3_900_000 },
  { id: 2, personaId: 1, fileType: "image", originalName: "photo.png", fileSize: 800 },
  { id: 3, personaId: 1, fileType: "chat_csv", originalName: "log.csv", fileSize: 12_000 },
];

/**
 * The invalidation is a refetch: the list the query returns afterwards
 * holds the file the upload just created.
 */
const invalidateFiles = vi.fn().mockImplementation(() => {
  files = [...files, { id: 9, personaId: 1, fileType: "chat_txt", originalName: "uploaded.txt", fileSize: 100 }];
  return Promise.resolve();
});

let preview: { messages: number; batches: number; estimatedCalls: number } | undefined;
let status: { status: string; doneBatches: number; totalBatches: number; memoriesAdded: number; error: string | null } | null = null;

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      memory: { backfillStatus: { invalidate } },
      file: { list: { invalidate: invalidateFiles } },
    }),
    file: {
      list: { useQuery: () => ({ data: files }) },
      upload: {
        useMutation: (opts: any) => ({
          mutateAsync: (input: any) => {
            uploadMutate(input);
            const result = { fileId: 9, fileUrl: "/uploads/x" };
            if (opts?.onSuccess) opts.onSuccess(result);
            return Promise.resolve(result);
          },
          isPending: false,
        }),
      },
    },
    memory: {
      backfillPreview: {
        useQuery: (_input: any, _opts: any) => ({ data: preview, isFetching: false }),
      },
      backfillStatus: {
        useQuery: (_input: any, _opts: any) => ({ data: status }),
      },
      backfillStart: { useMutation: (opts: any) => ({ mutate: (input: any) => { startMutate(input); if (opts?.onSuccess) opts.onSuccess({ started: true, backfillId: 9, totalBatches: 4 }); }, isPending: false }) },
      backfillCancel: { useMutation: () => ({ mutate: cancelMutate, isPending: false }) },
      backfillResume: { useMutation: () => ({ mutate: resumeMutate, isPending: false }) },
    },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/contexts/LocaleContext", () => ({
  useLocale: () => ({
    t: (key: any, params?: any) => translate("zh", key, params),
    locale: "zh",
  }),
}));

import { MemoryBackfill } from "./MemoryBackfill";

beforeEach(() => {
  for (const fn of [invalidate, invalidateFiles, startMutate, cancelMutate, resumeMutate, uploadMutate]) fn.mockClear();
  invalidateFiles.mockClear();
  invalidateFiles.mockImplementation(() => {
    files = [...files, { id: 9, personaId: 1, fileType: "chat_txt", originalName: "uploaded.txt", fileSize: 100 }];
    return Promise.resolve();
  });
  files = [
    { id: 1, personaId: 1, fileType: "chat_txt", originalName: "full-log.txt", fileSize: 3_900_000 },
    { id: 2, personaId: 1, fileType: "image", originalName: "photo.png", fileSize: 800 },
    { id: 3, personaId: 1, fileType: "chat_csv", originalName: "log.csv", fileSize: 12_000 },
  ];
  preview = undefined;
  status = null;
});

describe("the memory backfill panel", () => {
  it("lists only the chat logs, not the photographs", () => {
    render(<MemoryBackfill personaId={1} onClose={() => {}} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    const names = Array.from(select.options).map((o) => o.textContent);
    expect(names).toContain("full-log.txt");
    expect(names).toContain("log.csv");
    expect(names).not.toContain("photo.png");
  });

  it("shows what a chosen file costs before the caller commits", async () => {
    preview = { messages: 56894, batches: 79, estimatedCalls: 79 };
    const user = userEvent.setup();
    render(<MemoryBackfill personaId={1} onClose={() => {}} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    await user.selectOptions(select, "1");
    await waitFor(() => {
      expect(screen.getByText("56,894 条消息，约 79 次调用")).toBeInTheDocument();
    });
  });

  it("starts the run for the chosen file", async () => {
    const user = userEvent.setup();
    render(<MemoryBackfill personaId={1} onClose={() => {}} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    await user.selectOptions(select, "1");
    await user.click(screen.getByRole("button", { name: "开始提取" }));
    expect(startMutate).toHaveBeenCalledWith({ personaId: 1, fileId: 1 });
  });

  it("shows the progress of a running job and can stop it", () => {
    status = { status: "running", doneBatches: 12, totalBatches: 79, memoriesAdded: 104, error: null };
    render(<MemoryBackfill personaId={1} onClose={() => {}} />);
    expect(screen.getByText("提取中：12/79 批")).toBeInTheDocument();
    expect(screen.getByText("已提取 104 条记忆")).toBeInTheDocument();
    const cancel = screen.getByRole("button", { name: "取消" });
    cancel.click();
    expect(cancelMutate).toHaveBeenCalled();
  });

  it("offers to pick a failed run up again", () => {
    status = { status: "failed", doneBatches: 12, totalBatches: 79, memoriesAdded: 104, error: "provider down" };
    render(<MemoryBackfill personaId={1} onClose={() => {}} />);
    expect(screen.getByText("提取失败：provider down")).toBeInTheDocument();
    screen.getByRole("button", { name: "继续提取" }).click();
    expect(resumeMutate).toHaveBeenCalled();
  });

  it("says a finished run is finished", () => {
    status = { status: "done", doneBatches: 79, totalBatches: 79, memoriesAdded: 612, error: null };
    render(<MemoryBackfill personaId={1} onClose={() => {}} />);
    expect(screen.getByText("提取完成，共写入 612 条记忆。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续提取" })).not.toBeInTheDocument();
  });
});

describe("uploading a local file from the panel", () => {
  const pickLocal = async (file: File) => {
    const user = userEvent.setup();
    render(<MemoryBackfill personaId={1} onClose={() => {}} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, file);
    return input;
  };

  it("uploads a chosen txt file and picks it as the new file", async () => {
    const file = new File(["[2026-08-10 15:30:00] 我：测试"], "原始记录.txt", { type: "text/plain" });

    await pickLocal(file);

    await waitFor(() => {
      expect(uploadMutate).toHaveBeenCalledWith(expect.objectContaining({
        personaId: 1,
        fileName: "原始记录.txt",
        fileType: "chat_txt",
        fileSize: file.size,
        mimeType: "text/plain",
      }));
    });
    // The base64 body is what crosses the wire, not the raw file — the
    // bytes of the file as the reader encoded them, UTF-8 and all.
    const content = "[2026-08-10 15:30:00] 我：测试";
    const expected = btoa(Array.from(new TextEncoder().encode(content), (b) => String.fromCharCode(b)).join(""));
    expect(uploadMutate.mock.calls[0][0].fileContent).toBe(expected);
    // The uploaded file becomes the one the panel works with.
    await waitFor(() => {
      expect(invalidateFiles).toHaveBeenCalled();
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      expect(select.value).toBe("9");
    });
  });

  it("refuses a file that is not a chat log, before reading it", async () => {
    const file = new File(["binary"], "photo.png", { type: "image/png" });

    await pickLocal(file);

    expect(uploadMutate).not.toHaveBeenCalled();
  });
});

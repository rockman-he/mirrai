import { useMemo, useState } from "react";
import { useLocale } from "@/contexts/LocaleContext";
import { useConfirm } from "@/components/ConfirmDialog";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { X } from "lucide-react";

/** The largest file the app accepts, mirrored from the upload page. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Reading an uploaded chat log into memories, in the memory panel.
 *
 * The run is long — dozens of model calls — so the panel is honest
 * before it starts (this many messages, this many calls, on your
 * provider's bill), while it runs (which batch it reached), and after
 * it failed (why, and a button to pick it up from where it stopped).
 */
export function MemoryBackfill({ personaId, onClose }: { personaId: number; onClose: () => void }) {
  const { t, locale } = useLocale();

  const { data: files } = trpc.file.list.useQuery({ personaId });
  const chatFiles = useMemo(
    () => (files ?? []).filter((f: any) => f.fileType === "chat_txt" || f.fileType === "chat_csv"),
    [files],
  );

  const [fileId, setFileId] = useState<number | null>(chatFiles[0]?.id ?? null);

  const enabled = fileId != null;
  const { data: preview, isFetching: previewing } = trpc.memory.backfillPreview.useQuery(
    { personaId, fileId: fileId! },
    { enabled },
  );

  /** The row is the progress; the poll follows it only while it moves. */
  const { data: status } = trpc.memory.backfillStatus.useQuery(
    { personaId },
    { refetchInterval: (query) => (query.state.data?.status === "running" ? 3000 : false) },
  );

  const utils = trpc.useUtils();
  const refreshStatus = () => {
    utils.memory.backfillStatus.invalidate().catch(() => undefined);
  };

  /**
   * Uploading from here, not from the lobby.
   *
   * A distilled persona has no upload entry anywhere — the lobby card
   * became a chat button and the edit page hides its link once the
   * analysis is ready. The file this panel wants is the one that is
   * missing, so the panel carries its own upload.
   */
  const upload = trpc.file.upload.useMutation({
    onSuccess: (data: any) => {
      utils.file.list.invalidate().catch(() => undefined);
      setFileId(data.fileId);
      toast.success(t("chat.memory.backfill.uploadDone"));
    },
    onError: (e: any) => toast.error(e.message),
  });

  const handleLocalFile = async (picked: FileList | null) => {
    const file = picked?.[0];
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    // The kind is checked before the file is read, not after.
    if (ext !== "txt" && ext !== "csv") {
      toast.error(t("chat.memory.backfill.uploadBadType"));
      return;
    }
    const fileType = ext === "csv" ? "chat_csv" : "chat_txt";
    try {
      const content = await fileToBase64(file);
      await upload.mutateAsync({
        personaId,
        fileName: file.name,
        fileType,
        fileSize: file.size,
        fileContent: content,
        mimeType: fileType === "chat_csv" ? "text/csv" : "text/plain",
      });
    } catch {
      /* the mutation's onError already said what happened */
    }
  };

  /**
   * Deleting a log the panel no longer needs.
   *
   * The memories it produced are rows of their own and go nowhere — the
   * file is only the *source*, and the run that read it is done with it.
   * The dialog names the file, and says what is true about the one
   * thing that is lost: a later distillation will not see it again.
   */
  const confirm = useConfirm();
  const del = trpc.file.delete.useMutation({
    onSuccess: (_data: any, vars: any) => {
      utils.file.list.invalidate().catch(() => undefined);
      // The selection moves to the next file left, rather than pointing
      // at the one that is gone.
      setFileId((prev) =>
        prev === vars.fileId ? (chatFiles.filter((f: any) => f.id !== vars.fileId)[0]?.id ?? null) : prev,
      );
      toast.success(t("chat.memory.backfill.deleteDone"));
    },
    onError: (e: any) => toast.error(e.message),
  });

  const handleDelete = async () => {
    const file = chatFiles.find((f: any) => f.id === fileId);
    if (!file) return;
    const ok = await confirm({
      title: t("chat.memory.backfill.deleteConfirmTitle"),
      description: t("chat.memory.backfill.deleteConfirmBody", { name: file.originalName }),
      destructive: true,
    });
    if (!ok) return;
    del.mutate({ personaId, fileId: file.id });
  };

  const start = trpc.memory.backfillStart.useMutation({
    onSuccess: (data: any) => {
      refreshStatus();
      if (!data.started && data.reason === "running") toast.info(t("chat.memory.backfill.refusedRunning"));
      else if (!data.started && data.reason === "empty") toast.info(t("chat.memory.backfill.refusedEmpty"));
    },
    onError: (e: any) => toast.error(e.message),
  });
  const cancel = trpc.memory.backfillCancel.useMutation({
    onSuccess: () => refreshStatus(),
    onError: (e: any) => toast.error(e.message),
  });
  const resume = trpc.memory.backfillResume.useMutation({
    onSuccess: () => refreshStatus(),
    onError: (e: any) => toast.error(e.message),
  });

  const running = status?.status === "running";
  const resumable = status && (status.status === "failed" || status.status === "cancelled");

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-4 border-b border-border">
        <h3 className="font-display font-semibold text-foreground">{t("chat.memory.backfill.title")}</h3>
        <button onClick={onClose} aria-label={t("common.close")} className="app-nav-icon !h-8 !min-w-8">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <p className="text-xs text-muted-foreground leading-relaxed">{t("chat.memory.backfill.intro")}</p>

        {(status as any)?.coveredUntil && (
          <div className="text-xs p-2.5 rounded-md bg-muted/50 border border-border space-y-0.5">
            <div className="text-foreground">
              {t("chat.memory.backfill.coveredUntil", {
                date: new Date((status as any).coveredUntil).toLocaleDateString(locale),
              })}
            </div>
            <div className="text-muted-foreground">{t("chat.memory.backfill.coveredHint")}</div>
          </div>
        )}

        {running ? (
          <div className="space-y-3">
            <div className="text-sm text-foreground">
              {t("chat.memory.backfill.running", { done: status!.doneBatches, total: status!.totalBatches })}
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-cinnabar transition-all"
                style={{ width: `${status!.totalBatches > 0 ? Math.round((status!.doneBatches / status!.totalBatches) * 100) : 0}%` }}
              />
            </div>
            <div className="text-xs text-muted-foreground">{t("chat.memory.backfill.added", { count: status!.memoriesAdded })}</div>
            <button
              onClick={() => cancel.mutate({ backfillId: status && "id" in status ? (status as any).id : undefined })}
              disabled={cancel.isPending}
              className="text-xs px-3 py-1.5 rounded-md border border-border text-foreground hover:bg-muted transition-colors disabled:opacity-50"
            >
              {cancel.isPending ? t("chat.memory.backfill.cancelling") : t("chat.memory.backfill.cancel")}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {status?.status === "failed" && (
              <div className="text-xs text-destructive leading-relaxed">
                {t("chat.memory.backfill.failed", { error: status.error ?? "" })}
              </div>
            )}
            {status?.status === "cancelled" && (
              <div className="text-xs text-muted-foreground leading-relaxed">{t("chat.memory.backfill.cancelled")}</div>
            )}
            {status?.status === "done" && (
              <div className="text-xs text-emerald-600 leading-relaxed">
                {t("chat.memory.backfill.done", { count: status.memoriesAdded })}
              </div>
            )}

            {chatFiles.length === 0 ? (
              <div className="text-sm text-muted-foreground">{t("chat.memory.backfill.noFiles")}</div>
            ) : (
              <>
                <label className="block space-y-1.5">
                  <span className="text-xs text-muted-foreground">{t("chat.memory.backfill.fileLabel")}</span>
                  <select
                    value={fileId ?? ""}
                    onChange={(e) => setFileId(Number(e.target.value))}
                    className="w-full text-sm rounded-md border border-border bg-background px-3 py-2"
                  >
                    {chatFiles.map((f: any) => (
                      <option key={f.id} value={f.id}>{f.originalName}</option>
                    ))}
                  </select>
                </label>

                <label className="block space-y-1.5">
                  <span className="text-xs text-muted-foreground">
                    {upload.isPending ? t("chat.memory.backfill.uploading") : t("chat.memory.backfill.uploadLabel")}
                  </span>
                  <input
                    type="file"
                    accept=".txt,.csv"
                    disabled={upload.isPending}
                    onChange={(e) => {
                      handleLocalFile(e.target.files);
                      e.target.value = "";
                    }}
                    className="w-full text-xs text-muted-foreground file:mr-2 file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1 file:text-foreground"
                  />
                </label>

                {fileId != null && chatFiles.some((f: any) => f.id === fileId) && (
                  <button
                    onClick={handleDelete}
                    disabled={del.isPending}
                    className="text-xs text-muted-foreground hover:text-destructive transition-colors w-fit disabled:opacity-50"
                  >
                    {del.isPending ? t("chat.memory.backfill.deleting") : t("chat.memory.backfill.deleteFile")}
                  </button>
                )}

                {previewing ? (
                  <div className="text-xs text-muted-foreground">{t("chat.memory.backfill.previewing")}</div>
                ) : preview ? (
                  preview.batches > 0 ? (
                    <div className="space-y-1 text-xs text-muted-foreground">
                      <div>
                        {t("chat.memory.backfill.preview", {
                          messages: preview.messages.toLocaleString(),
                          calls: preview.estimatedCalls.toLocaleString(),
                        })}
                      </div>
                      <div>{t("chat.memory.backfill.costNote", { calls: preview.estimatedCalls.toLocaleString() })}</div>
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">{t("chat.memory.backfill.previewEmpty")}</div>
                  )
                ) : null}

                {resumable && (status as any).totalBatches > (status as any).doneBatches && (
                  <button
                    onClick={() => resume.mutate({ backfillId: (status as any).id })}
                    disabled={resume.isPending}
                    className="w-full text-sm px-3 py-2 rounded-md border border-cinnabar/30 text-cinnabar hover:bg-cinnabar/5 transition-colors disabled:opacity-50"
                  >
                    {t("chat.memory.backfill.resume")}
                  </button>
                )}

                <button
                  onClick={() => fileId != null && start.mutate({ personaId, fileId })}
                  disabled={start.isPending || fileId == null || (preview != null && preview.batches === 0)}
                  className="w-full text-sm px-3 py-2 rounded-md bg-cinnabar text-white hover:bg-cinnabar/90 transition-colors disabled:opacity-50"
                >
                  {start.isPending ? t("chat.memory.backfill.starting") : t("chat.memory.backfill.start")}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

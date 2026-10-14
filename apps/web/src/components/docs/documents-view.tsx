import { FileText, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  type DocumentSummaryType,
  useArchiveDocument,
  useGetDocuments,
} from "@/hooks/queries/document/use-documents";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import { cn } from "@/lib/cn";

type DocumentsViewProps = {
  projectId: string;
  onOpen: (documentId: string) => void;
  onCreate: () => void;
};

export default function DocumentsView({
  projectId,
  onOpen,
  onCreate,
}: DocumentsViewProps) {
  const { t } = useTranslation("documents");
  const {
    data: documents = [],
    isLoading,
    isError,
    refetch,
  } = useGetDocuments(projectId);
  const archiveDocument = useArchiveDocument();
  const { canWriteDocuments } = useWorkspacePermission();
  const canWrite = canWriteDocuments();

  if (isError) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-2 px-4 py-16 text-center">
        <p className="text-sm text-muted-foreground">
          {t("errors.loadFailed")}
        </p>
        <Button size="sm" variant="outline" onClick={() => void refetch()}>
          {t("errors.retry")}
        </Button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-2 px-4 py-6">
        {Array.from({ length: 4 }, (_, i) => `sk-${i}`).map((key) => (
          <div key={key} className="h-12 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-3 px-4 py-16 text-center">
        <FileText className="size-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
        {canWrite ? (
          <Button size="sm" className="gap-1.5" onClick={onCreate}>
            <Plus className="size-3.5" />
            {t("create")}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">
          {t("listTitle")}
        </h2>
        {canWrite ? (
          <Button size="xs" className="gap-1.5" onClick={onCreate}>
            <Plus className="size-3.5" />
            {t("create")}
          </Button>
        ) : null}
      </div>
      <ul className="space-y-1.5">
        {documents.map((document: DocumentSummaryType) => (
          <li key={document.id}>
            <div
              className={cn(
                "flex items-center gap-3 rounded-lg border border-border/80 bg-card px-3 py-2.5 transition-colors hover:bg-accent",
                document.archivedAt && "opacity-70",
              )}
            >
              <button
                type="button"
                onClick={() => onOpen(document.id)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">
                    {document.title}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {new Date(document.updatedAt).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                    {document.archivedAt ? ` · ${t("archivedBadge")}` : ""}
                  </span>
                </span>
              </button>
              {canWrite ? (
                <Button
                  variant="ghost"
                  size="xs"
                  className="shrink-0 text-[11px] text-muted-foreground"
                  disabled={archiveDocument.isPending}
                  onClick={() =>
                    archiveDocument.mutate({
                      id: document.id,
                      archived: document.archivedAt === null,
                      projectId,
                    })
                  }
                >
                  {document.archivedAt === null ? t("archive") : t("unarchive")}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

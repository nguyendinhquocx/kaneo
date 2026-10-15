import { Archive, ChevronRight, FileText, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
  // UAT: archived documents used to vanish from the UI with no way back —
  // fetch the archived set and always show a restore section when non-empty.
  const { data: allDocuments = [] } = useGetDocuments(projectId, true);
  const archivedDocuments = allDocuments.filter(
    (document) => document.archivedAt !== null,
  );
  const archiveDocument = useArchiveDocument();
  const { canWriteDocuments } = useWorkspacePermission();
  const canWrite = canWriteDocuments();
  const [archivedOpen, setArchivedOpen] = useState(false);

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

  if (documents.length === 0 && archivedDocuments.length === 0) {
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

  const archivedSection =
    archivedDocuments.length > 0 ? (
      <Collapsible
        open={archivedOpen}
        onOpenChange={setArchivedOpen}
        className="mt-6"
      >
        <CollapsibleTrigger
          className="data-panel-open:[&_svg]:rotate-90"
          render={
            <button
              type="button"
              className="flex w-full items-center gap-1.5 text-left"
            />
          }
        >
          <ChevronRight className="size-3.5 text-muted-foreground transition-transform" />
          <Archive className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground">
            {t("archivedSection")} ({archivedDocuments.length})
          </span>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <ul className="mt-2 space-y-1.5">
            {archivedDocuments.map((document: DocumentSummaryType) => (
              <li key={document.id}>
                <div className="flex items-center gap-3 rounded-lg border border-border/80 bg-card px-3 py-2.5 opacity-80">
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
                      {` · ${t("archivedBadge")}`}
                    </span>
                  </span>
                  {canWrite ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="shrink-0 text-[11px] text-muted-foreground"
                      disabled={archiveDocument.isPending}
                      onClick={() =>
                        archiveDocument.mutate({
                          id: document.id,
                          archived: false,
                          projectId,
                        })
                      }
                    >
                      {t("unarchive")}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </CollapsiblePanel>
      </Collapsible>
    ) : null;

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
      {archivedSection}
    </div>
  );
}

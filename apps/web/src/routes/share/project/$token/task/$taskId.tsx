import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { ShareCapabilityProvider } from "@/components/share/share-capability";
import TaskDetailsContent from "@/components/task/task-details-content";
import TaskPropertiesSidebar from "@/components/task/task-properties-sidebar";

// SPEC-2026-10-22: share-scoped full-page task route. Maximize and
// parent-task navigation land here — never on an authenticated dashboard
// URL, never on another project.

export const Route = createFileRoute("/share/project/$token/task/$taskId")({
  component: ShareTaskFullPage,
});

function ShareTaskFullPage() {
  const { token, taskId } = Route.useParams();
  const navigate = useNavigate();

  return (
    <ShareCapabilityProvider token={token} projectId={""}>
      <div className="flex h-svh w-full flex-col overflow-hidden bg-background">
        <meta name="robots" content="noindex, nofollow" />
        <meta name="referrer" content="no-referrer" />
        <header className="flex h-11 shrink-0 items-center gap-2 border-border/80 border-b px-3">
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() =>
              navigate({ to: "/share/project/$token", params: { token } })
            }
          >
            <ArrowLeft className="size-3.5" />
            Board
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 lg:flex-row">
          <TaskPropertiesSidebar
            taskId={taskId}
            projectId={token}
            workspaceId=""
            className="w-full shrink-0 lg:w-72"
          />
          <TaskDetailsContent
            taskId={taskId}
            projectId={token}
            workspaceId=""
            className="min-w-0 flex-1"
          />
        </div>
      </div>
    </ShareCapabilityProvider>
  );
}

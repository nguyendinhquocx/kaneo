import {
  CalendarDays,
  Check,
  FileText,
  Menu,
  Network,
  Plus,
  SquareKanban,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import icons from "@/constants/project-icons";
import useGetProjects from "@/hooks/queries/project/use-get-projects";
import { cn } from "@/lib/cn";

type MobileProjectNavProps = {
  workspaceId: string;
  projectId: string;
  activeView: "backlog" | "board" | "gantt" | "docs" | "mindmap";
  onSelectBoard: () => void;
  onSelectBacklog: () => void;
  onSelectGantt: () => void;
  onSelectDocs: () => void;
  onSelectMindMap: () => void;
  onSelectProject: (projectId: string) => void;
  onAddProject: () => void;
};

// SPEC-2026-10-31: five views now share this picker, laid out on a 2-column
// grid so every item keeps a comfortable hit area down to 320px wide. On
// coarse pointers every target must be at least 44x44px; desktop switcher
// sizes are untouched.
const VIEW_GRID_CLASSES = "grid grid-cols-2 gap-1 pointer-coarse:gap-2";
const VIEW_ITEM_CLASSES =
  "flex w-full min-h-[36px] items-center justify-center gap-1 whitespace-nowrap rounded-md border px-2 text-xs font-medium transition-colors pointer-coarse:min-h-[44px]";

export default function MobileProjectNav({
  workspaceId,
  projectId,
  activeView,
  onSelectBoard,
  onSelectBacklog,
  onSelectGantt,
  onSelectDocs,
  onSelectMindMap,
  onSelectProject,
  onAddProject,
}: MobileProjectNavProps) {
  const { data: projects = [] } = useGetProjects({ workspaceId });

  const views: Array<{
    key: typeof activeView;
    label: string;
    icon?: typeof Menu;
    onSelect: () => void;
  }> = [
    { key: "backlog", label: "Backlog", onSelect: onSelectBacklog },
    {
      key: "board",
      label: "Board",
      icon: SquareKanban,
      onSelect: onSelectBoard,
    },
    {
      key: "gantt",
      label: "Gantt",
      icon: CalendarDays,
      onSelect: onSelectGantt,
    },
    {
      key: "mindmap",
      label: "Mind Map",
      icon: Network,
      onSelect: onSelectMindMap,
    },
    { key: "docs", label: "Docs", icon: FileText, onSelect: onSelectDocs },
  ];

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-7 border border-transparent pointer-coarse:size-11"
          />
        }
      >
        <Menu className="size-4" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              View
            </p>
            <div className={VIEW_GRID_CLASSES}>
              {views.map((view) => {
                const Icon = view.icon;
                return (
                  <button
                    key={view.key}
                    type="button"
                    aria-current={activeView === view.key ? "true" : undefined}
                    onClick={view.onSelect}
                    className={cn(
                      VIEW_ITEM_CLASSES,
                      activeView === view.key
                        ? "border-border bg-secondary text-foreground"
                        : "border-transparent text-muted-foreground hover:bg-accent",
                    )}
                  >
                    {Icon ? <Icon className="size-3.5" /> : null}
                    {view.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1">
            <p className="px-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Projects
            </p>
            <div className="max-h-56 space-y-0.5 overflow-y-auto">
              {(projects ?? []).map((project) => {
                const Icon =
                  icons[project.icon as keyof typeof icons] || icons.Layout;
                const isCurrentProject = project.id === projectId;

                return (
                  <button
                    key={project.id}
                    type="button"
                    aria-current={
                      isCurrentProject ? "true" : undefined
                    }
                    onClick={() => onSelectProject(project.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors pointer-coarse:min-h-[44px]",
                      isCurrentProject
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <Icon className="size-3.5" />
                    <span className="flex-1 truncate">{project.name}</span>
                    {isCurrentProject && <Check className="size-3.5" />}
                  </button>
                );
              })}
            </div>
          </div>

          <button
            type="button"
            onClick={onAddProject}
            className="flex w-full items-center gap-2 rounded-md border border-border px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent pointer-coarse:min-h-[44px]"
          >
            <Plus className="size-3.5" />
            Add project
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

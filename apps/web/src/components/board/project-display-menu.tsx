import { Eye } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/menu";

type ProjectDisplayMenuProps = {
  showSubtaskCards: boolean;
  showNextSubtaskPreview: boolean;
  showAssignees: boolean;
  showPriority: boolean;
  setShowSubtaskCards: (value: boolean) => void;
  setShowNextSubtaskPreview: (value: boolean) => void;
  setShowAssignees: (value: boolean) => void;
  setShowPriority: (value: boolean) => void;
};

export default function ProjectDisplayMenu({
  showSubtaskCards,
  showNextSubtaskPreview,
  showAssignees,
  showPriority,
  setShowSubtaskCards,
  setShowNextSubtaskPreview,
  setShowAssignees,
  setShowPriority,
}: ProjectDisplayMenuProps) {
  const { t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t("tasks:display.menu")}
            className="inline-flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-foreground text-xs font-medium outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:h-7 sm:min-w-0"
          />
        }
      >
        <Eye className="h-3 w-3" />
        <span className="hidden sm:inline">{t("tasks:display.menu")}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64" align="start">
        <DropdownMenuCheckboxItem
          closeOnClick={false}
          checked={showSubtaskCards}
          onCheckedChange={setShowSubtaskCards}
          className="min-h-11 rounded-md text-sm sm:min-h-8"
        >
          {t("tasks:display.showSubtaskCards")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          closeOnClick={false}
          checked={showNextSubtaskPreview}
          onCheckedChange={setShowNextSubtaskPreview}
          className="min-h-11 rounded-md text-sm sm:min-h-8"
        >
          {t("tasks:display.showNextSubtaskPreview")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          closeOnClick={false}
          checked={showAssignees}
          onCheckedChange={setShowAssignees}
          className="min-h-11 rounded-md text-sm sm:min-h-8"
        >
          {t("tasks:display.showAssignees")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          closeOnClick={false}
          checked={showPriority}
          onCheckedChange={setShowPriority}
          className="min-h-11 rounded-md text-sm sm:min-h-8"
        >
          {t("tasks:display.showPriority")}
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

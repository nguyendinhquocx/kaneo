import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/public-project/theme-toggle";
import ProjectShareReader from "@/components/share/project-share-reader";
import {
  isFullProjectShare,
  type ShareProjectPayload,
} from "@/fetchers/share/share-public-api";
import type { ShareFullProjectPayload } from "@/fetchers/share/share-full-api";

type ShareProjectRouteContentProps = {
  token: string;
  data: ShareProjectPayload;
  fullSurface: (payload: ShareFullProjectPayload) => ReactNode;
};

// The static project route wins over /share/$resourceType/$token. Keep
// permission dispatch here so legacy view/edit tokens never mount full hooks.
export default function ShareProjectRouteContent({
  token,
  data,
  fullSurface,
}: ShareProjectRouteContentProps) {
  if (isFullProjectShare(data)) return fullSurface(data);

  return (
    <div className="scrollbar-none h-svh w-full overflow-y-auto bg-background">
      <meta name="robots" content="noindex, nofollow" />
      <meta name="referrer" content="no-referrer" />
      <header className="sticky top-0 z-10 bg-background">
        <div className="mx-auto flex w-full max-w-[1600px] items-center justify-end px-4 py-2.5">
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6">
        <ProjectShareReader data={data} token={token} />
      </main>
    </div>
  );
}

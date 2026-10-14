import { buildPublicProjectPayload } from "./public-project-dto";

// Legacy unauthenticated route: read-only public project board payload.
// Kept for compatibility with existing /public-project/:id links; the
// capability-based share API is the going-forward path.
export async function getPublicProject(id: string) {
  return buildPublicProjectPayload(id, { requirePublic: true });
}

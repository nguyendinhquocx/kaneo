import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAnonymousSession, mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

async function createDocumentViaApi(
  app: ReturnType<typeof createApp>["app"],
  body: { projectId: string; title: string; content?: string },
) {
  return app.request("/api/document", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedDocument(
  projectId: string,
  overrides?: Partial<{ title: string; content: string; archivedAt: Date }>,
) {
  const [document] = await db
    .insert(schema.documentTable)
    .values({
      projectId,
      title: overrides?.title ?? "Seeded doc",
      content: overrides?.content ?? "# Seeded\n\nHello world",
      archivedAt: overrides?.archivedAt,
    })
    .returning();
  if (!document) {
    throw new Error("Failed to seed document");
  }
  return document;
}

describe("API integration: project documents", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("anonymous requests are rejected by global auth", async () => {
    const member = await createWorkspaceMember({ role: "member" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    mockAnonymousSession();
    const { app } = createApp();
    const response = await createDocumentViaApi(app, {
      projectId: project.id,
      title: "Anonymous doc",
    });
    expect(response.status).toBe(401);
  });

  it("member creates, lists, reads and CAS-updates a document", async () => {
    const member = await createWorkspaceMember({ role: "member" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const created = await createDocumentViaApi(app, {
      projectId: project.id,
      title: "Spec notes",
      content: "# Spec\n\nDraft",
    });
    expect(created.status).toBe(200);
    const doc = (await created.json()) as {
      id: string;
      revision: number;
      content: string;
    };
    expect(doc.revision).toBe(1);
    expect(doc.content).toBe("# Spec\n\nDraft");

    const list = await app.request(`/api/document?projectId=${project.id}`);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as Array<{ id: string }>;
    expect(listBody).toHaveLength(1);

    const read = await app.request(`/api/document/${doc.id}`);
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as { title: string; content: string };
    expect(readBody.title).toBe("Spec notes");

    // CAS save with the current revision succeeds and bumps the revision.
    const save1 = await app.request(`/api/document/${doc.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Spec notes",
        content: "# Spec\n\nUpdated",
        revision: 1,
      }),
    });
    expect(save1.status).toBe(200);
    const saved1 = (await save1.json()) as { revision: number };
    expect(saved1.revision).toBe(2);

    // Stale revision is rejected with 409 — never a silent overwrite.
    const stale = await app.request(`/api/document/${doc.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Spec notes",
        content: "# Spec\n\nOverwrite attempt",
        revision: 1,
      }),
    });
    expect(stale.status).toBe(409);

    const afterConflict = await app.request(`/api/document/${doc.id}`);
    const afterBody = (await afterConflict.json()) as {
      content: string;
      revision: number;
    };
    expect(afterBody.content).toBe("# Spec\n\nUpdated");
    expect(afterBody.revision).toBe(2);
  });

  it("viewer role can read but not write documents", async () => {
    const viewer = await createWorkspaceMember({ role: "viewer" });
    const { project } = await createProjectFixture({
      workspaceId: viewer.workspace.id,
    });
    const doc = await seedDocument(project.id);

    mockAuthenticatedSession(viewer.user);
    const { app } = createApp();

    const read = await app.request(`/api/document/${doc.id}`);
    expect(read.status).toBe(200);

    const deniedCreate = await createDocumentViaApi(app, {
      projectId: project.id,
      title: "Nope",
    });
    expect(deniedCreate.status).toBe(403);

    const deniedUpdate = await app.request(`/api/document/${doc.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: doc.title,
        content: "hacked",
        revision: doc.revision,
      }),
    });
    expect(deniedUpdate.status).toBe(403);
  });

  it("member comments on a document; only the author or a moderator can delete", async () => {
    const author = await createWorkspaceMember({ role: "member" });
    const other = await createWorkspaceMember({ role: "member" });
    // Add `other` to the author's workspace so both can see the document.
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: author.workspace.id,
      userId: other.user.id,
      role: "member",
      joinedAt: new Date(),
    });
    const { project } = await createProjectFixture({
      workspaceId: author.workspace.id,
    });
    const doc = await seedDocument(project.id);

    mockAuthenticatedSession(author.user);
    const { app } = createApp();
    const created = await app.request(`/api/document/${doc.id}/comment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "First comment" }),
    });
    expect(created.status).toBe(200);
    const comment = (await created.json()) as { id: string };

    const listed = await app.request(`/api/document/${doc.id}/comment`);
    const listBody = (await listed.json()) as Array<{ content: string }>;
    expect(listBody).toHaveLength(1);
    expect(listBody[0]?.content).toBe("First comment");

    // A different member cannot delete someone else's comment.
    mockAuthenticatedSession(other.user);
    const { app: app2 } = createApp();
    const foreignDelete = await app2.request(
      `/api/document/comment/${comment.id}`,
      {
        method: "DELETE",
      },
    );
    expect(foreignDelete.status).toBe(403);

    // The author can delete their own comment.
    mockAuthenticatedSession(author.user);
    const { app: app3 } = createApp();
    const authorDelete = await app3.request(
      `/api/document/comment/${comment.id}`,
      {
        method: "DELETE",
      },
    );
    expect(authorDelete.status).toBe(200);

    const afterDelete = await app3.request(`/api/document/${doc.id}/comment`);
    const afterBody = (await afterDelete.json()) as Array<unknown>;
    expect(afterBody).toHaveLength(0);
  });

  it("document share link exposes one document and raw markdown; archived fails closed", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: admin.workspace.id,
    });
    const doc = await seedDocument(project.id, {
      content: "# Public doc\n\nReadable by agents",
    });

    mockAuthenticatedSession(admin.user);
    let { app } = createApp();
    const createResponse = await app.request("/api/share-manage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resourceType: "document",
        resourceId: doc.id,
        permission: "view",
      }),
    });
    expect(createResponse.status).toBe(200);
    const link = (await createResponse.json()) as { token: string };

    mockAnonymousSession();
    ({ app } = createApp());

    const docRead = await app.request(`/api/share/document/${link.token}`);
    expect(docRead.status).toBe(200);
    const docBody = (await docRead.json()) as {
      title: string;
      content: string;
    };
    expect(docBody.title).toBe("Seeded doc");
    expect(docBody.content).toContain("Readable by agents");

    const raw = await app.request(`/api/share/document/${link.token}/raw`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toContain("text/markdown");
    await expect(raw.text()).resolves.toContain("# Public doc");

    // Archive the document: the same link must fail closed.
    await db
      .update(schema.documentTable)
      .set({ archivedAt: new Date() })
      .where(eq(schema.documentTable.id, doc.id));
    const archivedRead = await app.request(`/api/share/document/${link.token}`);
    expect(archivedRead.status).toBe(404);
    const archivedRaw = await app.request(
      `/api/share/document/${link.token}/raw`,
    );
    expect(archivedRaw.status).toBe(404);
  });

  it("share-manage refuses document links for missing documents", async () => {
    const admin = await createWorkspaceMember({ role: "admin" });
    mockAuthenticatedSession(admin.user);
    const { app } = createApp();
    const response = await app.request("/api/share-manage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resourceType: "document",
        resourceId: "missing-doc",
        permission: "view",
      }),
    });
    expect(response.status).toBe(404);
  });
});

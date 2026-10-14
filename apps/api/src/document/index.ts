import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import * as v from "valibot";
import {
  hasUserWorkspacePermission,
  requireWorkspacePermission,
} from "../utils/require-workspace-permission";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import {
  createDocumentComment,
  deleteDocumentComment,
  getDocumentComments,
} from "./controllers/document-comment-controllers";
import {
  archiveDocument,
  createDocument,
  getDocument,
  getDocuments,
  unarchiveDocument,
  updateDocument,
} from "./controllers/document-controllers";

// SPEC-2026-10-08-kaneo-workspace-collaboration T3: project documents live
// under the authenticated API. Permission mapping (role matrix is unchanged):
// documents are project work content, so they reuse the task statements —
// task:read for reading, task:update for writing/commenting.

const document = new Hono<{
  Variables: {
    userId: string;
    workspaceId: string;
  };
}>()
  .get(
    "/",
    describeRoute({
      operationId: "listDocuments",
      tags: ["Documents"],
      description: "List Markdown documents in a project",
      responses: {
        200: {
          description: "Documents in the project",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
      },
    }),
    validator(
      "query",
      v.object({
        projectId: v.string(),
        includeArchived: v.optional(v.string()),
      }),
    ),
    workspaceAccess.fromProjectId(),
    requireWorkspacePermission({ task: ["read"] }),
    async (c) => {
      const { projectId, includeArchived } = c.req.valid("query");
      const documents = await getDocuments(
        projectId,
        includeArchived === "true",
      );
      return c.json(documents);
    },
  )
  .post(
    "/",
    describeRoute({
      operationId: "createDocument",
      tags: ["Documents"],
      description: "Create a Markdown document in a project",
      responses: {
        200: {
          description: "Created document",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
      },
    }),
    validator(
      "json",
      v.object({
        projectId: v.string(),
        title: v.string(),
        content: v.optional(v.string()),
      }),
    ),
    workspaceAccess.fromProjectId(),
    requireWorkspacePermission({ task: ["update"] }),
    async (c) => {
      const { projectId, title, content } = c.req.valid("json");
      const userId = c.get("userId");
      const created = await createDocument(
        projectId,
        title,
        content ?? "",
        userId,
      );
      return c.json(created);
    },
  )
  .get(
    "/:id",
    describeRoute({
      operationId: "getDocument",
      tags: ["Documents"],
      description: "Get a document with its Markdown content",
      responses: {
        200: {
          description: "The document",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    workspaceAccess.fromDocument(),
    requireWorkspacePermission({ task: ["read"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const document = await getDocument(id);
      return c.json(document);
    },
  )
  .put(
    "/:id",
    describeRoute({
      operationId: "updateDocument",
      tags: ["Documents"],
      description:
        "Update a document with revision CAS; stale revisions return 409",
      responses: {
        200: {
          description: "Updated document",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
        409: { description: "Revision conflict" },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    validator(
      "json",
      v.object({
        title: v.string(),
        content: v.string(),
        revision: v.number(),
      }),
    ),
    workspaceAccess.fromDocument(),
    requireWorkspacePermission({ task: ["update"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { title, content, revision } = c.req.valid("json");
      const updated = await updateDocument(id, title, content, revision);
      return c.json(updated);
    },
  )
  .put(
    "/:id/archive",
    describeRoute({
      operationId: "archiveDocument",
      tags: ["Documents"],
      description: "Archive a document (hide from the active list)",
      responses: {
        200: {
          description: "Archived document",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    workspaceAccess.fromDocument(),
    requireWorkspacePermission({ task: ["update"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const archived = await archiveDocument(id);
      return c.json(archived);
    },
  )
  .put(
    "/:id/unarchive",
    describeRoute({
      operationId: "unarchiveDocument",
      tags: ["Documents"],
      description: "Restore an archived document to the active list",
      responses: {
        200: {
          description: "Unarchived document",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    workspaceAccess.fromDocument(),
    requireWorkspacePermission({ task: ["update"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const unarchived = await unarchiveDocument(id);
      return c.json(unarchived);
    },
  )
  .get(
    "/:id/comment",
    describeRoute({
      operationId: "getDocumentComments",
      tags: ["Documents"],
      description: "List member comments on a document",
      responses: {
        200: {
          description: "Comments for the document",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    workspaceAccess.fromDocument(),
    requireWorkspacePermission({ task: ["read"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const comments = await getDocumentComments(id);
      return c.json(comments);
    },
  )
  .post(
    "/:id/comment",
    describeRoute({
      operationId: "createDocumentComment",
      tags: ["Documents"],
      description: "Comment on a document as a workspace member",
      responses: {
        200: {
          description: "Created comment",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    validator("json", v.object({ content: v.string() })),
    workspaceAccess.fromDocument(),
    requireWorkspacePermission({ task: ["update"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { content } = c.req.valid("json");
      const userId = c.get("userId");
      const comment = await createDocumentComment(id, userId, content);
      return c.json(comment);
    },
  )
  .delete(
    "/comment/:id",
    describeRoute({
      operationId: "deleteDocumentComment",
      tags: ["Documents"],
      description:
        "Delete a document comment (author or workspace moderator only)",
      responses: {
        200: {
          description: "Comment deleted",
          content: { "application/json": { schema: resolver(v.any()) } },
        },
      },
    }),
    validator("param", v.object({ id: v.string() })),
    workspaceAccess.fromDocumentComment(),
    requireWorkspacePermission({ task: ["update"] }),
    async (c) => {
      const { id } = c.req.valid("param");
      const userId = c.get("userId");
      const workspaceId = c.get("workspaceId");
      const isModerator = await hasUserWorkspacePermission(
        userId,
        workspaceId,
        {
          workspace: ["manage_settings"],
        },
      );
      const result = await deleteDocumentComment(id, userId, isModerator);
      return c.json(result);
    },
  );

export default document;

import { and, eq, inArray, like } from "drizzle-orm";
import db from "../database";
import {
  activityTable,
  assetTable,
  commentTable,
  documentCommentTable,
  documentTable,
  goalCheckinTable,
  taskTable,
} from "../database/schema";
import { deleteS3Object } from "./s3";

const ASSET_URL_PATTERN = /\/(?:api\/)?asset\/([a-z0-9]+)/gi;

export function extractAssetIds(
  content: string | null | undefined,
): Set<string> {
  const ids = new Set<string>();
  if (!content) return ids;

  ASSET_URL_PATTERN.lastIndex = 0;
  for (
    let match = ASSET_URL_PATTERN.exec(content);
    match !== null;
    match = ASSET_URL_PATTERN.exec(content)
  ) {
    if (match[1]) ids.add(match[1]);
  }

  return ids;
}

export function contentReferencesAsset(
  content: string | null | undefined,
  assetId: string,
): boolean {
  return extractAssetIds(content).has(assetId);
}

export type AssetCleanupScope =
  | { taskId: string }
  | { documentId: string }
  | { goalCheckinId: string };

async function isAssetReferencedElsewhere(
  assetId: string,
  scope: AssetCleanupScope,
): Promise<boolean> {
  const pattern = `%/asset/${assetId}%`;

  if ("taskId" in scope) {
    const [taskRef] = await db
      .select({ description: taskTable.description })
      .from(taskTable)
      .where(
        and(
          eq(taskTable.id, scope.taskId),
          like(taskTable.description, pattern),
        ),
      )
      .limit(1);
    if (contentReferencesAsset(taskRef?.description, assetId)) return true;

    const commentRefs = await db
      .select({ content: commentTable.content })
      .from(commentTable)
      .where(
        and(
          eq(commentTable.taskId, scope.taskId),
          like(commentTable.content, pattern),
        ),
      );
    if (
      commentRefs.some((ref) => contentReferencesAsset(ref.content, assetId))
    ) {
      return true;
    }

    const activityRefs = await db
      .select({ content: activityTable.content })
      .from(activityTable)
      .where(
        and(
          eq(activityTable.taskId, scope.taskId),
          like(activityTable.content, pattern),
        ),
      );
    return activityRefs.some((ref) =>
      contentReferencesAsset(ref.content, assetId),
    );
  }

  if ("documentId" in scope) {
    const [documentRef] = await db
      .select({ content: documentTable.content })
      .from(documentTable)
      .where(
        and(
          eq(documentTable.id, scope.documentId),
          like(documentTable.content, pattern),
        ),
      )
      .limit(1);
    if (contentReferencesAsset(documentRef?.content, assetId)) return true;

    const commentRefs = await db
      .select({ content: documentCommentTable.content })
      .from(documentCommentTable)
      .where(
        and(
          eq(documentCommentTable.documentId, scope.documentId),
          like(documentCommentTable.content, pattern),
        ),
      );
    return commentRefs.some((ref) =>
      contentReferencesAsset(ref.content, assetId),
    );
  }

  const [checkinRef] = await db
    .select({ note: goalCheckinTable.note })
    .from(goalCheckinTable)
    .where(
      and(
        eq(goalCheckinTable.id, scope.goalCheckinId),
        like(goalCheckinTable.note, pattern),
      ),
    )
    .limit(1);
  return contentReferencesAsset(checkinRef?.note, assetId);
}

export async function deleteOrphanedAssets(
  oldContent: string | null | undefined,
  newContent: string | null | undefined,
  scope: AssetCleanupScope,
): Promise<void> {
  const oldIds = extractAssetIds(oldContent);
  const newIds = extractAssetIds(newContent);

  const removedIds = [...oldIds].filter((id) => !newIds.has(id));
  if (removedIds.length === 0) return;

  const ownerCondition =
    "taskId" in scope
      ? eq(assetTable.taskId, scope.taskId)
      : "documentId" in scope
        ? eq(assetTable.documentId, scope.documentId)
        : eq(assetTable.goalCheckinId, scope.goalCheckinId);
  const assets = await db
    .select({ id: assetTable.id, objectKey: assetTable.objectKey })
    .from(assetTable)
    .where(and(inArray(assetTable.id, removedIds), ownerCondition));

  const assetsToDelete: typeof assets = [];
  for (const asset of assets) {
    const stillReferenced = await isAssetReferencedElsewhere(asset.id, scope);
    if (!stillReferenced) {
      assetsToDelete.push(asset);
    }
  }

  if (assetsToDelete.length === 0) return;

  const deleteResults = await deleteS3Keys(
    assetsToDelete.map((asset) => asset.objectKey),
  );

  const deletedAssetIds = assetsToDelete
    .filter((_, index) => deleteResults[index]?.status === "fulfilled")
    .map((asset) => asset.id);

  if (deletedAssetIds.length === 0) return;

  await db.delete(assetTable).where(inArray(assetTable.id, deletedAssetIds));
}

export async function getTaskAssetKeys(taskId: string): Promise<string[]> {
  const assets = await db
    .select({ objectKey: assetTable.objectKey })
    .from(assetTable)
    .where(eq(assetTable.taskId, taskId));

  return assets.map((a) => a.objectKey);
}

export async function getDocumentAssetKeys(
  documentId: string,
): Promise<string[]> {
  const assets = await db
    .select({ objectKey: assetTable.objectKey })
    .from(assetTable)
    .where(eq(assetTable.documentId, documentId));
  return assets.map((asset) => asset.objectKey);
}

export async function getGoalAssetKeys(goalId: string): Promise<string[]> {
  const assets = await db
    .select({ objectKey: assetTable.objectKey })
    .from(assetTable)
    .innerJoin(
      goalCheckinTable,
      eq(assetTable.goalCheckinId, goalCheckinTable.id),
    )
    .where(eq(goalCheckinTable.goalId, goalId));
  return assets.map((asset) => asset.objectKey);
}

export async function deleteS3Keys(
  keys: string[],
): Promise<PromiseSettledResult<void>[]> {
  const deleteResults = await Promise.allSettled(
    keys.map((key) => deleteS3Object(key)),
  );

  const failedDeletions = keys
    .map((key, index) => ({ key, result: deleteResults[index] }))
    .filter(
      (
        deletion,
      ): deletion is {
        key: string;
        result: PromiseRejectedResult;
      } => deletion.result?.status === "rejected",
    );

  if (failedDeletions.length > 0) {
    console.error(
      "Failed to delete S3 objects",
      failedDeletions.map(({ key, result }) => ({
        key,
        reason: result.reason,
      })),
    );
  }

  return deleteResults;
}

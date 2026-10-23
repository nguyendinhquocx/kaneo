import {
  type ContentAssetOwnerType,
  createImageUpload,
  finalizeImageUpload,
} from "@/fetchers/task/create-image-upload";
import { uploadShareFullAsset } from "@/fetchers/share/share-full-api";
import { getShareCapability } from "@/components/share/share-capability";

const allowedImageMimeTypes = new Set([
  "image/apng",
  "image/avif",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

export function isSupportedImageFile(file: File) {
  return allowedImageMimeTypes.has(file.type.toLowerCase());
}

export function isSupportedTaskAsset(file: File) {
  return file.size > 0;
}

export function getImageAltText(filename: string) {
  return filename
    .replace(/\.[^/.]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

export async function uploadTaskImage({
  taskId,
  surface,
  file,
  ownerType,
  ownerId,
}: {
  taskId?: string;
  surface?: "description" | "comment";
  file: File;
  ownerType?: ContentAssetOwnerType;
  ownerId?: string;
}) {
  if (!isSupportedImageFile(file) && !isSupportedTaskAsset(file)) {
    throw new Error("Only non-empty file uploads are supported.");
  }

  const resolvedOwnerType =
    ownerType ??
    (surface === "description" ? "task_description" : "task_comment");
  const resolvedOwnerId = ownerId ?? taskId;
  if (!resolvedOwnerId) throw new Error("An upload owner is required.");

  const filename = file.name || "image";

  // SPEC-2026-10-22: capability holders upload through the share ticket +
  // finalize pair (owner-approved caps + MIME allowlist enforced server-side).
  const capability = getShareCapability();
  if (capability) {
    const asset = await uploadShareFullAsset({
      token: capability.token,
      ownerType: resolvedOwnerType as "task_description" | "task_comment" | "document",
      ownerId: resolvedOwnerId,
      file,
    });
    return {
      id: asset.id,
      url: asset.url ?? "",
      filename,
      mimeType: file.type,
      size: file.size,
      alt: getImageAltText(filename),
      kind: isSupportedImageFile(file) ? "image" : "attachment",
    };
  }

  const ticket = await createImageUpload({
    ownerType: resolvedOwnerType,
    ownerId: resolvedOwnerId,
    filename,
    contentType: file.type,
    size: file.size,
  });
  const uploadResponse = await fetch(ticket.uploadUrl, {
    method: "PUT",
    headers: ticket.headers,
    body: file,
  });
  if (!uploadResponse.ok) throw new Error("Failed to upload file to storage.");

  const asset = await finalizeImageUpload({
    ownerType: resolvedOwnerType,
    ownerId: resolvedOwnerId,
    key: ticket.key,
    filename,
    contentType: file.type,
    size: file.size,
  });

  return {
    ...asset,
    alt: getImageAltText(filename),
    kind: asset.kind ?? (isSupportedImageFile(file) ? "image" : "attachment"),
  };
}

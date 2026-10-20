import {
  type ContentAssetOwnerType,
  createImageUpload,
  finalizeImageUpload,
} from "@/fetchers/task/create-image-upload";

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

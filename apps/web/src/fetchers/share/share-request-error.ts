export type ShareRequestErrorKind = "invalid" | "rateLimited" | "error";

export class ShareRequestError extends Error {
  constructor(readonly kind: ShareRequestErrorKind) {
    super(kind);
    this.name = "ShareRequestError";
  }
}

export function getShareRequestErrorKind(
  error: unknown,
): ShareRequestErrorKind {
  return error instanceof ShareRequestError ? error.kind : "error";
}

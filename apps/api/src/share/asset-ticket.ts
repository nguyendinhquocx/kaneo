import { createHmac, timingSafeEqual } from "node:crypto";

// A short-lived asset ticket removes the parent project bearer token from
// resource JSON/Markdown while keeping each asset URL strictly scoped to one
// link + one asset. The link row is revalidated on every GET, so revocation
// immediately invalidates outstanding tickets.

const TICKET_VERSION = "v1";
const DEFAULT_TTL_SECONDS = 60 * 60;

export type ShareAssetTicketPayload = {
  version: typeof TICKET_VERSION;
  linkId: string;
  assetId: string;
  expiresAt: number;
};

function getTicketKey(): Buffer {
  const encoded = process.env.SHARE_TOKEN_ENCRYPTION_KEY?.trim();
  if (!encoded) {
    throw new Error("SHARE_TOKEN_ENCRYPTION_KEY is not configured.");
  }
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encoded) {
    throw new Error("SHARE_TOKEN_ENCRYPTION_KEY must be a 32-byte base64url value.");
  }
  return key;
}

function sign(encodedPayload: string): Buffer {
  return createHmac("sha256", getTicketKey())
    .update(`share-asset-ticket:${encodedPayload}`, "utf8")
    .digest();
}

export function createShareAssetTicket(
  linkId: string,
  assetId: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): string {
  const payload: ShareAssetTicketPayload = {
    version: TICKET_VERSION,
    linkId,
    assetId,
    expiresAt: Date.now() + ttlSeconds * 1000,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload).toString("base64url")}`;
}

// `allowExpired` is only for stripping a completed upload ticket from text;
// HTTP reads always enforce expiration.
export function verifyShareAssetTicket(
  ticket: string,
  options: { allowExpired?: boolean } = {},
): ShareAssetTicketPayload | null {
  if (ticket.length > 2048) return null;
  const [encodedPayload, encodedSignature, extra] = ticket.split(".");
  if (!encodedPayload || !encodedSignature || extra !== undefined) return null;
  let provided: Buffer;
  let payload: ShareAssetTicketPayload;
  try {
    provided = Buffer.from(encodedSignature, "base64url");
    const expected = sign(encodedPayload);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return null;
    }
    payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as ShareAssetTicketPayload;
  } catch {
    return null;
  }
  if (
    payload.version !== TICKET_VERSION ||
    typeof payload.linkId !== "string" ||
    typeof payload.assetId !== "string" ||
    !Number.isFinite(payload.expiresAt)
  ) {
    return null;
  }
  if (!options.allowExpired && payload.expiresAt <= Date.now()) return null;
  return payload;
}

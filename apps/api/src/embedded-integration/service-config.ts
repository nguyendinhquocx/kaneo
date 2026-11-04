import type { EmbeddedServiceConfig, EmbeddedViewMode } from "./types";

/**
 * Resolve one embedded service from its optional env pair. Both the URL and
 * the view mode must be present and individually valid — anything missing or
 * malformed disables the service instead of guessing a mode.
 */
function resolveServiceConfig(
  baseUrl: string | undefined,
  viewMode: string | undefined,
): EmbeddedServiceConfig | null {
  if (!baseUrl || !viewMode) {
    return null;
  }

  if (viewMode !== "embedded" && viewMode !== "open-only") {
    console.warn(
      `Invalid embedded service view mode "${viewMode}" — service disabled`,
    );
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    console.warn("Invalid embedded service base URL — service disabled");
    return null;
  }

  // HTTPS absolute URL only; no userinfo, query, or fragment. A path is
  // allowed because deployments may mount the service under a sub-path.
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    console.warn(
      "Embedded service base URL must be an HTTPS absolute URL without userinfo, query or fragment — service disabled",
    );
    return null;
  }

  return {
    baseUrl: parsed.toString().replace(/\/$/, ""),
    viewMode: viewMode as EmbeddedViewMode,
  };
}

/**
 * Read the embedded-services runtime configuration. Called per request so
 * tests and deployments can toggle services via env without a restart.
 */
export function getEmbeddedServicesConfig(): {
  mitra: EmbeddedServiceConfig | null;
  wisemapping: EmbeddedServiceConfig | null;
} {
  return {
    mitra: resolveServiceConfig(
      process.env.KANEO_MITRA_BASE_URL,
      process.env.KANEO_MITRA_VIEW_MODE,
    ),
    wisemapping: resolveServiceConfig(
      process.env.KANEO_WISEMAPPING_BASE_URL,
      process.env.KANEO_WISEMAPPING_VIEW_MODE,
    ),
  };
}

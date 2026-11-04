export type EmbeddedViewMode = "embedded" | "open-only";

export type EmbeddedServiceConfig = {
  baseUrl: string;
  viewMode: EmbeddedViewMode;
};

export type PublicEmbeddedServiceConfig =
  | { enabled: false }
  | { enabled: true; baseUrl: string; viewMode: EmbeddedViewMode };

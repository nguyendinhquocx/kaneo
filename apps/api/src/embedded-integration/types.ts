export type EmbeddedViewMode = "embedded" | "open-only";

export type EmbeddedServiceConfig = {
  baseUrl: string;
  viewMode: EmbeddedViewMode;
};

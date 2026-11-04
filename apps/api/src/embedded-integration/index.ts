import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import * as v from "valibot";
import { requireWorkspacePermission } from "../utils/require-workspace-permission";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import {
  deleteMindMapBinding,
  getMindMapBinding,
  upsertMindMapBinding,
} from "./controllers/mind-map";
import {
  getWorkspaceIntegrationSettings,
  setWorkspaceIntegrationEnabled,
} from "./controllers/workspace-settings";
import { MAP_ID_MAX_LENGTH, validateMapId } from "./map-id";
import { getEmbeddedServicesConfig } from "./service-config";
import type {
  EmbeddedServiceConfig,
  PublicEmbeddedServiceConfig,
} from "./types";

const enabledEmbeddedServiceSchema = v.object({
  enabled: v.literal(true),
  baseUrl: v.string(),
  viewMode: v.picklist(["embedded", "open-only"]),
});

const disabledEmbeddedServiceSchema = v.object({
  enabled: v.literal(false),
});

const embeddedServiceSchema = v.union([
  enabledEmbeddedServiceSchema,
  disabledEmbeddedServiceSchema,
]);

const servicesSchema = v.object({
  mitra: v.nullable(embeddedServiceSchema),
  wisemapping: v.nullable(embeddedServiceSchema),
});

const toggleResponseSchema = v.nullable(embeddedServiceSchema);

const mindMapBindingSchema = v.object({
  mapId: v.nullable(v.string()),
});

function servicePayload(
  config: EmbeddedServiceConfig | null,
  enabled: boolean,
): PublicEmbeddedServiceConfig | null {
  if (!config) return null;
  if (!enabled) return { enabled: false };
  return { enabled: true, baseUrl: config.baseUrl, viewMode: config.viewMode };
}

async function getWorkspaceServicesPayload(workspaceId: string) {
  const [config, settings] = await Promise.all([
    Promise.resolve(getEmbeddedServicesConfig()),
    getWorkspaceIntegrationSettings(workspaceId),
  ]);

  return {
    mitra: servicePayload(config.mitra, settings.mitraEnabled),
    wisemapping: servicePayload(
      config.wisemapping,
      settings.wisemappingEnabled,
    ),
  };
}

const embeddedIntegration = new Hono<{
  Variables: {
    userId: string;
    workspaceId: string;
    apiKey?: {
      id: string;
      userId: string;
      enabled: boolean;
    };
  };
}>()
  .get(
    "/workspace-config",
    describeRoute({
      operationId: "getEmbeddedServicesConfig",
      tags: ["Integrations"],
      description:
        "Get the configured external calendar and mind map services for the workspace. Returns null entries when a service is not configured.",
      responses: {
        200: {
          description: "Embedded services configuration",
          content: {
            "application/json": { schema: resolver(servicesSchema) },
          },
        },
      },
    }),
    workspaceAccess.fromQuery("workspaceId"),
    async (c) => {
      return c.json(await getWorkspaceServicesPayload(c.get("workspaceId")));
    },
  )
  .put(
    "/workspace-config/:service",
    describeRoute({
      operationId: "setEmbeddedServiceEnabled",
      tags: ["Integrations"],
      description:
        "Enable or hide one configured embedded service for a workspace. Requires manage_settings permission.",
      responses: {
        200: {
          description: "Updated embedded service state",
          content: {
            "application/json": { schema: resolver(toggleResponseSchema) },
          },
        },
      },
    }),
    validator(
      "param",
      v.object({ service: v.picklist(["mitra", "wisemapping"]) }),
    ),
    validator(
      "query",
      v.object({ workspaceId: v.pipe(v.string(), v.minLength(1)) }),
    ),
    validator("json", v.object({ enabled: v.boolean() })),
    workspaceAccess.fromQuery("workspaceId"),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
    async (c) => {
      const { service } = c.req.valid("param");
      const { workspaceId } = c.req.valid("query");
      const { enabled } = c.req.valid("json");

      await setWorkspaceIntegrationEnabled({ workspaceId, service, enabled });
      const payload = await getWorkspaceServicesPayload(workspaceId);
      return c.json(payload[service]);
    },
  )
  .get(
    "/project/:projectId/mind-map",
    describeRoute({
      operationId: "getProjectMindMapBinding",
      tags: ["Integrations"],
      description:
        "Get the WiseMapping map linked to a project. Returns null when no map is linked.",
      responses: {
        200: {
          description: "Mind map binding",
          content: {
            "application/json": { schema: resolver(mindMapBindingSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ projectId: v.string() })),
    workspaceAccess.fromProject("projectId"),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const binding = await getMindMapBinding(projectId);
      return c.json({ mapId: binding ? binding.mapId : null });
    },
  )
  .put(
    "/project/:projectId/mind-map",
    describeRoute({
      operationId: "linkProjectMindMap",
      tags: ["Integrations"],
      description:
        "Link a WiseMapping map ID to a project. Requires workspace manage_settings permission.",
      responses: {
        200: {
          description: "Mind map linked",
          content: {
            "application/json": { schema: resolver(mindMapBindingSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ projectId: v.string() })),
    validator(
      "json",
      v.object({
        mapId: v.pipe(v.string(), v.maxLength(MAP_ID_MAX_LENGTH)),
      }),
    ),
    workspaceAccess.fromProject("projectId"),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const { mapId } = c.req.valid("json");

      const validation = validateMapId(mapId);
      if (!validation.valid) {
        return c.json({ error: validation.reason }, 400);
      }

      const binding = await upsertMindMapBinding({
        projectId,
        mapId: validation.mapId,
      });

      return c.json(binding);
    },
  )
  .delete(
    "/project/:projectId/mind-map",
    describeRoute({
      operationId: "unlinkProjectMindMap",
      tags: ["Integrations"],
      description:
        "Remove the WiseMapping map binding for a project. The external map is never touched. Requires workspace manage_settings permission.",
      responses: {
        200: {
          description: "Mind map unlinked",
          content: {
            "application/json": { schema: resolver(mindMapBindingSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ projectId: v.string() })),
    workspaceAccess.fromProject("projectId"),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const result = await deleteMindMapBinding(projectId);
      return c.json(result);
    },
  );

export default embeddedIntegration;

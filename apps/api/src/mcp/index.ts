import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { auth } from "../auth";
import { verifyApiKey } from "../utils/verify-api-key";
import {
  beginMcpAuthorization,
  decideMcpAuthorizationRequest,
  getMcpAuthorizationRequest,
  registerMcpClient,
} from "./controllers/oauth-consent";
import { exchangeCode } from "./oauth";
import {
  authorizationDecisionResponseSchema,
  authorizationDecisionSchema,
  authorizationQuerySchema,
  authorizationRequestParamSchema,
  authorizationRequestResponseSchema,
  clientRegistrationResponseSchema,
  clientRegistrationSchema,
  oauthErrorSchema,
} from "./schemas";
import { registerMcpTools } from "./tools";

// Keep public links/metadata separate from server-to-server API calls. The
// bundled API runs on 1337 inside the container, while browsers must receive
// the private Caddy URL rather than a container loopback address.
const publicApiUrl = (
  process.env.KANEO_PUBLIC_API_URL ||
  process.env.KANEO_API_URL ||
  "http://localhost:1337"
).replace(/\/api\/?$/, "");
const internalApiUrl = (
  process.env.KANEO_INTERNAL_API_URL || "http://127.0.0.1:1337"
).replace(/\/api\/?$/, "");

const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
type McpAuthMode = "bearer" | "x-api-key";

type McpAuthResult = {
  userId: string;
  token: string;
  authMode: McpAuthMode;
};

function createMcpServerForUser(authResult: McpAuthResult): McpServer {
  const server = new McpServer({
    name: "kaneo-mcp",
    version: "1.0.0",
  });
  registerMcpTools(
    server,
    internalApiUrl,
    authResult.token,
    authResult.authMode,
  );
  return server;
}

async function validateBearerToken(
  req: Request,
): Promise<McpAuthResult | null> {
  const authHeader = req.headers.get("authorization");
  const bearerMatch = authHeader?.match(/^Bearer\s+(\S+)$/i);
  const apiKeyHeader = req.headers.get("x-api-key")?.trim();
  const token = bearerMatch?.[1] ?? apiKeyHeader;
  if (!token) return null;

  // The REST auth middleware already accepts API keys as either x-api-key or
  // Bearer. MCP bypasses that middleware, so verify the same key explicitly
  // before falling back to a normal Better Auth bearer session.
  const apiKeyResult = await verifyApiKey(token);
  if (apiKeyResult?.valid && apiKeyResult.key?.userId) {
    return { userId: apiKeyResult.key.userId, token, authMode: "x-api-key" };
  }

  if (!bearerMatch?.[1]) return null;

  const headers = new Headers();
  headers.set("authorization", `Bearer ${token}`);
  const session = await auth.api.getSession({ headers });

  if (!session?.user?.id) return null;
  return { userId: session.user.id, token, authMode: "bearer" };
}

const mcp = new Hono();

mcp.post(
  "/mcp/register",
  describeRoute({
    operationId: "registerMcpOAuthClient",
    tags: ["MCP"],
    description: "Register a public OAuth client for the MCP endpoint",
    security: [],
    responses: {
      200: {
        description: "Registered OAuth client",
        content: {
          "application/json": {
            schema: resolver(clientRegistrationResponseSchema),
          },
        },
      },
      400: {
        description: "Invalid client metadata",
        content: {
          "application/json": { schema: resolver(oauthErrorSchema) },
        },
      },
    },
  }),
  validator("json", clientRegistrationSchema),
  (c) => c.json(registerMcpClient(c.req.valid("json"))),
);

mcp.get(
  "/mcp/authorize",
  describeRoute({
    operationId: "authorizeMcpOAuthClient",
    tags: ["MCP"],
    description: "Start an explicit MCP OAuth consent request",
    security: [],
    responses: {
      302: { description: "Redirect to the Kaneo consent page" },
      400: {
        description: "Invalid authorization request",
        content: {
          "application/json": { schema: resolver(oauthErrorSchema) },
        },
      },
    },
  }),
  validator("query", authorizationQuerySchema),
  (c) => c.redirect(beginMcpAuthorization(c.req.valid("query"))),
);

mcp.get(
  "/mcp/authorize/request/:requestId",
  describeRoute({
    operationId: "getMcpAuthorizationRequest",
    tags: ["MCP"],
    description: "Get display details for an MCP OAuth consent request",
    security: [],
    responses: {
      200: {
        description: "Authorization request details",
        content: {
          "application/json": {
            schema: resolver(authorizationRequestResponseSchema),
          },
        },
      },
      400: {
        description: "Invalid OAuth client",
        content: {
          "application/json": { schema: resolver(oauthErrorSchema) },
        },
      },
      404: {
        description: "Unknown or expired authorization request",
        content: {
          "application/json": { schema: resolver(oauthErrorSchema) },
        },
      },
    },
  }),
  validator("param", authorizationRequestParamSchema),
  (c) => {
    const { requestId } = c.req.valid("param");
    return c.json(getMcpAuthorizationRequest(requestId));
  },
);

mcp.post(
  "/mcp/authorize/request/:requestId",
  describeRoute({
    operationId: "decideMcpAuthorizationRequest",
    tags: ["MCP"],
    description: "Approve or deny an MCP OAuth consent request",
    responses: {
      200: {
        description: "OAuth client redirect",
        content: {
          "application/json": {
            schema: resolver(authorizationDecisionResponseSchema),
          },
        },
      },
      400: {
        description: "Invalid request or OAuth client",
        content: {
          "application/json": { schema: resolver(oauthErrorSchema) },
        },
      },
      401: {
        description: "Authentication required",
        content: {
          "application/json": { schema: resolver(oauthErrorSchema) },
        },
      },
      403: {
        description: "Untrusted request origin",
        content: {
          "application/json": { schema: resolver(oauthErrorSchema) },
        },
      },
      404: {
        description: "Unknown or expired authorization request",
        content: {
          "application/json": { schema: resolver(oauthErrorSchema) },
        },
      },
    },
  }),
  validator("param", authorizationRequestParamSchema),
  validator("json", authorizationDecisionSchema),
  async (c) => {
    const { requestId } = c.req.valid("param");
    const redirect = await decideMcpAuthorizationRequest({
      requestId,
      decision: c.req.valid("json"),
      headers: c.req.raw.headers,
      origin: c.req.header("origin"),
    });
    return c.json({ redirect });
  },
);

mcp.post("/mcp/token", async (c) => {
  const contentType = c.req.header("content-type") || "";
  let params: Record<string, string>;

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const body = await c.req.text();
    params = Object.fromEntries(new URLSearchParams(body));
  } else {
    params = await c.req.json();
  }

  const { grant_type, code, client_id, code_verifier, redirect_uri } = params;

  if (grant_type !== "authorization_code") {
    return c.json({ error: "unsupported_grant_type" }, 400);
  }
  if (!code || !client_id || !code_verifier || !redirect_uri) {
    return c.json({ error: "invalid_request" }, 400);
  }

  const result = await exchangeCode(
    code,
    client_id,
    code_verifier,
    redirect_uri,
  );
  if (!result) {
    return c.json({ error: "invalid_grant" }, 400);
  }

  return c.json({
    access_token: result.accessToken,
    token_type: "bearer",
    expires_in: result.expiresIn,
  });
});

mcp.get("/.well-known/oauth-protected-resource/api/mcp", (c) =>
  c.json({
    resource: `${publicApiUrl}/api/mcp`,
    authorization_servers: [`${publicApiUrl}/api`],
  }),
);

mcp.get("/.well-known/oauth-authorization-server/api", (c) =>
  c.json({
    issuer: `${publicApiUrl}/api`,
    authorization_endpoint: `${publicApiUrl}/api/mcp/authorize`,
    token_endpoint: `${publicApiUrl}/api/mcp/token`,
    registration_endpoint: `${publicApiUrl}/api/mcp/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  }),
);

mcp.all("/mcp", async (c) => {
  const authResult = await validateBearerToken(c.req.raw);
  if (!authResult) {
    const prmUrl = `${publicApiUrl}/api/.well-known/oauth-protected-resource/api/mcp`;
    c.header("WWW-Authenticate", `Bearer resource_metadata="${prmUrl}"`);
    return c.json(
      {
        error: "invalid_token",
        error_description: "Missing or invalid token",
      },
      401,
    );
  }

  const sessionId = c.req.header("mcp-session-id");

  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (existing) {
      return existing.handleRequest(c.req.raw);
    }
    return c.json({ error: "Session not found" }, 404);
  }

  if (c.req.method !== "POST") {
    return c.json({ error: "Method not allowed" }, 405);
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      sessions.delete(transport.sessionId);
    }
  };

  const server = createMcpServerForUser(authResult);
  await server.connect(transport);
  const response = await transport.handleRequest(c.req.raw);

  if (transport.sessionId) {
    sessions.set(transport.sessionId, transport);
  }

  return response;
});

export default mcp;

export function mcpWellKnownRoutes(baseUrl: string) {
  const wellKnown = new Hono();

  wellKnown.get("/.well-known/oauth-protected-resource/api/mcp", (c) =>
    c.json({
      resource: `${baseUrl}/api/mcp`,
      authorization_servers: [`${baseUrl}/api`],
    }),
  );

  wellKnown.get("/.well-known/oauth-authorization-server/api", (c) =>
    c.json({
      issuer: `${baseUrl}/api`,
      authorization_endpoint: `${baseUrl}/api/mcp/authorize`,
      token_endpoint: `${baseUrl}/api/mcp/token`,
      registration_endpoint: `${baseUrl}/api/mcp/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    }),
  );

  return wellKnown;
}

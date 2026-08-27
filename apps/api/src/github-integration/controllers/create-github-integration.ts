import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  githubIntegrationTable,
  integrationTable,
  projectTable,
} from "../../database/schema";
import { defaultGitHubConfig } from "../../plugins/github/config";
import { getGithubApp } from "../../plugins/github/utils/github-app";

async function createGithubIntegration({
  projectId,
  repositoryOwner,
  repositoryName,
}: {
  projectId: string;
  repositoryOwner: string;
  repositoryName: string;
}) {
  const githubApp = getGithubApp();

  if (!githubApp) {
    throw new HTTPException(500, {
      message: "GitHub app not configured",
    });
  }

  const project = await db.query.projectTable.findFirst({
    where: eq(projectTable.id, projectId),
  });

  if (!project) {
    throw new HTTPException(404, { message: "Project not found" });
  }

  const allGitHubIntegrations = await db.query.integrationTable.findMany({
    where: eq(integrationTable.type, "github"),
  });

  for (const integration of allGitHubIntegrations) {
    if (integration.projectId === projectId) {
      continue;
    }

    try {
      const config = JSON.parse(integration.config);
      if (
        config.repositoryOwner === repositoryOwner &&
        config.repositoryName === repositoryName
      ) {
        throw new HTTPException(409, {
          message: `Repository ${repositoryOwner}/${repositoryName} is already linked to another project`,
        });
      }
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
    }
  }

  let installationId: number | null = null;
  try {
    const { data: installation } =
      await githubApp.octokit.rest.apps.getRepoInstallation({
        owner: repositoryOwner,
        repo: repositoryName,
      });
    installationId = installation.id;
  } catch (error) {
    console.warn("Could not get installation ID for repository:", error);
  }

  const config = {
    repositoryOwner,
    repositoryName,
    installationId,
    ...defaultGitHubConfig,
  };

  return db.transaction(async (tx) => {
    const now = new Date();
    const [savedIntegration] = await tx
      .insert(integrationTable)
      .values({
        projectId,
        type: "github",
        config: JSON.stringify(config),
        isActive: true,
      })
      .onConflictDoUpdate({
        target: [integrationTable.projectId, integrationTable.type],
        set: {
          config: JSON.stringify(config),
          isActive: true,
          updatedAt: now,
        },
      })
      .returning();

    if (!savedIntegration) {
      throw new HTTPException(500, {
        message: "Failed to save GitHub integration",
      });
    }

    await tx
      .insert(githubIntegrationTable)
      .values({
        projectId,
        repositoryOwner,
        repositoryName,
        installationId,
        isActive: true,
        createdAt: savedIntegration.createdAt,
        updatedAt: savedIntegration.updatedAt,
      })
      .onConflictDoUpdate({
        target: githubIntegrationTable.projectId,
        set: {
          repositoryOwner,
          repositoryName,
          installationId,
          isActive: true,
          updatedAt: savedIntegration.updatedAt,
        },
      });

    return {
      id: savedIntegration.id,
      projectId: savedIntegration.projectId,
      repositoryOwner,
      repositoryName,
      installationId,
      isActive: savedIntegration.isActive,
      createdAt: savedIntegration.createdAt,
      updatedAt: savedIntegration.updatedAt,
    };
  });
}

export default createGithubIntegration;

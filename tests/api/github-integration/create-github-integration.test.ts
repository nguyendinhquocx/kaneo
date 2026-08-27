import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findProject: vi.fn(),
  findGitHubIntegrations: vi.fn(),
  getRepoInstallation: vi.fn(),
  insert: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../../../apps/api/src/database", () => ({
  default: {
    query: {
      projectTable: {
        findFirst: (...args: unknown[]) => mocks.findProject(...args),
      },
      integrationTable: {
        findMany: (...args: unknown[]) => mocks.findGitHubIntegrations(...args),
      },
    },
    transaction: (...args: unknown[]) => mocks.transaction(...args),
  },
}));

vi.mock("../../../apps/api/src/plugins/github/utils/github-app", () => ({
  getGithubApp: () => ({
    octokit: {
      rest: {
        apps: {
          getRepoInstallation: (...args: unknown[]) =>
            mocks.getRepoInstallation(...args),
        },
      },
    },
  }),
}));

import {
  githubIntegrationTable,
  integrationTable,
} from "../../../apps/api/src/database/schema";
import createGithubIntegration from "../../../apps/api/src/github-integration/controllers/create-github-integration";

function makeInsertBuilder(returnedRow: unknown) {
  const builder = {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([returnedRow]),
  };
  return builder;
}

describe("createGithubIntegration", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.findProject.mockResolvedValue({ id: "project-1" });
    mocks.findGitHubIntegrations.mockResolvedValue([]);
    mocks.getRepoInstallation.mockResolvedValue({ data: { id: 12345 } });
  });

  it("upserts the canonical and execution compatibility rows in one transaction", async () => {
    const createdAt = new Date("2026-08-27T00:00:00.000Z");
    const updatedAt = new Date("2026-08-27T00:01:00.000Z");
    const canonicalRow = {
      id: "integration-1",
      projectId: "project-1",
      isActive: true,
      createdAt,
      updatedAt,
    };
    const canonicalInsert = makeInsertBuilder(canonicalRow);
    const compatibilityInsert = makeInsertBuilder(undefined);
    const tx = {
      insert: mocks.insert,
    };
    mocks.insert
      .mockReturnValueOnce(canonicalInsert)
      .mockReturnValueOnce(compatibilityInsert);
    mocks.transaction.mockImplementation(async (callback) => callback(tx));

    const result = await createGithubIntegration({
      projectId: "project-1",
      repositoryOwner: "owner",
      repositoryName: "repository",
    });

    expect(result).toEqual({
      id: "integration-1",
      projectId: "project-1",
      repositoryOwner: "owner",
      repositoryName: "repository",
      installationId: 12345,
      isActive: true,
      createdAt,
      updatedAt,
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.insert).toHaveBeenNthCalledWith(1, integrationTable);
    expect(mocks.insert).toHaveBeenNthCalledWith(2, githubIntegrationTable);

    expect(canonicalInsert.values).toHaveBeenCalledWith({
      projectId: "project-1",
      type: "github",
      config: expect.stringContaining('"repositoryOwner":"owner"'),
      isActive: true,
    });
    expect(canonicalInsert.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: [integrationTable.projectId, integrationTable.type],
        set: expect.objectContaining({ isActive: true }),
      }),
    );
    expect(compatibilityInsert.values).toHaveBeenCalledWith({
      projectId: "project-1",
      repositoryOwner: "owner",
      repositoryName: "repository",
      installationId: 12345,
      isActive: true,
      createdAt,
      updatedAt,
    });
    expect(compatibilityInsert.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: githubIntegrationTable.projectId,
        set: expect.objectContaining({
          repositoryOwner: "owner",
          repositoryName: "repository",
          installationId: 12345,
          isActive: true,
          updatedAt,
        }),
      }),
    );
  });
});

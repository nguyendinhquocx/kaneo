import { and, eq, max } from "drizzle-orm";
import db from "../../../database";
import { columnTable, projectTable, taskTable } from "../../../database/schema";
import { lockProjectTaskLanes } from "../../../task/lock-project-task-lanes";
import { claimTaskNumber } from "../../../task/controllers/claim-task-numbers";
import type { GitHubConfig } from "../config";
import { createExternalLink, findExternalLink } from "../services/link-manager";
import { findAllIntegrationsByRepo } from "../services/task-service";
import {
  extractIssuePriority,
  extractIssueStatus,
} from "../utils/extract-priority";
import { formatTaskDescriptionFromIssue } from "../utils/format";
import { getGithubApp } from "../utils/github-app";
import { addLabelsToIssue } from "../utils/labels";
import { resolveTargetStatus } from "../utils/resolve-column";

type IssueOpenedPayload = {
  action: string;
  issue: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    labels?: Array<string | { name?: string }>;
    user: { login: string } | null;
  };
  repository: {
    owner: { login: string };
    name: string;
    full_name: string;
  };
};

export async function handleIssueOpened(payload: IssueOpenedPayload) {
  const githubApp = getGithubApp();
  if (!githubApp) {
    return;
  }

  const { issue, repository } = payload;

  const appName = process.env.GITHUB_APP_NAME;
  if (appName && issue.user?.login === `${appName}[bot]`) {
    console.log(
      `Issue #${issue.number} was created by the configured GitHub App, skipping task creation`,
    );
    return;
  }

  const integrations = await findAllIntegrationsByRepo(
    repository.owner.login,
    repository.name,
  );

  if (integrations.length === 0) {
    return;
  }

  for (const integration of integrations) {
    const config = JSON.parse(integration.config) as GitHubConfig;
    const projectId = integration.projectId;

    const priority = extractIssuePriority(issue.labels);
    const status = extractIssueStatus(issue.labels);

    const existingLink = await findExternalLink(
      integration.id,
      "issue",
      issue.number.toString(),
    );

    if (existingLink) {
      console.log(
        `Issue #${issue.number} already linked to task ${existingLink.taskId} in project ${projectId}, skipping`,
      );
      continue;
    }

    const resolvedStatus = await resolveTargetStatus(
      projectId,
      "issue_opened",
      status || "to-do",
    );

    const createdTask = await db.transaction(async (tx) => {
      await lockProjectTaskLanes(tx, [projectId]);
      const nextTaskNumber = await claimTaskNumber(projectId, tx);
      const [targetColumn] = await tx
        .select({ id: columnTable.id })
        .from(columnTable)
        .where(
          and(
            eq(columnTable.projectId, projectId),
            eq(columnTable.slug, resolvedStatus),
          ),
        )
        .limit(1);
      const [maxPositionResult] = await tx
        .select({ maxPosition: max(taskTable.position) })
        .from(taskTable)
        .where(
          and(
            eq(taskTable.projectId, projectId),
            targetColumn?.id
              ? eq(taskTable.columnId, targetColumn.id)
              : eq(taskTable.status, resolvedStatus),
          ),
        );
      const taskValues: typeof taskTable.$inferInsert = {
        projectId,
        userId: null,
        title: issue.title,
        description: formatTaskDescriptionFromIssue(issue.body),
        status: resolvedStatus,
        columnId: targetColumn?.id ?? null,
        position: (maxPositionResult?.maxPosition ?? 0) + 1,
        priority: null,
        number: nextTaskNumber,
      };
      if (priority) taskValues.priority = priority;
      const [task] = await tx
        .insert(taskTable)
        .values(taskValues)
        .returning();
      return task;
    });

    if (!createdTask) {
      console.error("Failed to create task from GitHub issue");
      continue;
    }

    await createExternalLink({
      taskId: createdTask.id,
      integrationId: integration.id,
      resourceType: "issue",
      externalId: issue.number.toString(),
      url: issue.html_url,
      title: issue.title,
      metadata: {
        state: "open",
        createdFrom: "github",
        author: issue.user?.login,
      },
    });

    const project = await db.query.projectTable.findFirst({
      where: eq(projectTable.id, projectId),
    });

    if (!project) {
      console.error("Project not found for task linking comment");
      continue;
    }

    const clientUrl = process.env.KANEO_CLIENT_URL || "http://localhost:5173";
    const taskUrl = `${clientUrl}/dashboard/workspace/${project.workspaceId}/project/${projectId}/task/${createdTask.id}`;
    const taskIdentifier = `${project.slug.toUpperCase()}-${createdTask.number}`;

    try {
      let installationId = config.installationId;
      if (!installationId) {
        const { data: installation } =
          await githubApp.octokit.rest.apps.getRepoInstallation({
            owner: repository.owner.login,
            repo: repository.name,
          });
        installationId = installation.id;
      }

      const octokit = await githubApp.getInstallationOctokit(installationId);

      const existingLabels =
        issue.labels
          ?.map((label) => (typeof label === "string" ? label : label.name))
          .filter(Boolean) || [];

      const labelsToAdd: string[] = [];

      if (priority && !existingLabels.includes(`priority:${priority}`)) {
        labelsToAdd.push(`priority:${priority}`);
      }

      if (status && !existingLabels.includes(`status:${status}`)) {
        labelsToAdd.push(`status:${status}`);
      }

      if (labelsToAdd.length > 0) {
        await addLabelsToIssue(
          octokit,
          repository.owner.login,
          repository.name,
          issue.number,
          labelsToAdd,
        );
      }

      if (config.commentTaskLinkOnGitHubIssue !== false) {
        await octokit.rest.issues.createComment({
          owner: repository.owner.login,
          repo: repository.name,
          issue_number: issue.number,
          body: `[${taskIdentifier}](${taskUrl})`,
        });
      }
    } catch (error) {
      console.error("Failed to process GitHub issue:", error);
    }
  }
}

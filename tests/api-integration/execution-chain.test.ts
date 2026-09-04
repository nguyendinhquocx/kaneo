import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import {
  advanceChainAfterFinalize,
  resumeChainSchedules,
} from "../../apps/api/src/execution/schedules";
import { EXECUTION_FLAGS, setExecutionFlag } from "../../apps/api/src/execution/gates";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

async function createChainFixture(taskCount: number) {
  const member = await createWorkspaceMember({ role: "admin" });
  const { project, columns } = await createProjectFixture({
    workspaceId: member.workspace.id,
  });
  const todoColumnId = columns.todo.id;
  const taskIds: string[] = [];
  for (let index = 0; index < taskCount; index += 1) {
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        userId: member.user.id,
        title: `chain-node-${index}`,
        description: JSON.stringify({ files: [`chain/${index}.txt`] }),
        status: "ready",
        columnId: todoColumnId,
        priority: "low",
        number: index + 1,
        position: index + 1,
        executionState: "ready",
      })
      .returning();
    if (!task) throw new Error(`failed to create chain node ${index}`);
    taskIds.push(task.id);
  }
  for (let index = 0; index + 1 < taskIds.length; index += 1) {
    await db.insert(schema.taskRelationTable).values({
      sourceTaskId: taskIds[index],
      targetTaskId: taskIds[index + 1],
      relationType: "blocks",
    });
  }
  return { project, taskIds, member };
}

async function finalizeTask(taskId: string, requestKey: string) {
  await db
    .update(schema.taskTable)
    .set({ executionState: "done" })
    .where(eq(schema.taskTable.id, taskId));
  await advanceChainAfterFinalize({
    // The chain fixture uses one project; read the id back from the task.
    projectId: (
      await db
        .select({ projectId: schema.taskTable.projectId })
        .from(schema.taskTable)
        .where(eq(schema.taskTable.id, taskId))
        .limit(1)
    )[0]?.projectId as string,
    finalizedTaskId: taskId,
    finalizedRequestKey: requestKey,
  });
}

describe("API integration: auto-chain pause/re-kick (#15)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    // Default: chain unpaused, regardless of seed state.
    await setExecutionFlag(EXECUTION_FLAGS.chainPaused, false);
  });

  it("advances a 100-node chain one schedule per finalize, idempotently", async () => {
    const { taskIds } = await createChainFixture(100);

    for (let index = 0; index + 1 < taskIds.length; index += 1) {
      await finalizeTask(taskIds[index], `req-${index}`);
      const [nextSchedule] = await db
        .select()
        .from(schema.executionScheduleTable)
        .where(eq(schema.executionScheduleTable.taskId, taskIds[index + 1]));
      expect(nextSchedule).toMatchObject({ enabled: true });
    }

    // Full chain scheduled exactly once each; no duplicates from repeated
    // advance calls on the same finalize.
    await finalizeTask(taskIds[taskIds.length - 2], "req-dup");
    const schedules = await db.select().from(schema.executionScheduleTable);
    expect(schedules).toHaveLength(taskIds.length - 1);
    const uniqueTaskIds = new Set(schedules.map((row) => row.taskId));
    expect(uniqueTaskIds.size).toBe(schedules.length);
  });

  it("stops creating new chain schedules while paused and notifies once", async () => {
    const { taskIds } = await createChainFixture(3);
    await finalizeTask(taskIds[0], "req-0");
    await setExecutionFlag(EXECUTION_FLAGS.chainPaused, true);

    await finalizeTask(taskIds[1], "req-1");
    const schedules = await db
      .select()
      .from(schema.executionScheduleTable)
      .where(eq(schema.executionScheduleTable.taskId, taskIds[2]));
    expect(schedules).toHaveLength(0);

    const pausedEvents = await db
      .select()
      .from(schema.executionNotificationEventTable);
    expect(
      pausedEvents.some(
        (event) =>
          event.kind === "chain_paused" && event.taskId === taskIds[1],
      ),
    ).toBe(true);
  });

  it("re-kicks the remaining chain after unpause", async () => {
    const { taskIds, project, member } = await createChainFixture(5);
    await finalizeTask(taskIds[0], "req-0");
    await setExecutionFlag(EXECUTION_FLAGS.chainPaused, true);
    await finalizeTask(taskIds[1], "req-1");
    await finalizeTask(taskIds[2], "req-2");

    // Re-kick while still paused must 409.
    await expect(
      resumeChainSchedules({ projectId: project.id, userId: member.user.id }),
    ).rejects.toMatchObject({ status: 409 });
    await setExecutionFlag(EXECUTION_FLAGS.chainPaused, false);

    const rekick = await resumeChainSchedules({
      projectId: project.id,
      userId: member.user.id,
    });
    // Node 1 got its schedule pre-pause; nodes 2, 3, 4 have all blockers done
    // with no schedule, so the sweep catches the whole tail at once.
    expect(rekick.scheduledTaskIds.sort()).toEqual(
      [taskIds[2], taskIds[3], taskIds[4]].sort(),
    );

    // Idempotent: a second re-kick schedules nothing new.
    const again = await resumeChainSchedules({
      projectId: project.id,
      userId: member.user.id,
    });
    expect(again.scheduledTaskIds).toEqual([]);
  });
});

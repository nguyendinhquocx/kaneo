import { client } from "@kaneo/libs";

export type Goal = {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  projectId: string | null;
  name: string;
  visibility: string;
  targetPerWeek: number | null;
  timezone: string;
  position: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GoalCheckin = {
  id: string;
  goalId: string;
  checkInDate: string;
  completed: boolean;
  checkedByUserId: string | null;
  note: string;
  noteRevision: number;
  createdAt: string;
  updatedAt: string;
};

export type GoalWithCheckins = Goal & {
  checkins: GoalCheckin[];
  totalCompleted: number;
  totalAllTime: number;
};

export async function listGoals(input: {
  workspaceId: string;
  includeArchived?: boolean;
  from?: string;
  to?: string;
}) {
  const response = await client.goal.$get({
    query: {
      workspaceId: input.workspaceId,
      ...(input.includeArchived ? { includeArchived: "true" } : {}),
      ...(input.from ? { from: input.from } : {}),
      ...(input.to ? { to: input.to } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as GoalWithCheckins[];
}

export async function getGoalCheckins(goalId: string) {
  const response = await client.goal[":id"].checkins.$get({
    param: { id: goalId },
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as GoalCheckin[];
}

export async function createGoal(input: {
  workspaceId: string;
  name: string;
  visibility?: "private" | "workspace";
  projectId?: string | null;
  targetPerWeek?: number | null;
  timezone?: string;
}) {
  const response = await client.goal.$post({ json: input });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as Goal;
}

export async function toggleGoalCheckin(input: {
  goalId: string;
  date: string;
  ensureOnly?: boolean;
}) {
  const response = await client.goal[":id"].checkin.$post({
    param: { id: input.goalId },
    json: { date: input.date, ensureOnly: input.ensureOnly },
  });
  if (response.status === 409) {
    return { archived: true as const };
  }
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as GoalCheckin;
}

export async function updateGoalCheckinNote(input: {
  checkinId: string;
  note: string;
  noteRevision: number;
}) {
  const response = await client.goal.checkin[":id"].$put({
    param: { id: input.checkinId },
    json: {
      note: input.note,
      noteRevision: input.noteRevision,
    },
  });
  if (response.status === 409) {
    return { conflict: true as const };
  }
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as GoalCheckin;
}

export async function setGoalArchived(input: {
  goalId: string;
  archived: boolean;
}) {
  const route = input.archived
    ? client.goal[":id"].archive
    : client.goal[":id"].unarchive;
  const response = await route.$put({ param: { id: input.goalId } });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as Goal;
}

export async function deleteGoal(input: { goalId: string }) {
  const response = await client.goal[":id"].$delete({
    param: { id: input.goalId },
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as Goal;
}

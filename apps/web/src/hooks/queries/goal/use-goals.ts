import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createGoal,
  deleteGoal,
  type Goal,
  type GoalCheckin,
  type GoalWithCheckins,
  getGoalCheckins,
  listGoals,
  setGoalArchived,
  toggleGoalCheckin,
  updateGoalCheckinNote,
} from "@/fetchers/goal/goal-api";

export function useGetGoals(input: {
  workspaceId: string;
  includeArchived?: boolean;
  from?: string;
  to?: string;
}) {
  return useQuery({
    queryKey: [
      "goals",
      input.workspaceId,
      input.includeArchived ?? false,
      input.from ?? "",
      input.to ?? "",
    ],
    queryFn: () => listGoals(input),
    enabled: Boolean(input.workspaceId),
  });
}

export function useCreateGoal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createGoal,
    onSuccess: (goal: Goal) => {
      queryClient.invalidateQueries({ queryKey: ["goals", goal.workspaceId] });
    },
  });
}

function cachedGoalsKeys(queryClient: ReturnType<typeof useQueryClient>) {
  return queryClient
    .getQueryCache()
    .findAll({ queryKey: ["goals"], exact: false })
    .map((query) => query.queryKey);
}

// R2-T5: flip the cached check-in row and adjust totalAllTime in EVERY cached
// week query immediately, so ticks feel instant and totals are correct when
// the user navigates between weeks before the refetch lands.
function applyToggleToCache(
  queryClient: ReturnType<typeof useQueryClient>,
  goalId: string,
  date: string,
  serverRow?: GoalCheckin,
) {
  for (const key of cachedGoalsKeys(queryClient)) {
    queryClient.setQueryData<GoalWithCheckins[]>(key, (current) =>
      current?.map((goal) => {
        if (goal.id !== goalId) return goal;
        const existing = goal.checkins.find((ci) => ci.checkInDate === date);
        const nextCompleted = serverRow
          ? serverRow.completed
          : !(existing?.completed === true);
        const delta =
          (nextCompleted ? 1 : 0) - (existing?.completed === true ? 1 : 0);
        const checkins = existing
          ? goal.checkins.map((ci) =>
              ci.checkInDate === date
                ? (serverRow ?? { ...ci, completed: nextCompleted })
                : ci,
            )
          : [
              serverRow ?? {
                id: `optimistic-${goalId}-${date}`,
                goalId,
                checkInDate: date,
                completed: true,
                checkedByUserId: null,
                note: "",
                noteRevision: 0,
                createdAt: "",
                updatedAt: "",
              },
            ];
        return {
          ...goal,
          checkins,
          totalAllTime: Math.max(0, goal.totalAllTime + delta),
        };
      }),
    );
  }
}

export function useToggleGoalCheckin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: toggleGoalCheckin,
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: ["goals"] });
      const snapshots = cachedGoalsKeys(queryClient).map((key) => ({
        key,
        data: queryClient.getQueryData<GoalWithCheckins[]>(key),
      }));
      applyToggleToCache(queryClient, input.goalId, input.date);
      return { snapshots };
    },
    onError: (_error, _input, context) => {
      for (const snapshot of context?.snapshots ?? []) {
        if (snapshot.data !== undefined) {
          queryClient.setQueryData(snapshot.key, snapshot.data);
        }
      }
    },
    onSuccess: (result, input, context) => {
      if ("archived" in result) {
        // 409: the goal was archived between render and toggle — revert.
        for (const snapshot of context?.snapshots ?? []) {
          if (snapshot.data !== undefined) {
            queryClient.setQueryData(snapshot.key, snapshot.data);
          }
        }
        return;
      }
      applyToggleToCache(queryClient, input.goalId, input.date, result);
      // Mark stale without refetching: the cache already matches the server.
      queryClient.invalidateQueries({
        queryKey: ["goals"],
        refetchType: "none",
      });
      queryClient.invalidateQueries({
        queryKey: ["goal-checkins"],
        refetchType: "none",
      });
    },
  });
}

export function useUpdateGoalCheckinNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateGoalCheckinNote,
    onSuccess: (result) => {
      if (!("conflict" in result)) {
        queryClient.invalidateQueries({ queryKey: ["goals"] });
        queryClient.invalidateQueries({ queryKey: ["goal-checkins"] });
        queryClient.invalidateQueries({
          queryKey: ["goal-checkin", result.id],
        });
      }
    },
  });
}

export function useGetGoalCheckins(goalId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["goal-checkins", goalId],
    queryFn: () => getGoalCheckins(goalId as string),
    enabled: Boolean(goalId) && enabled,
  });
}

export function useSetGoalArchived() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: setGoalArchived,
    onSuccess: (goal: Goal) => {
      queryClient.invalidateQueries({ queryKey: ["goals", goal.workspaceId] });
    },
  });
}

export function useDeleteGoal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteGoal,
    onSuccess: (deleted: Goal) => {
      // R2-T6: hard delete — drop the row from every cached week query.
      for (const key of cachedGoalsKeys(queryClient)) {
        queryClient.setQueryData<GoalWithCheckins[]>(
          key,
          (current) =>
            current?.filter((goal) => goal.id !== deleted.id) ?? current,
        );
      }
      queryClient.removeQueries({ queryKey: ["goal-checkins", deleted.id] });
      queryClient.invalidateQueries({
        queryKey: ["goals"],
        refetchType: "none",
      });
    },
  });
}

export type GoalType = GoalWithCheckins;

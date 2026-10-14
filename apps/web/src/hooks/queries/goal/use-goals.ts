import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createGoal,
  type Goal,
  type GoalCheckin,
  type GoalWithCheckins,
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

export function useToggleGoalCheckin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: toggleGoalCheckin,
    onSuccess: (result) => {
      if (!("archived" in result)) {
        queryClient.invalidateQueries({ queryKey: ["goals"] });
        queryClient.invalidateQueries({
          queryKey: ["goal-checkin", result.id],
        });
      }
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
        queryClient.invalidateQueries({
          queryKey: ["goal-checkin", result.id],
        });
      }
    },
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

export type GoalType = GoalWithCheckins;
export type GoalCheckinType = GoalCheckin;

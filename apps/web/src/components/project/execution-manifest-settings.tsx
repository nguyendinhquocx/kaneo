import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Github,
  Plus,
  RefreshCw,
  Save,
  Server,
  XCircle,
} from "lucide-react";
import React from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod/v4";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import type { ExecutionAgent } from "@/fetchers/execution/get-execution-agents";
import useCreateExecutionAgent from "@/hooks/mutations/execution/use-create-execution-agent";
import useUpsertExecutionManifest from "@/hooks/mutations/execution/use-upsert-execution-manifest";
import useGetExecutionAgents from "@/hooks/queries/execution/use-get-execution-agents";
import useGetExecutionManifest from "@/hooks/queries/execution/use-get-execution-manifest";
import useGetGithubIntegration from "@/hooks/queries/github-integration/use-get-github-integration";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import { toast } from "@/lib/toast";

type ManifestFormValues = {
  baseBranch: string;
  docs: string;
  verificationProfile: string;
  allowedAgentIds: string[];
};

const stableIdentityPattern = /^[a-z0-9][a-z0-9._-]{1,63}$/i;

function isInvalidRelativeReference(value: string) {
  return (
    !value ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment === "..")
  );
}

function parseDocs(value: string) {
  return value
    .split("\n")
    .map((reference) => reference.trim())
    .filter(Boolean);
}

export function ExecutionManifestSettings({
  projectId,
}: {
  projectId: string;
}) {
  const { t } = useTranslation();
  const { canManageProjects } = useWorkspacePermission();
  const canEdit = canManageProjects();
  const { data: integration, isLoading: isIntegrationLoading } =
    useGetGithubIntegration(projectId);
  const {
    data: manifest,
    isLoading: isManifestLoading,
    isFetching: isManifestFetching,
  } = useGetExecutionManifest(projectId);
  const { data: agents = [], isLoading: areAgentsLoading } =
    useGetExecutionAgents();
  const { mutateAsync: saveManifest, isPending: isSaving } =
    useUpsertExecutionManifest();
  const { mutateAsync: registerAgent, isPending: isRegisteringAgent } =
    useCreateExecutionAgent();

  const manifestSchema = React.useMemo(
    () =>
      z.object({
        baseBranch: z
          .string()
          .trim()
          .min(
            1,
            t(
              "settings:projectIntegrations.agentExecution.validation.baseBranchRequired",
            ),
          )
          .max(
            200,
            t(
              "settings:projectIntegrations.agentExecution.validation.baseBranchInvalid",
            ),
          )
          .refine(
            (value) =>
              !value.startsWith("-") &&
              !value.startsWith("/") &&
              !value.endsWith("/") &&
              !value.includes("..") &&
              !value.includes("//") &&
              !value.includes("@{") &&
              !/[\\s~^:?*[\]]/.test(value),
            t(
              "settings:projectIntegrations.agentExecution.validation.baseBranchInvalid",
            ),
          ),
        docs: z.string().superRefine((value, context) => {
          const references = parseDocs(value);
          if (references.length > 100) {
            context.addIssue({
              code: "custom",
              message: t(
                "settings:projectIntegrations.agentExecution.validation.docsTooMany",
              ),
            });
            return;
          }

          const invalidReference = references.find(isInvalidRelativeReference);
          if (invalidReference) {
            context.addIssue({
              code: "custom",
              message: t(
                "settings:projectIntegrations.agentExecution.validation.docsInvalid",
              ),
            });
          }
        }),
        verificationProfile: z
          .string()
          .trim()
          .min(
            2,
            t(
              "settings:projectIntegrations.agentExecution.validation.profileInvalid",
            ),
          )
          .max(
            64,
            t(
              "settings:projectIntegrations.agentExecution.validation.profileInvalid",
            ),
          )
          .regex(
            /^[a-z0-9][a-z0-9._/-]{1,63}$/,
            t(
              "settings:projectIntegrations.agentExecution.validation.profileInvalid",
            ),
          ),
        allowedAgentIds: z.array(z.string()),
      }),
    [t],
  );

  const form = useForm<ManifestFormValues>({
    resolver: standardSchemaResolver(manifestSchema),
    mode: "onChange",
    defaultValues: {
      baseBranch: "main",
      docs: "",
      verificationProfile: "",
      allowedAgentIds: [],
    },
  });

  const selectedAgentIds = form.watch("allowedAgentIds");
  const [runtimeId, setRuntimeId] = React.useState("");
  const [hostId, setHostId] = React.useState("");

  React.useEffect(() => {
    if (isManifestLoading) return;

    form.reset({
      baseBranch: manifest?.baseBranch ?? "main",
      docs: manifest?.docs.join("\n") ?? "",
      verificationProfile: manifest?.verificationProfile ?? "",
      allowedAgentIds: manifest?.allowedAgentIds ?? [],
    });
    void form.trigger();
  }, [form, isManifestLoading, manifest]);

  const activeIntegration = integration?.isActive ? integration : null;
  const integrationIsReady = Boolean(activeIntegration);
  const repositoryMismatch = Boolean(
    manifest &&
      activeIntegration &&
      (manifest.repositoryOwner !== activeIntegration.repositoryOwner ||
        manifest.repositoryName !== activeIntegration.repositoryName),
  );
  const isLoading =
    isIntegrationLoading || isManifestLoading || areAgentsLoading;

  const toggleAgent = (agentId: string, checked: boolean) => {
    const nextAgentIds = checked
      ? [...new Set([...selectedAgentIds, agentId])]
      : selectedAgentIds.filter((selectedId) => selectedId !== agentId);

    form.setValue("allowedAgentIds", nextAgentIds, {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: true,
    });
  };

  const handleRegisterAgent = async () => {
    const normalizedRuntimeId = runtimeId.trim();
    const normalizedHostId = hostId.trim();
    if (
      !stableIdentityPattern.test(normalizedRuntimeId) ||
      !stableIdentityPattern.test(normalizedHostId)
    ) {
      toast.error(
        t("settings:projectIntegrations.agentExecution.toast.identityInvalid"),
      );
      return;
    }

    try {
      const agent = await registerAgent({
        projectId,
        json: {
          runtimeId: normalizedRuntimeId,
          hostId: normalizedHostId,
        },
      });
      form.setValue(
        "allowedAgentIds",
        [...new Set([...form.getValues("allowedAgentIds"), agent.id])],
        { shouldDirty: true, shouldTouch: true, shouldValidate: true },
      );
      setRuntimeId("");
      setHostId("");
      toast.success(
        t(
          "settings:projectIntegrations.agentExecution.toast.identityRegistered",
        ),
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t(
              "settings:projectIntegrations.agentExecution.toast.identityRegisterError",
            ),
      );
    }
  };

  const onSubmit = async (data: ManifestFormValues) => {
    if (!integrationIsReady || repositoryMismatch) return;

    try {
      await saveManifest({
        projectId,
        json: {
          baseBranch: data.baseBranch,
          docs: parseDocs(data.docs),
          verificationProfile: data.verificationProfile,
          allowedAgentIds: data.allowedAgentIds,
          policy: manifest?.policy ?? {},
        },
      });
      toast.success(
        t("settings:projectIntegrations.agentExecution.toast.saved"),
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("settings:projectIntegrations.agentExecution.toast.saveError"),
      );
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="h-16 animate-pulse rounded-md border border-border bg-muted/40" />
        <div className="h-48 animate-pulse rounded-md border border-border bg-muted/40" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-md border border-border bg-sidebar p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <Github className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium">
                {t(
                  "settings:projectIntegrations.agentExecution.repositoryTitle",
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {t(
                  "settings:projectIntegrations.agentExecution.repositoryHint",
                )}
              </p>
            </div>
          </div>
          {integrationIsReady ? (
            <div className="flex min-w-0 items-center gap-2 text-sm sm:max-w-[60%]">
              <span className="truncate font-medium">
                {activeIntegration?.repositoryOwner}/
                {activeIntegration?.repositoryName}
              </span>
              <a
                aria-label={t(
                  "settings:projectIntegrations.agentExecution.openRepository",
                )}
                className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                href={`https://github.com/${activeIntegration?.repositoryOwner}/${activeIntegration?.repositoryName}`}
                rel="noreferrer"
                target="_blank"
              >
                <Github className="size-4" />
              </a>
            </div>
          ) : (
            <Badge className="shrink-0 gap-1" variant="outline">
              <XCircle className="size-3" />
              {t(
                "settings:projectIntegrations.agentExecution.repositoryNotConnected",
              )}
            </Badge>
          )}
        </div>

        {!integrationIsReady && (
          <Alert variant="warning">
            <AlertTriangle />
            <AlertTitle>
              {t(
                "settings:projectIntegrations.agentExecution.githubRequiredTitle",
              )}
            </AlertTitle>
            <AlertDescription>
              {t(
                "settings:projectIntegrations.agentExecution.githubRequiredDescription",
              )}
            </AlertDescription>
          </Alert>
        )}

        {repositoryMismatch && (
          <Alert variant="error">
            <AlertTriangle />
            <AlertTitle>
              {t(
                "settings:projectIntegrations.agentExecution.repositoryMismatchTitle",
              )}
            </AlertTitle>
            <AlertDescription>
              {t(
                "settings:projectIntegrations.agentExecution.repositoryMismatchDescription",
              )}
            </AlertDescription>
          </Alert>
        )}
      </div>

      <Form {...form}>
        <form
          className="space-y-4"
          onSubmit={form.handleSubmit(onSubmit)}
          noValidate
        >
          <div className="space-y-4 rounded-md border border-border bg-sidebar p-4">
            <div className="space-y-1">
              <h3 className="text-sm font-medium">
                {t("settings:projectIntegrations.agentExecution.contextTitle")}
              </h3>
              <p className="text-xs text-muted-foreground">
                {t(
                  "settings:projectIntegrations.agentExecution.contextDescription",
                )}
              </p>
            </div>

            <FormField
              control={form.control}
              name="baseBranch"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    {t(
                      "settings:projectIntegrations.agentExecution.baseBranchLabel",
                    )}
                  </FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      className="w-full sm:max-w-sm"
                      disabled={!canEdit || isSaving}
                      placeholder="main"
                    />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">
                    {t(
                      "settings:projectIntegrations.agentExecution.baseBranchHint",
                    )}
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Separator />

            <FormField
              control={form.control}
              name="verificationProfile"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    {t(
                      "settings:projectIntegrations.agentExecution.profileLabel",
                    )}
                  </FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      className="w-full sm:max-w-sm"
                      disabled={!canEdit || isSaving}
                      placeholder={t(
                        "settings:projectIntegrations.agentExecution.profilePlaceholder",
                      )}
                    />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">
                    {t(
                      "settings:projectIntegrations.agentExecution.profileHint",
                    )}
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Separator />

            <FormField
              control={form.control}
              name="docs"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    {t("settings:projectIntegrations.agentExecution.docsLabel")}
                  </FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      className="min-h-28 w-full resize-y"
                      disabled={!canEdit || isSaving}
                      placeholder={t(
                        "settings:projectIntegrations.agentExecution.docsPlaceholder",
                      )}
                      rows={5}
                    />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">
                    {t("settings:projectIntegrations.agentExecution.docsHint")}
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <div className="space-y-4 rounded-md border border-border bg-sidebar p-4">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1">
                <h3 className="text-sm font-medium">
                  {t("settings:projectIntegrations.agentExecution.agentsTitle")}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {t(
                    "settings:projectIntegrations.agentExecution.agentsDescription",
                  )}
                </p>
              </div>
              <Badge variant="secondary">
                {t(
                  "settings:projectIntegrations.agentExecution.selectedCount",
                  {
                    count: selectedAgentIds.length,
                  },
                )}
              </Badge>
            </div>

            {agents.length > 0 ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {agents.map((agent: ExecutionAgent) => {
                  const isSelected = selectedAgentIds.includes(agent.id);
                  return (
                    <label
                      className="flex min-h-11 min-w-0 cursor-pointer items-start gap-3 rounded-md border border-border p-3 transition-colors hover:bg-muted/50"
                      htmlFor={`execution-agent-${agent.id}`}
                      key={agent.id}
                    >
                      <Checkbox
                        checked={isSelected}
                        disabled={!canEdit || isSaving}
                        id={`execution-agent-${agent.id}`}
                        onCheckedChange={(checked) =>
                          toggleAgent(agent.id, checked === true)
                        }
                      />
                      <span className="min-w-0 space-y-0.5">
                        <span className="flex items-center gap-2 text-sm font-medium">
                          <Bot className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">{agent.runtimeId}</span>
                        </span>
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Server className="size-3 shrink-0" />
                          <span className="break-words">{agent.hostId}</span>
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <Alert>
                <Bot />
                <AlertTitle>
                  {t(
                    "settings:projectIntegrations.agentExecution.noAgentsTitle",
                  )}
                </AlertTitle>
                <AlertDescription>
                  {t(
                    "settings:projectIntegrations.agentExecution.noAgentsDescription",
                  )}
                </AlertDescription>
              </Alert>
            )}

            <Separator />

            <div className="space-y-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {t(
                    "settings:projectIntegrations.agentExecution.registerTitle",
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t(
                    "settings:projectIntegrations.agentExecution.registerDescription",
                  )}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
                <label
                  className="min-w-0 space-y-1.5"
                  htmlFor="execution-runtime-id"
                >
                  <span className="text-xs font-medium">
                    {t(
                      "settings:projectIntegrations.agentExecution.runtimeIdLabel",
                    )}
                  </span>
                  <Input
                    id="execution-runtime-id"
                    value={runtimeId}
                    onChange={(event) => setRuntimeId(event.target.value)}
                    disabled={!canEdit || isRegisteringAgent}
                    placeholder="pi-laptop"
                  />
                </label>
                <label
                  className="min-w-0 space-y-1.5"
                  htmlFor="execution-host-id"
                >
                  <span className="text-xs font-medium">
                    {t(
                      "settings:projectIntegrations.agentExecution.hostIdLabel",
                    )}
                  </span>
                  <Input
                    id="execution-host-id"
                    value={hostId}
                    onChange={(event) => setHostId(event.target.value)}
                    disabled={!canEdit || isRegisteringAgent}
                    placeholder="laptop"
                  />
                </label>
                <Button
                  className="gap-2 sm:min-w-28"
                  disabled={!canEdit || isRegisteringAgent}
                  onClick={handleRegisterAgent}
                  type="button"
                  variant="outline"
                >
                  {isRegisteringAgent ? (
                    <RefreshCw className="size-3.5 animate-spin" />
                  ) : (
                    <Plus className="size-3.5" />
                  )}
                  {t(
                    "settings:projectIntegrations.agentExecution.registerButton",
                  )}
                </Button>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              {manifest ? (
                <>
                  <CheckCircle2 className="size-3.5 shrink-0 text-success-foreground" />
                  <span className="truncate">
                    {t(
                      "settings:projectIntegrations.agentExecution.savedVersion",
                      {
                        version: manifest.manifestVersion,
                      },
                    )}
                  </span>
                </>
              ) : (
                <span>
                  {t(
                    "settings:projectIntegrations.agentExecution.notConfigured",
                  )}
                </span>
              )}
            </div>
            <Button
              className="w-full gap-2 sm:w-auto"
              disabled={
                !canEdit ||
                isSaving ||
                isManifestFetching ||
                !integrationIsReady ||
                repositoryMismatch ||
                !form.formState.isValid
              }
              type="submit"
            >
              {isSaving ? (
                <RefreshCw className="size-3.5 animate-spin" />
              ) : (
                <Save className="size-3.5" />
              )}
              {t("settings:projectIntegrations.agentExecution.saveButton")}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}

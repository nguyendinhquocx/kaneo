// SPEC-kaneo-phase-cards-full-run-server-v0-1 (T1): FULL-run graph publish.
// One transaction validates hash/ordinal/scope, creates the FULL task with
// execution_state=published, the phase child cards, the server-side mapping,
// the pending progress ledger, the subtask relations and the idempotency
// receipt. Any failure rolls back everything — no orphan rows, no duplicates.
// graphId is deterministic from canonical {projectId, changeSetId, planHash};
// receiptSha256 hashes the canonical receipt without the field itself.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import {
  columnTable,
  executionIdempotencyTable,
  executionPhaseCardTable,
  projectTable,
  taskRelationTable,
  taskTable,
} from "../database/schema";
import { insertPendingPhaseLedger } from "./phase-progress";
import { bumpTaskRevision } from "./revisions";
import {
  type CanonicalPhaseInput,
  canonicalSha256,
  computeGraphId,
  computeGraphMapHash,
  computeSourcePhaseMapHash,
  parseFullRunWorkerContract,
  SPEC_SHA256_RE,
  validatePhaseMapInput,
} from "./validation";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ReadExecutor = Pick<Tx, "select">;
type WriteExecutor = ReadExecutor & Pick<Tx, "update" | "insert">;

const GRAPH_PUBLISH_OPERATION = "execution.graph_publish";
const GRAPH_READY_OPERATION = "execution.graph_ready";
const MAX_TEXT_LENGTH = 300;

export type FullRunGraphPublishInput = {
  projectId: string;
  userId: string;
  requestKey: string;
  planHash: unknown;
  expectedProjectRevision: unknown;
  changeSetId: unknown;
  headerChangeSetId: string | undefined;
  specId: unknown;
  specSha256: unknown;
  sourcePhaseMapSha256: unknown;
  baseBranch: unknown;
  full: unknown;
  phases: unknown;
};

export type FullRunGraphReceipt = {
  schemaVersion: 1;
  graphId: string;
  projectId: string;
  projectRevision: number;
  fullTaskId: string;
  phaseCards: Array<{
    phaseId: string;
    parserTaskId: string;
    childTaskId: string;
    ordinal: number;
    required: boolean;
  }>;
  sourcePhaseMapSha256: string;
  graphMapSha256: string;
  specSha256: string;
  changeSetId: string;
  planHash: string;
  taskRevision: number;
  receiptSha256: string;
};

function fail(status: 400 | 404 | 409, message: string): HTTPException {
  return new HTTPException(status, { message });
}

function requireBoundedString(
  value: unknown,
  field: string,
  max = 200,
): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw fail(400, `${field} must be a bounded non-empty string`);
  }
  return value.trim();
}

function requireSha256(value: unknown, field: string): string {
  const text = requireBoundedString(value, field, 64);
  if (!SPEC_SHA256_RE.test(text)) {
    throw fail(400, `${field} must be a lowercase sha256 hex digest`);
  }
  return text;
}

function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw fail(400, `${field} must be a positive integer`);
  }
  return value;
}

/** receiptSha256 excludes the field itself before hashing. */
export function computeReceiptSha256(
  receipt: Omit<FullRunGraphReceipt, "receiptSha256">,
): string {
  return canonicalSha256(receipt);
}

type ValidatedGraphBody = {
  planHash: string;
  expectedProjectRevision: number;
  changeSetId: string;
  specId: string;
  specSha256: string;
  sourcePhaseMapSha256: string;
  baseBranch: string;
  fullTitle: string;
  fullDescription: string;
  phases: CanonicalPhaseInput[];
};

function validateGraphBody(
  input: FullRunGraphPublishInput,
): ValidatedGraphBody {
  const planHash = requireBoundedString(input.planHash, "planHash", 128);
  const changeSetId = requireBoundedString(input.changeSetId, "changeSetId");
  if (
    input.headerChangeSetId === undefined ||
    input.headerChangeSetId.trim() !== changeSetId
  ) {
    throw fail(400, "X-Kaneo-Change-Set header must equal body changeSetId");
  }
  const specId = requireBoundedString(input.specId, "specId", 200);
  const specSha256 = requireSha256(input.specSha256, "specSha256");
  const sourcePhaseMapSha256 = requireSha256(
    input.sourcePhaseMapSha256,
    "sourcePhaseMapSha256",
  );
  const baseBranch = requireBoundedString(input.baseBranch, "baseBranch");
  const expectedProjectRevision = requirePositiveInt(
    input.expectedProjectRevision,
    "expectedProjectRevision",
  );
  if (
    !input.full ||
    typeof input.full !== "object" ||
    Array.isArray(input.full)
  ) {
    throw fail(400, "full must be an object");
  }
  const full = input.full as Record<string, unknown>;
  const fullTitle = requireBoundedString(
    full.title,
    "full.title",
    MAX_TEXT_LENGTH,
  );
  if (typeof full.description !== "string" || !full.description.trim()) {
    throw fail(400, "full.description is required");
  }
  if (full.taskExecutionState !== "published") {
    throw fail(400, "full.taskExecutionState must be published at graph time");
  }
  const phases = validatePhaseMapInput(input.phases);
  const computedSourceHash = computeSourcePhaseMapHash(phases);
  if (computedSourceHash !== sourcePhaseMapSha256) {
    throw fail(
      409,
      "sourcePhaseMapSha256 does not match the canonical phase list",
    );
  }
  // The legacy worker contract JSON must start full.description and carry the
  // sorted union of all phase files as files/scope/writes.
  const sortedUnionFiles = [
    ...new Set(phases.flatMap((phase) => phase.files)),
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  parseFullRunWorkerContract(full.description, {
    specId,
    sortedUnionFiles,
  });
  return {
    planHash,
    expectedProjectRevision,
    changeSetId,
    specId,
    specSha256,
    sourcePhaseMapSha256,
    baseBranch,
    fullTitle,
    fullDescription: full.description,
    phases,
  };
}

async function resolveTodoColumnId(
  tx: ReadExecutor,
  projectId: string,
): Promise<string> {
  const [column] = await tx
    .select({ id: columnTable.id })
    .from(columnTable)
    .where(
      and(eq(columnTable.projectId, projectId), eq(columnTable.slug, "to-do")),
    )
    .limit(1);
  if (!column) {
    throw fail(409, "Project has no to-do column for graph publish");
  }
  return column.id;
}

async function allocateTaskNumber(
  tx: WriteExecutor,
  projectId: string,
): Promise<number> {
  const [updated] = await tx
    .update(projectTable)
    .set({
      lastTaskNumber: sql`${projectTable.lastTaskNumber} + 1`,
    })
    .where(eq(projectTable.id, projectId))
    .returning({ lastTaskNumber: projectTable.lastTaskNumber });
  if (!updated) throw fail(404, "Project not found");
  return updated.lastTaskNumber;
}

async function insertTaskRow(
  tx: WriteExecutor,
  input: {
    projectId: string;
    columnId: string;
    title: string;
    description: string;
    number: number;
  },
): Promise<typeof taskTable.$inferSelect> {
  const [task] = await tx
    .insert(taskTable)
    .values({
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      status: "to-do",
      columnId: input.columnId,
      number: input.number,
      position: input.number,
      executionState: "published",
      taskRevision: 1,
    })
    .returning();
  if (!task) throw new HTTPException(500, { message: "Task insert failed" });
  return task;
}

/**
 * POST /full-run-graphs: idempotent, transactional graph publish. Retry with
 * the same Idempotency-Key + payload returns the stored receipt; a different
 * payload under the same key (or same graphId) is a 409.
 */
export async function publishFullRunGraph(
  input: FullRunGraphPublishInput,
): Promise<FullRunGraphReceipt> {
  const requestKey = requireBoundedString(
    input.requestKey,
    "Idempotency-Key",
    200,
  );
  const body = validateGraphBody(input);
  const graphId = computeGraphId({
    projectId: input.projectId,
    changeSetId: body.changeSetId,
    planHash: body.planHash,
  });
  const payloadHash = canonicalSha256({
    projectId: input.projectId,
    userId: input.userId,
    planHash: body.planHash,
    changeSetId: body.changeSetId,
    specId: body.specId,
    specSha256: body.specSha256,
    sourcePhaseMapSha256: body.sourcePhaseMapSha256,
    baseBranch: body.baseBranch,
    fullTitle: body.fullTitle,
    phases: body.phases,
  });

  return db.transaction(async (tx) => {
    const reserve = await reserveGraphIdempotency(tx, {
      userId: input.userId,
      projectId: input.projectId,
      requestKey,
      payloadHash,
      graphId,
    });
    if (reserve.replay) return reserve.replay;

    // Serialize concurrent graph publishes per project on the project row.
    const [project] = await tx
      .select({
        id: projectTable.id,
        projectRevision: projectTable.projectRevision,
      })
      .from(projectTable)
      .where(eq(projectTable.id, input.projectId))
      .limit(1)
      .for("update");
    if (!project) throw fail(404, "Project not found");
    if (project.projectRevision !== body.expectedProjectRevision) {
      throw fail(
        409,
        `project_revision_drift: expected ${body.expectedProjectRevision}, current ${project.projectRevision}`,
      );
    }
    const todoColumnId = await resolveTodoColumnId(tx, input.projectId);

    // Duplicate guard: a previous graph for the same project may not be
    // re-published under a different request key while its FULL task is live.
    const existingGraph = await tx
      .select({ id: executionPhaseCardTable.id })
      .from(executionPhaseCardTable)
      .where(
        and(
          eq(executionPhaseCardTable.projectId, input.projectId),
          eq(executionPhaseCardTable.graphId, graphId),
        ),
      )
      .limit(1);
    if (existingGraph.length > 0 && !reserve.partial) {
      throw fail(409, "graph already published for this graphId");
    }

    const fullTask = await insertTaskRow(tx, {
      projectId: input.projectId,
      columnId: todoColumnId,
      title: body.fullTitle,
      description: body.fullDescription,
      number: await allocateTaskNumber(tx, input.projectId),
    });

    const childTasks: Array<{ phaseId: string; childTaskId: string }> = [];
    for (const phase of body.phases) {
      const child = await insertTaskRow(tx, {
        projectId: input.projectId,
        columnId: todoColumnId,
        title: phase.title,
        description: phase.description ?? "",
        number: await allocateTaskNumber(tx, input.projectId),
      });
      childTasks.push({ phaseId: phase.phaseId, childTaskId: child.id });
    }

    const phasesWithChildren = body.phases.map((phase) => {
      const childTaskId = childTasks.find(
        (row) => row.phaseId === phase.phaseId,
      )?.childTaskId;
      if (!childTaskId) {
        throw new HTTPException(500, {
          message: "Phase child task was not created",
        });
      }
      return { ...phase, childTaskId };
    });
    const graphMapSha256 = computeGraphMapHash(fullTask.id, phasesWithChildren);

    await tx.insert(executionPhaseCardTable).values(
      phasesWithChildren.map((phase) => ({
        projectId: input.projectId,
        fullTaskId: fullTask.id,
        childTaskId: phase.childTaskId,
        phaseId: phase.phaseId,
        parserTaskId: phase.parserTaskId,
        ordinal: phase.ordinal,
        required: phase.required,
        graphId,
        specSha256: body.specSha256,
        sourcePhaseMapSha256: body.sourcePhaseMapSha256,
        graphMapSha256,
        planHash: body.planHash,
        changeSetId: body.changeSetId,
      })),
    );

    // relation subtask: FULL task is the parent source, child the target.
    await tx.insert(taskRelationTable).values(
      phasesWithChildren.map((phase) => ({
        sourceTaskId: fullTask.id,
        targetTaskId: phase.childTaskId,
        relationType: "subtask",
      })),
    );

    await insertPendingPhaseLedger(tx, {
      fullTaskId: fullTask.id,
      phases: phasesWithChildren,
    });

    // Bump the server-owned project revision exactly once in this
    // transaction (CAS'ed against expectedProjectRevision above).
    await tx
      .update(projectTable)
      .set({
        projectRevision: sql`${projectTable.projectRevision} + 1`,
      })
      .where(eq(projectTable.id, input.projectId));

    const receiptWithoutHash: Omit<FullRunGraphReceipt, "receiptSha256"> = {
      schemaVersion: 1,
      graphId,
      projectId: input.projectId,
      projectRevision: project.projectRevision + 1,
      fullTaskId: fullTask.id,
      phaseCards: phasesWithChildren.map((phase) => ({
        phaseId: phase.phaseId,
        parserTaskId: phase.parserTaskId,
        childTaskId: phase.childTaskId,
        ordinal: phase.ordinal,
        required: phase.required,
      })),
      sourcePhaseMapSha256: body.sourcePhaseMapSha256,
      graphMapSha256,
      specSha256: body.specSha256,
      changeSetId: body.changeSetId,
      planHash: body.planHash,
      taskRevision: fullTask.taskRevision,
    };
    const receipt: FullRunGraphReceipt = {
      ...receiptWithoutHash,
      receiptSha256: computeReceiptSha256(receiptWithoutHash),
    };

    await saveGraphIdempotency(tx, {
      userId: input.userId,
      requestKey,
      graphId,
      receipt,
    });
    return receipt;
  });
}

async function reserveGraphIdempotency(
  tx: WriteExecutor,
  input: {
    userId: string;
    projectId: string;
    requestKey: string;
    payloadHash: string;
    graphId: string;
  },
): Promise<{ replay: FullRunGraphReceipt | null; partial: boolean }> {
  const [reserved] = await tx
    .insert(executionIdempotencyTable)
    .values({
      userId: input.userId,
      operation: GRAPH_PUBLISH_OPERATION,
      requestKey: input.requestKey,
      requestHash: input.payloadHash,
      response: {},
    })
    .onConflictDoNothing({
      target: [
        executionIdempotencyTable.operation,
        executionIdempotencyTable.requestKey,
      ],
    })
    .returning({ id: executionIdempotencyTable.id });
  if (!reserved) {
    const [record] = await tx
      .select()
      .from(executionIdempotencyTable)
      .where(
        and(
          eq(executionIdempotencyTable.operation, GRAPH_PUBLISH_OPERATION),
          eq(executionIdempotencyTable.requestKey, input.requestKey),
        ),
      )
      .limit(1);
    if (!record) {
      throw fail(409, "Idempotency-Key reservation was not available");
    }
    if (
      record.userId !== input.userId ||
      record.requestHash !== input.payloadHash
    ) {
      throw fail(
        409,
        "Idempotency-Key was already used with a different request",
      );
    }
    const stored = record.response as FullRunGraphReceipt;
    if (stored && Object.keys(stored).length > 0)
      return { replay: stored, partial: false };
    // Empty response: previous transaction never committed — re-execute.
    return { replay: null, partial: true };
  }
  // Bind the deterministic graphId lookup row in the same transaction.
  await tx
    .insert(executionIdempotencyTable)
    .values({
      userId: input.userId,
      operation: GRAPH_PUBLISH_OPERATION,
      requestKey: `graph:${input.graphId}`,
      requestHash: input.payloadHash,
      response: {},
    })
    .onConflictDoNothing({
      target: [
        executionIdempotencyTable.operation,
        executionIdempotencyTable.requestKey,
      ],
    });
  return { replay: null, partial: false };
}

async function saveGraphIdempotency(
  tx: WriteExecutor,
  input: {
    userId: string;
    requestKey: string;
    graphId: string;
    receipt: FullRunGraphReceipt;
  },
): Promise<void> {
  await tx
    .update(executionIdempotencyTable)
    .set({ response: input.receipt })
    .where(
      and(
        eq(executionIdempotencyTable.userId, input.userId),
        eq(executionIdempotencyTable.operation, GRAPH_PUBLISH_OPERATION),
        inArray(executionIdempotencyTable.requestKey, [
          input.requestKey,
          `graph:${input.graphId}`,
        ]),
      ),
    );
}

async function loadGraphReceipt(
  executor: ReadExecutor,
  input: { userId: string; idempotencyKey: string },
): Promise<FullRunGraphReceipt> {
  const [record] = await executor
    .select()
    .from(executionIdempotencyTable)
    .where(
      and(
        eq(executionIdempotencyTable.operation, GRAPH_PUBLISH_OPERATION),
        eq(executionIdempotencyTable.requestKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (!record || record.userId !== input.userId) {
    throw fail(404, "Graph receipt not found");
  }
  const receipt = record.response as FullRunGraphReceipt;
  if (!receipt || Object.keys(receipt).length === 0) {
    throw fail(404, "Graph receipt not found");
  }
  return receipt;
}

/** GET /full-run-graphs/:graphId — bounded receipt for reconcile. */
export async function getFullRunGraphByGraphId(input: {
  projectId: string;
  graphId: string;
  userId: string;
}): Promise<FullRunGraphReceipt> {
  const receipt = await loadGraphReceipt(db, {
    userId: input.userId,
    idempotencyKey: `graph:${input.graphId}`,
  });
  if (receipt.projectId !== input.projectId) {
    throw fail(404, "Graph receipt not found");
  }
  return receipt;
}

/** GET /full-run-graphs/by-request?requestKey=… — bounded receipt for reconcile. */
export async function getFullRunGraphByRequestKey(input: {
  projectId: string;
  requestKey: string;
  userId: string;
}): Promise<FullRunGraphReceipt> {
  const receipt = await loadGraphReceipt(db, {
    userId: input.userId,
    idempotencyKey: input.requestKey,
  });
  if (receipt.projectId !== input.projectId) {
    throw fail(404, "Graph receipt not found");
  }
  return receipt;
}

export type FullRunGraphReadyInput = {
  projectId: string;
  graphId: string;
  userId: string;
  requestKey: string;
  planHash: unknown;
  expectedProjectRevision: unknown;
  expectedTaskRevision: unknown;
};

export type FullRunGraphReadyReceipt = {
  schemaVersion: 1;
  graphId: string;
  projectId: string;
  fullTaskId: string;
  executionState: "ready";
  projectRevision: number;
  taskRevision: number;
};

/**
 * POST /full-run-graphs/:graphId/ready: parent-only CAS published → ready.
 * Drift on planHash, project revision or task revision is a 409; retry with
 * the same Idempotency-Key returns the stored receipt.
 */
export async function readyFullRunGraph(
  input: FullRunGraphReadyInput,
): Promise<FullRunGraphReadyReceipt> {
  const requestKey = requireBoundedString(
    input.requestKey,
    "Idempotency-Key",
    200,
  );
  const planHash = requireBoundedString(input.planHash, "planHash", 128);
  const expectedProjectRevision = requirePositiveInt(
    input.expectedProjectRevision,
    "expectedProjectRevision",
  );
  const expectedTaskRevision = requirePositiveInt(
    input.expectedTaskRevision,
    "expectedTaskRevision",
  );
  const requestHash = canonicalSha256({
    projectId: input.projectId,
    graphId: input.graphId,
    planHash,
    expectedProjectRevision,
    expectedTaskRevision,
    userId: input.userId,
  });

  return db.transaction(async (tx) => {
    const [reserved] = await tx
      .insert(executionIdempotencyTable)
      .values({
        userId: input.userId,
        operation: GRAPH_READY_OPERATION,
        requestKey,
        requestHash,
        response: {},
      })
      .onConflictDoNothing({
        target: [
          executionIdempotencyTable.operation,
          executionIdempotencyTable.requestKey,
        ],
      })
      .returning({ id: executionIdempotencyTable.id });
    if (!reserved) {
      const [record] = await tx
        .select()
        .from(executionIdempotencyTable)
        .where(
          and(
            eq(executionIdempotencyTable.operation, GRAPH_READY_OPERATION),
            eq(executionIdempotencyTable.requestKey, requestKey),
          ),
        )
        .limit(1);
      if (!record)
        throw fail(409, "Idempotency-Key reservation was not available");
      if (
        record.userId !== input.userId ||
        record.requestHash !== requestHash
      ) {
        throw fail(
          409,
          "Idempotency-Key was already used with a different request",
        );
      }
      const stored = record.response as FullRunGraphReadyReceipt;
      if (stored && Object.keys(stored).length > 0) return stored;
      // Empty stored response → re-execute below.
    }

    const [project] = await tx
      .select({
        id: projectTable.id,
        projectRevision: projectTable.projectRevision,
      })
      .from(projectTable)
      .where(eq(projectTable.id, input.projectId))
      .limit(1)
      .for("update");
    if (!project) throw fail(404, "Project not found");
    if (project.projectRevision !== expectedProjectRevision) {
      throw fail(
        409,
        `project_revision_drift: expected ${expectedProjectRevision}, current ${project.projectRevision}`,
      );
    }
    const cards = await tx
      .select({
        fullTaskId: executionPhaseCardTable.fullTaskId,
        planHash: executionPhaseCardTable.planHash,
      })
      .from(executionPhaseCardTable)
      .where(
        and(
          eq(executionPhaseCardTable.projectId, input.projectId),
          eq(executionPhaseCardTable.graphId, input.graphId),
        ),
      )
      .orderBy(asc(executionPhaseCardTable.ordinal))
      .for("update");
    const firstCard = cards[0];
    if (!firstCard) {
      throw fail(404, "Graph not found for project");
    }
    if (cards.some((card) => card.planHash !== planHash)) {
      throw fail(409, "plan_hash_drift: graph planHash mismatch");
    }
    const fullTaskId = firstCard.fullTaskId;
    const [fullTask] = await tx
      .select({
        id: taskTable.id,
        taskRevision: taskTable.taskRevision,
        executionState: taskTable.executionState,
      })
      .from(taskTable)
      .where(eq(taskTable.id, fullTaskId))
      .limit(1)
      .for("update");
    if (!fullTask) throw fail(404, "FULL task not found");
    if (fullTask.taskRevision !== expectedTaskRevision) {
      throw fail(
        409,
        `task_revision_drift: expected ${expectedTaskRevision}, current ${fullTask.taskRevision}`,
      );
    }
    if (fullTask.executionState !== "published") {
      throw fail(
        409,
        `execution_state_drift: FULL task is ${fullTask.executionState}, expected published`,
      );
    }
    await bumpTaskRevision(tx, {
      taskId: fullTaskId,
      expected: expectedTaskRevision,
    });
    await tx
      .update(taskTable)
      .set({ executionState: "ready", updatedAt: new Date() })
      .where(eq(taskTable.id, fullTaskId));
    const nextProjectRevision = project.projectRevision + 1;
    await tx
      .update(projectTable)
      .set({
        projectRevision: sql`${projectTable.projectRevision} + 1`,
      })
      .where(eq(projectTable.id, input.projectId));

    const receipt: FullRunGraphReadyReceipt = {
      schemaVersion: 1,
      graphId: input.graphId,
      projectId: input.projectId,
      fullTaskId,
      executionState: "ready",
      projectRevision: nextProjectRevision,
      taskRevision: expectedTaskRevision + 1,
    };
    await tx
      .update(executionIdempotencyTable)
      .set({ response: receipt })
      .where(
        and(
          eq(executionIdempotencyTable.userId, input.userId),
          eq(executionIdempotencyTable.operation, GRAPH_READY_OPERATION),
          eq(executionIdempotencyTable.requestKey, requestKey),
          eq(executionIdempotencyTable.requestHash, requestHash),
        ),
      );
    return receipt;
  });
}

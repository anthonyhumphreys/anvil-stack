import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AgentApprovalDecision,
  AgentApprovalProvider,
  AgentApprovalRequest,
} from "@anvil-cloud/runtime";

export type LocalApprovalStatus = "pending" | "approved" | "rejected";

export type LocalApprovalAuditEvent = {
  type:
    | "approval.requested"
    | "approval.approved"
    | "approval.rejected"
    | "approval.webhook.delivered"
    | "approval.webhook.failed";
  approvalId: string;
  at: string;
  actor?: string;
  reason?: string;
  details?: Record<string, unknown>;
};

export type LocalApprovalRecord = {
  id: string;
  status: LocalApprovalStatus;
  action: string;
  reason?: string;
  metadata: Record<string, unknown>;
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionReason?: string;
  audit: LocalApprovalAuditEvent[];
};

type LocalApprovalsState = {
  approvals: LocalApprovalRecord[];
};

export type LocalApprovalStoreOptions = {
  filePath: string;
  webhookUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  idFactory?: () => string;
};

export class LocalApprovalStore implements AgentApprovalProvider {
  private readonly filePath: string;
  private readonly webhookUrl: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(options: LocalApprovalStoreOptions) {
    this.filePath = options.filePath;
    this.webhookUrl = options.webhookUrl;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => `appr_${randomUUID()}`);
  }

  async requestApproval(
    request: AgentApprovalRequest,
  ): Promise<AgentApprovalDecision> {
    const approval = this.createRecord(request);

    await this.update((state) => ({
      approvals: [...state.approvals, approval],
    }));
    await this.deliverWebhook(approval);

    return { status: "pending", approvalId: approval.id };
  }

  async list(
    options: {
      status?: LocalApprovalStatus;
    } = {},
  ): Promise<LocalApprovalRecord[]> {
    const state = await this.read();

    return state.approvals.filter(
      (approval) =>
        options.status === undefined || approval.status === options.status,
    );
  }

  async get(id: string): Promise<LocalApprovalRecord | null> {
    const state = await this.read();

    return state.approvals.find((approval) => approval.id === id) ?? null;
  }

  async approve(
    id: string,
    options: { approvedBy?: string; reason?: string } = {},
  ): Promise<LocalApprovalRecord | null> {
    return this.decide(id, "approved", options.approvedBy, options.reason);
  }

  async reject(
    id: string,
    options: { rejectedBy?: string; reason?: string } = {},
  ): Promise<LocalApprovalRecord | null> {
    return this.decide(id, "rejected", options.rejectedBy, options.reason);
  }

  async audit(): Promise<LocalApprovalAuditEvent[]> {
    const state = await this.read();

    return state.approvals.flatMap((approval) => approval.audit);
  }

  private createRecord(request: AgentApprovalRequest): LocalApprovalRecord {
    const id = this.idFactory();
    const at = this.now().toISOString();
    const event: LocalApprovalAuditEvent = {
      type: "approval.requested",
      approvalId: id,
      at,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      details: {
        action: request.action,
        metadata: request.metadata ?? {},
      },
    };

    return {
      id,
      status: "pending",
      action: request.action,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      metadata: request.metadata ?? {},
      requestedAt: at,
      audit: [event],
    };
  }

  private async decide(
    id: string,
    status: Exclude<LocalApprovalStatus, "pending">,
    actor: string | undefined,
    reason: string | undefined,
  ): Promise<LocalApprovalRecord | null> {
    let decided: LocalApprovalRecord | null = null;

    await this.update((state) => ({
      approvals: state.approvals.map((approval) => {
        if (approval.id !== id) {
          return approval;
        }

        const at = this.now().toISOString();
        decided = {
          ...approval,
          status,
          decidedAt: at,
          ...(actor === undefined ? {} : { decidedBy: actor }),
          ...(reason === undefined ? {} : { decisionReason: reason }),
          audit: [
            ...approval.audit,
            {
              type:
                status === "approved"
                  ? "approval.approved"
                  : "approval.rejected",
              approvalId: id,
              at,
              ...(actor === undefined ? {} : { actor }),
              ...(reason === undefined ? {} : { reason }),
            },
          ],
        };

        return decided;
      }),
    }));

    return decided;
  }

  private async deliverWebhook(approval: LocalApprovalRecord): Promise<void> {
    if (!this.webhookUrl) {
      return;
    }

    try {
      const response = await this.fetchImpl(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "approval.requested",
          approval,
        }),
      });

      await this.appendAudit(approval.id, {
        type: response.ok
          ? "approval.webhook.delivered"
          : "approval.webhook.failed",
        approvalId: approval.id,
        at: this.now().toISOString(),
        details: {
          url: this.webhookUrl,
          status: response.status,
        },
      });
    } catch (error) {
      await this.appendAudit(approval.id, {
        type: "approval.webhook.failed",
        approvalId: approval.id,
        at: this.now().toISOString(),
        details: {
          url: this.webhookUrl,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async appendAudit(
    approvalId: string,
    event: LocalApprovalAuditEvent,
  ): Promise<void> {
    await this.update((state) => ({
      approvals: state.approvals.map((approval) =>
        approval.id === approvalId
          ? { ...approval, audit: [...approval.audit, event] }
          : approval,
      ),
    }));
  }

  private async read(): Promise<LocalApprovalsState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;

      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "approvals" in parsed &&
        Array.isArray(parsed.approvals)
      ) {
        return { approvals: parsed.approvals as LocalApprovalRecord[] };
      }
    } catch {
      // Missing or malformed local state starts empty. The next write repairs it.
    }

    return { approvals: [] };
  }

  private async write(state: LocalApprovalsState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;

    await writeFile(
      `${tempPath}`,
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );
    await rename(tempPath, this.filePath);
  }

  private async update(
    updater: (state: LocalApprovalsState) => LocalApprovalsState,
  ): Promise<void> {
    await this.write(updater(await this.read()));
  }
}

export function isLocalApprovalStatus(
  value: unknown,
): value is LocalApprovalStatus {
  return value === "pending" || value === "approved" || value === "rejected";
}

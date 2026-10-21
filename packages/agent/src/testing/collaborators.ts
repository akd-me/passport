import type {
  ActionCategory,
  ActionExecutor,
  ActionParams,
  ActionRecord,
  ActionRequest,
  ActionType,
  DomainEvent,
  EventBus,
  GlobalPolicyConfig,
  PolicyDecision,
  PolicyEngine,
  PolicyOutcome,
  TrustState,
} from "@passport/types";
import { BASE_REVERSIBILITY, BASE_RISK, DEFAULT_POLICY_CONFIG } from "@passport/types";
import { AgentError } from "../errors.js";
import { newAgentId } from "../id.js";
import { getAgentEmailPatch } from "../integration.js";
import { emailFixture, TEST_NOW, trustFixture } from "./fixtures.js";
import type { MemoryStore } from "./memory-store.js";

export class MemoryBus implements EventBus {
  readonly events: DomainEvent[] = [];
  private handlers = new Set<(event: DomainEvent) => void>();
  emit(event: DomainEvent): void {
    this.events.push(structuredClone(event));
    for (const handler of this.handlers) {
      handler(event);
    }
  }
  on<T extends DomainEvent["type"]>(
    type: T,
    handler: (event: Extract<DomainEvent, { type: T }>) => void,
  ): () => void {
    return this.onAny((event) => {
      if (event.type === type) {
        handler(event as Extract<DomainEvent, { type: T }>);
      }
    });
  }
  onAny(handler: (event: DomainEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

export class FakePolicy implements PolicyEngine {
  states: TrustState[] = [];
  readonly evaluated: ActionRequest[] = [];
  outcome?: PolicyOutcome;
  config: GlobalPolicyConfig = structuredClone(DEFAULT_POLICY_CONFIG);
  async evaluate(request: ActionRequest): Promise<PolicyDecision> {
    this.evaluated.push(structuredClone(request));
    const outcome =
      this.outcome ??
      (request.type === "send" || request.type === "calendar_propose"
        ? "hold"
        : request.type === "calendar_respond"
          ? "ask"
          : "allow");
    return {
      outcome,
      risk: BASE_RISK[request.type],
      reversibility: BASE_REVERSIBILITY[request.type],
      trustLevel: "auto_accept_edits",
      category: request.category,
      reason: `Fake policy: ${outcome}`,
      ...(outcome === "hold" ? { holdUntil: "2026-10-20T14:05:00.000Z" } : {}),
    };
  }
  async recordOutcome(_id: string, _feedback: unknown): Promise<TrustState> {
    return this.getTrustFor("other");
  }
  async getTrust(): Promise<TrustState[]> {
    return structuredClone(this.states);
  }
  async getTrustFor(category: ActionCategory): Promise<TrustState> {
    return structuredClone(
      this.states.find((state) => state.category === category) ?? trustFixture({ category }),
    );
  }
  async pinLevel(category: ActionCategory, level: TrustState["pinnedLevel"]): Promise<TrustState> {
    const state = await this.getTrustFor(category);
    state.pinnedLevel = level;
    this.states = [...this.states.filter((item) => item.category !== category), state];
    return state;
  }
  async getConfig(): Promise<GlobalPolicyConfig> {
    return structuredClone(this.config);
  }
  async setConfig(patch: Partial<GlobalPolicyConfig>): Promise<GlobalPolicyConfig> {
    Object.assign(this.config, patch);
    return this.getConfig();
  }
  async applyDecay(): Promise<TrustState[]> {
    return this.getTrust();
  }
}

function params<T extends ActionType>(request: ActionRequest, type: T): ActionParams[T] {
  if (request.type !== type) {
    throw new AgentError("Fake action type mismatch", "FAKE_ACTION");
  }
  return request.params as ActionParams[T];
}

/** Executes local effects only. Undo/approval/provider delivery are deliberately outside this fake. */
export class FakeExecutor implements ActionExecutor {
  readonly requests: ActionRequest[] = [];
  readonly records: ActionRecord[] = [];
  releaseCalls = 0;
  constructor(
    readonly store: MemoryStore,
    readonly policy: FakePolicy,
    readonly now = () => TEST_NOW,
  ) {}

  async submit(request: ActionRequest): Promise<ActionRecord> {
    this.requests.push(structuredClone(request));
    const decision = await this.policy.evaluate(request);
    function actionStatus() {
      if (decision.outcome === "allow") {
        return "executed";
      }
      if (decision.outcome === "hold") {
        return "held";
      }
      if (decision.outcome === "ask") {
        return "proposed";
      }
      return "rejected";
    }
    const record: ActionRecord = {
      id: newAgentId(),
      request,
      decision,
      status: actionStatus(),
      createdAt: this.now(),
      holdUntil: decision.holdUntil,
    };
    if (record.status === "executed") {
      record.result = await this.apply(request);
      record.executedAt = this.now();
    }
    this.records.push(record);
    return this.store.actions.insert(record);
  }

  private async apply(request: ActionRequest): Promise<Record<string, unknown>> {
    switch (request.type) {
      case "person_update": {
        const { personId, patch } = params(request, "person_update");
        const old = await this.store.people.get(personId);
        if (
          !old &&
          (!patch.id ||
            !patch.stats ||
            !patch.emails ||
            !patch.relationship ||
            !patch.primaryEmail ||
            !patch.createdAt ||
            !patch.verification ||
            !patch.updatedAt ||
            !patch.displayName)
        ) {
          throw new AgentError("New fake person requires a complete patch", "FAKE_PERSON");
        }
        await this.store.people.upsert({
          ...old,
          ...patch,
          id: personId,
        } as import("@passport/types").Person);
        return { personId };
      }
      case "matter_create": {
        const { matter } = params(request, "matter_create");
        const id = newAgentId();
        await this.store.matters.upsert({
          ...matter,
          id,
          createdAt: this.now(),
          updatedAt: this.now(),
        });
        await this.store.emails.patchMany(matter.emailIds, {
          matterId: id,
          ...getAgentEmailPatch(request),
        });
        return { matterId: id };
      }
      case "matter_attach": {
        const input = params(request, "matter_attach");
        const matter = await this.store.matters.get(input.matterId);
        if (!matter) {
          throw new AgentError("Missing fake matter", "FAKE_MATTER");
        }
        await this.store.matters.upsert({
          ...matter,
          emailIds: [...new Set([...matter.emailIds, ...(input.emailIds ?? [])])],
          personIds: [...new Set([...matter.personIds, ...(input.personIds ?? [])])],
          eventIds: [...new Set([...matter.eventIds, ...(input.eventIds ?? [])])],
          updatedAt: this.now(),
        });
        await this.store.emails.patchMany(input.emailIds ?? [], {
          matterId: matter.id,
          ...getAgentEmailPatch(request),
        });
        return { matterId: matter.id };
      }
      case "matter_update": {
        const { matterId, patch } = params(request, "matter_update");
        const matter = await this.store.matters.get(matterId);
        if (!matter) {
          throw new AgentError("Missing fake matter", "FAKE_MATTER");
        }
        await this.store.matters.upsert({
          ...matter,
          ...patch,
          id: matterId,
          updatedAt: this.now(),
        });
        return { matterId };
      }
      case "draft_create": {
        const { draft } = params(request, "draft_create");
        const id = newAgentId();
        await this.store.emails.upsertMany([
          emailFixture({
            id,
            accountId: draft.accountId,
            providerId: id,
            threadId: draft.inReplyToEmailId
              ? ((await this.store.emails.get(draft.inReplyToEmailId))?.threadId ?? id)
              : id,
            from: [{ email: "me@example.com" }],
            to: draft.to,
            cc: draft.cc ?? [],
            bcc: draft.bcc ?? [],
            subject: draft.subject,
            textBody: draft.textBody,
            keywords: { $draft: true },
            mailboxIds: ["drafts"],
          }),
        ]);
        return { draftEmailId: id };
      }
      case "archive":
      case "label":
      case "mark_read": {
        const input = request.params as { emailIds: string[]; label?: string };
        for (const id of input.emailIds) {
          const email = await this.store.emails.get(id);
          if (!email) {
            throw new AgentError("Missing fake email", "FAKE_EMAIL");
          }
          if (request.type === "archive") {
            await this.store.emails.patchMany([id], {
              mailboxIds: email.mailboxIds.filter((mailbox) => mailbox !== "inbox"),
            });
          } else {
            await this.store.emails.patchMany([id], {
              keywords: {
                ...email.keywords,
                [request.type === "label" ? `label:${input.label}` : "$seen"]: true,
              },
            });
          }
        }
        return {};
      }
      case "profile_update": {
        await this.store.kv.set("user_profile", params(request, "profile_update").markdown);
        return {};
      }
      case "calendar_respond":
        return {};
      default:
        throw new AgentError(`Fake executor does not execute ${request.type}`, "FAKE_UNSUPPORTED");
    }
  }

  async approve(): Promise<ActionRecord> {
    throw new AgentError("Approval is not modeled by this test fake", "FAKE_UNSUPPORTED");
  }
  async reject(): Promise<ActionRecord> {
    throw new AgentError("Rejection is not modeled by this test fake", "FAKE_UNSUPPORTED");
  }
  async cancelHold(): Promise<ActionRecord> {
    throw new AgentError(
      "Outbox cancellation is not modeled by this test fake",
      "FAKE_UNSUPPORTED",
    );
  }
  async undo(): Promise<ActionRecord> {
    throw new AgentError("Undo is not modeled by this test fake", "FAKE_UNSUPPORTED");
  }
  async releaseDue(): Promise<ActionRecord[]> {
    this.releaseCalls++;
    return [];
  }
}

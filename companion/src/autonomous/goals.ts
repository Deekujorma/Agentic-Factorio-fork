import crypto from "node:crypto";
import type { AutonomousMemory, Goal, GoalStatus, Verification } from "./memory.js";

const ALLOWED: Record<GoalStatus, readonly GoalStatus[]> = {
  pending: ["ready", "blocked", "failed", "cancelled"], ready: ["active", "blocked", "failed", "cancelled"],
  active: ["ready", "verifying", "blocked", "failed", "cancelled"], verifying: ["done", "ready", "blocked", "failed", "cancelled"],
  blocked: ["ready", "failed", "cancelled"], failed: ["ready", "cancelled"], done: [], cancelled: [],
};

export class GoalGraph {
  constructor(private readonly memory: AutonomousMemory) {}

  create(input: { id?: string; parentId?: string; title: string; description?: string; priority?: number; dependencies?: string[]; verification?: Verification[]; maxAttempts?: number; job?: Goal["job"] }): Goal {
    const id = input.id ?? `goal-${crypto.randomUUID()}`;
    const existing = this.memory.goals.find((goal) => goal.id === id);
    if (existing) return existing;
    if (input.parentId) this.require(input.parentId);
    for (const dependency of input.dependencies ?? []) this.require(dependency);
    const now = new Date().toISOString();
    const goal: Goal = {
      id, parentId: input.parentId, title: input.title, description: input.description ?? input.title,
      status: "pending", priority: input.priority ?? 0, dependencies: [...new Set(input.dependencies ?? [])],
      createdAt: now, updatedAt: now, attempts: 0, maxAttempts: input.maxAttempts ?? 3,
      blockers: [], verification: input.verification ?? [], evidence: [],
      job: input.job,
    };
    this.memory.goals.push(goal);
    this.refreshReady();
    return goal;
  }

  update(id: string, patch: Partial<Pick<Goal, "title" | "description" | "priority" | "blockers" | "result" | "nextReviewAt" | "verification">>): Goal {
    const goal = this.require(id);
    Object.assign(goal, patch, { updatedAt: new Date().toISOString() });
    this.refreshReady();
    return goal;
  }

  addDependency(id: string, dependencyId: string): Goal {
    const goal = this.require(id); this.require(dependencyId);
    if (id === dependencyId || this.dependsOn(dependencyId, id)) throw new Error("goal dependency would create a cycle");
    if (!goal.dependencies.includes(dependencyId)) goal.dependencies.push(dependencyId);
    goal.updatedAt = new Date().toISOString(); this.refreshReady(); return goal;
  }

  transition(id: string, status: GoalStatus, evidence?: string): Goal {
    const goal = this.require(id);
    if (goal.status !== status && !ALLOWED[goal.status].includes(status)) throw new Error(`invalid goal transition ${goal.status} -> ${status}`);
    goal.status = status; goal.updatedAt = new Date().toISOString();
    if (status === "active") goal.attempts++;
    if (evidence && !goal.evidence.includes(evidence)) goal.evidence.push(evidence);
    this.refreshReady(); return goal;
  }

  ready(): Goal[] { this.refreshReady(); return this.memory.goals.filter((goal) => goal.status === "ready").sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt)); }
  active(): Goal[] { return this.memory.goals.filter((goal) => goal.status === "active" || goal.status === "verifying"); }
  get(id: string): Goal | undefined { return this.memory.goals.find((goal) => goal.id === id); }

  refreshReady(): void {
    for (const goal of this.memory.goals) {
      if (!(["pending", "blocked", "failed"] as GoalStatus[]).includes(goal.status)) continue;
      if (goal.status === "failed" && goal.attempts >= goal.maxAttempts) continue;
      const dependenciesDone = goal.dependencies.every((id) => this.get(id)?.status === "done");
      if (dependenciesDone && goal.blockers.length === 0) { goal.status = "ready"; goal.updatedAt = new Date().toISOString(); }
    }
  }

  cancelOpen(reason: string): void {
    for (const goal of this.memory.goals) if (!["done", "cancelled"].includes(goal.status)) { goal.status = "cancelled"; goal.result = reason; goal.updatedAt = new Date().toISOString(); }
  }

  private require(id: string): Goal { const goal = this.get(id); if (!goal) throw new Error(`unknown goal ${id}`); return goal; }
  private dependsOn(from: string, target: string, seen = new Set<string>()): boolean {
    if (from === target) return true; if (seen.has(from)) return false; seen.add(from);
    return this.require(from).dependencies.some((dependency) => this.dependsOn(dependency, target, seen));
  }
}

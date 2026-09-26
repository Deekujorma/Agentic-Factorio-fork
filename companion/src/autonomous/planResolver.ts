import crypto from "node:crypto";
import type { AutonomousMemory, Goal } from "./memory.js";

export interface PlanGoalLike { title: string; parentTitle?: string; dependsOnTitles?: string[] }
export interface SemanticPlanLike { strategicGoals: PlanGoalLike[]; goals: PlanGoalLike[] }
export interface ResolvedPlan {
  strategic: Array<{ input: PlanGoalLike; id: string; parentId: string; existing?: Goal }>;
  tactical: Array<{ input: PlanGoalLike; id: string; parentId: string; existing?: Goal; dependencyIds: string[] }>;
}

export function normalizeGoalReference(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s.!?;:,]+$/g, "").replace(/\s+/g, " ");
}

/** Resolve the whole proposed tree without mutating persistent state. */
export function resolveCoordinatorPlan(memory: AutonomousMemory, plan: SemanticPlanLike): ResolvedPlan {
  const root = memory.rootGoalId ? memory.goals.find((goal) => goal.id === memory.rootGoalId) : undefined;
  if (!root) throw new Error("campaign has no persistent root goal");
  const aliases = new Set(["root", "campaign", root.id, root.title, memory.objective ?? ""].map(normalizeGoalReference).filter(Boolean));
  const existing = new Map<string, Goal[]>();
  const addExisting = (goal: Goal) => { const key = normalizeGoalReference(goal.title); existing.set(key, [...(existing.get(key) ?? []), goal]); };
  memory.goals.filter((goal) => goal.kind === "strategic" && !["failed", "cancelled"].includes(goal.status)).forEach(addExisting);

  const proposed = new Map<string, Array<{ input: PlanGoalLike; id: string }>>();
  for (const input of plan.strategicGoals) {
    const key = normalizeGoalReference(input.title); const matches = existing.get(key) ?? [];
    const id = matches.length === 1 ? matches[0]!.id : `goal-${crypto.randomUUID()}`;
    proposed.set(key, [...(proposed.get(key) ?? []), { input, id }]);
  }
  for (const [title, matches] of proposed) if (matches.length > 1) throw new Error(`ambiguous strategic goal title ${title}`);
  for (const [title, matches] of existing) if (matches.length > 1 && proposed.has(title)) throw new Error(`ambiguous existing strategic goal title ${title}`);

  const resolveParent = (child: PlanGoalLike, allowProposed: boolean): string => {
    if (!child.parentTitle || aliases.has(normalizeGoalReference(child.parentTitle))) return root.id;
    const key = normalizeGoalReference(child.parentTitle);
    if (key === normalizeGoalReference(child.title)) throw new Error(`goal ${child.title} cannot parent itself`);
    const candidates = [ ...(existing.get(key) ?? []), ...(allowProposed ? (proposed.get(key) ?? []).map((value) => ({ id: value.id } as Goal)) : []) ];
    const ids = [...new Set(candidates.map((value) => value.id))];
    if (ids.length === 0) throw new Error(`goal ${child.title} has unknown parent ${child.parentTitle}`);
    if (ids.length > 1) throw new Error(`goal ${child.title} has ambiguous parent ${child.parentTitle}`);
    return ids[0]!;
  };

  const strategic = plan.strategicGoals.map((input) => {
    const item = proposed.get(normalizeGoalReference(input.title))![0]!;
    const found = memory.goals.find((goal) => goal.id === item.id);
    const parentId = resolveParent(input, true);
    if (found && found.parentId !== parentId) throw new Error(`existing strategic goal ${input.title} belongs to a different parent`);
    return { input, id: item.id, parentId, existing: found };
  });
  const byId = new Map(strategic.map((value) => [value.id, value]));
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("strategic goal hierarchy contains a cycle");
    if (visited.has(id)) return; visiting.add(id);
    const parent = byId.get(byId.get(id)?.parentId ?? ""); if (parent) visit(parent.id);
    visiting.delete(id); visited.add(id);
  };
  strategic.forEach((value) => visit(value.id));
  strategic.sort((a, b) => { visit(a.id); visit(b.id); return depth(a.id) - depth(b.id); });
  function depth(id: string, seen = new Set<string>()): number { if (seen.has(id)) throw new Error("strategic goal hierarchy contains a cycle"); seen.add(id); const parent = byId.get(byId.get(id)?.parentId ?? ""); return parent ? 1 + depth(parent.id, seen) : 0; }

  const allTitles = new Map<string, string[]>();
  const addTitle = (title: string, id: string) => { const key = normalizeGoalReference(title); allTitles.set(key, [...(allTitles.get(key) ?? []), id]); };
  memory.goals.filter((goal) => !["failed", "cancelled"].includes(goal.status)).forEach((goal) => addTitle(goal.title, goal.id));
  strategic.forEach((value) => addTitle(value.input.title, value.id));
  const tactical = plan.goals.map((input) => {
    const parentId = resolveParent(input, true);
    const matches = memory.goals.filter((goal) => goal.kind === "tactical" && normalizeGoalReference(goal.title) === normalizeGoalReference(input.title) && goal.parentId === parentId && !["failed", "cancelled"].includes(goal.status));
    if (matches.length > 1) throw new Error(`ambiguous existing tactical goal ${input.title}`);
    const id = matches[0]?.id ?? `goal-${crypto.randomUUID()}`;
    addTitle(input.title, id);
    return { input, id, parentId, existing: matches[0], dependencyIds: [] as string[] };
  });
  for (const item of tactical) item.dependencyIds = (item.input.dependsOnTitles ?? []).map((title) => {
    const ids = [...new Set(allTitles.get(normalizeGoalReference(title)) ?? [])];
    if (ids.length === 0) throw new Error(`coordinator referenced unknown dependency ${title}`);
    if (ids.length > 1) throw new Error(`coordinator referenced ambiguous dependency ${title}`);
    if (ids[0] === item.id) throw new Error(`goal ${item.input.title} cannot depend on itself`);
    return ids[0]!;
  });
  const dependencies = new Map(memory.goals.map((goal) => [goal.id, goal.dependencies]));
  tactical.forEach((item) => dependencies.set(item.id, item.dependencyIds));
  const dependencyPath = new Set<string>(); const dependencyDone = new Set<string>();
  const visitDependency = (id: string) => {
    if (dependencyPath.has(id)) throw new Error("goal dependencies contain a cycle");
    if (dependencyDone.has(id)) return; dependencyPath.add(id);
    for (const dependency of dependencies.get(id) ?? []) visitDependency(dependency);
    dependencyPath.delete(id); dependencyDone.add(id);
  };
  tactical.forEach((item) => visitDependency(item.id));
  return { strategic, tactical };
}

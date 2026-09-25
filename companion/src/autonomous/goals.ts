import crypto from "node:crypto";
import type { AutonomousMemory, Goal, Verification } from "./memory.js";
export class GoalGraph {
  constructor(private readonly memory: AutonomousMemory) {}
  create(input: { title: string; description?: string; priority?: number; parentId?: string; dependencies?: string[]; verification?: Verification[]; id?: string }): Goal {
    const existing = input.id && this.memory.goals.find(g => g.id === input.id); if (existing) return existing;
    const now = new Date().toISOString(); const goal: Goal = { id: input.id ?? `goal-${crypto.randomUUID()}`, parentId: input.parentId, title: input.title, description: input.description ?? input.title, status: "pending", priority: input.priority ?? 0, dependencies: input.dependencies ?? [], createdAt: now, updatedAt: now, attempts: 0, blockers: [], verification: input.verification ?? [], evidence: [] };
    this.memory.goals.push(goal); this.refresh(); return goal;
  }
  update(id: string, patch: Partial<Pick<Goal, "title"|"description"|"priority"|"blockers"|"result"|"nextReviewAt">>): Goal { const g=this.require(id); Object.assign(g,patch,{updatedAt:new Date().toISOString()}); return g; }
  addDependency(id:string, dependency:string): void { if (id===dependency || this.reachable(dependency,id)) throw new Error("goal dependency would create a cycle"); const g=this.require(id); if(!g.dependencies.includes(dependency)) g.dependencies.push(dependency); this.require(dependency); this.refresh(); }
  transition(id:string,status:Goal["status"],evidence?:string): Goal { const g=this.require(id); const allowed:Record<Goal["status"],Goal["status"][]>={pending:["ready","blocked","failed"],ready:["active","blocked","failed"],active:["blocked","done","failed","ready"],blocked:["ready","failed"],done:[],failed:["ready"]}; if(g.status!==status&&!allowed[g.status].includes(status)) throw new Error(`invalid goal transition ${g.status} -> ${status}`); g.status=status; g.updatedAt=new Date().toISOString(); if(status==="active") g.attempts++; if(evidence) g.evidence.push(evidence); this.refresh(); return g; }
  ready(): Goal[] { this.refresh(); return this.memory.goals.filter(g=>g.status==="ready").sort((a,b)=>b.priority-a.priority); }
  refresh(): void { for(const g of this.memory.goals) if((g.status==="pending"||g.status==="blocked")&&g.blockers.length===0&&g.dependencies.every(id=>this.memory.goals.find(x=>x.id===id)?.status==="done")) g.status="ready"; }
  private require(id:string):Goal { const g=this.memory.goals.find(x=>x.id===id); if(!g) throw new Error(`unknown goal ${id}`); return g; }
  private reachable(from:string,target:string,seen=new Set<string>()):boolean { if(from===target)return true;if(seen.has(from))return false;seen.add(from);return this.require(from).dependencies.some(d=>this.reachable(d,target,seen)); }
}

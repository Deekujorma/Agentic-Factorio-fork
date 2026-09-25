import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { verificationSchema } from "./memory.js";

export const tacticalPlanSchema = z.object({
  title: z.string().min(1), description: z.string().min(1), physical: z.boolean(),
  area: z.object({ x: z.number(), y: z.number(), radius: z.number().positive().max(96) }).optional(),
  expectedInputs: z.array(z.string()).default([]), expectedOutput: z.string().min(1), definitionOfDone: z.string().min(1),
  verification: z.array(verificationSchema).min(1),
}).superRefine((plan, context) => {
  if (plan.physical && !plan.verification.some((check) => check.kind !== "manual")) context.addIssue({ code: "custom", message: "physical tactical work requires deterministic verification", path: ["verification"] });
});
export type TacticalPlan = z.infer<typeof tacticalPlanSchema>;
export type TacticalPlanner = (input: { model: LanguageModel; message: string; signal: AbortSignal }) => Promise<TacticalPlan>;

export function deterministicTacticalPlan(message: string): TacticalPlan | null {
  const text = message.trim();
  if (/^(come here|follow me)[.!]?$/i.test(text)) return tacticalPlanSchema.parse({
    title: `Player request: ${text}`, description: "Move the leased companion near the player", physical: true,
    expectedInputs: [], expectedOutput: "companion near player", definitionOfDone: "a companion is within 5 tiles of the player",
    verification: [{ kind: "companion_near_player", maximumDistance: 5 }],
  });
  const build = text.match(/^build (?:a |an )?([a-z0-9 -]+) at\s*\(?\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*\)?[.!]?$/i);
  if (build) {
    const entity = build[1]!.trim().replace(/\s+/g, "-").toLowerCase(); const x = Number(build[2]); const y = Number(build[3]);
    return tacticalPlanSchema.parse({ title: `Build ${entity} at ${x},${y}`, description: text, physical: true, area: { x, y, radius: 5 }, expectedInputs: [entity], expectedOutput: entity, definitionOfDone: `${entity} exists near (${x}, ${y})`, verification: [{ kind: "entity_count", entity, minimum: 1, area: { x, y, radius: 2 } }] });
  }
  return null;
}

export const defaultTacticalPlanner: TacticalPlanner = async ({ model, message, signal }) => {
  const known = deterministicTacticalPlan(message); if (known) return known;
  const result = await generateText({
    model, system: "Turn one bounded Factorio player request into a tactical leaf. Physical actions require deterministic verification; manual verification is only for informational requests. If safe verification is impossible, set physical false and explain the limitation as an informational response. Return schema output only.",
    prompt: message, abortSignal: signal, maxRetries: 1,
    output: Output.object({ schema: tacticalPlanSchema, name: "factorio_tactical_plan" }),
  });
  return tacticalPlanSchema.parse(result.output);
};

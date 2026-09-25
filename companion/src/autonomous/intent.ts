import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";

export const playerIntentSchema = z.object({
  kind: z.enum(["status", "tactical", "modify", "replace", "resume", "stop"]),
  summary: z.string().min(1), target: z.string().nullable().default(null),
});
export type PlayerIntent = z.infer<typeof playerIntentSchema>;
export type IntentClassifier = (input: { model: LanguageModel; message: string; objective: string | null; signal: AbortSignal }) => Promise<PlayerIntent>;

export function deterministicIntent(message: string, hasCampaign: boolean): PlayerIntent | null {
  const text = message.trim().toLowerCase();
  if (/^(how is it going|how's it going|what are you working on|status|progress)\??$/.test(text)) return { kind: "status", summary: message, target: null };
  if (/^(continue|resume|carry on|keep going)[.!]?$/.test(text)) return { kind: "resume", summary: message, target: null };
  if (/^(come here|follow me|bring .*|go to .*)[.!]?$/.test(text)) return { kind: "tactical", summary: message, target: null };
  const stopTarget = text.match(/^stop working on (.+?)[.!]?$/)?.[1];
  if (stopTarget) return { kind: "modify", summary: message, target: stopTarget };
  if (/^(forget|abandon|replace)\b.*\b(instead|now)\b/.test(text)) return { kind: "replace", summary: message, target: text.split(/\binstead\b/).pop()?.trim() || null };
  if (/^(new objective|change objective)\b/.test(text)) return { kind: "replace", summary: message, target: null };
  if (!hasCampaign) return { kind: "replace", summary: message, target: null };
  return null;
}

export const defaultIntentClassifier: IntentClassifier = async ({ model, message, objective, signal }) => {
  const deterministic = deterministicIntent(message, objective !== null);
  if (deterministic) return deterministic;
  const result = await generateText({
    model, system: "Classify one player message for an autonomous Factorio campaign. Status questions never replace a campaign. Small commands are tactical. Only explicit abandonment/replacement replaces it. Return the schema only.",
    prompt: JSON.stringify({ currentObjective: objective, message }), abortSignal: signal, maxRetries: 1,
    output: Output.object({ schema: playerIntentSchema, name: "factorio_player_intent" }),
  });
  return playerIntentSchema.parse(result.output);
};

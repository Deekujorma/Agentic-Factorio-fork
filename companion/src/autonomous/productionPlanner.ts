import { z } from "zod";
import type { Bridge } from "../bridge.js";

export const recipeComponentSchema = z.object({ item: z.string(), amount: z.number().positive(), probability: z.number().min(0).max(1).optional(), type: z.enum(["item", "fluid"]).default("item") });
export const recipeSchema = z.object({
  name: z.string(), category: z.string(), energy: z.number().positive(), enabled: z.boolean(),
  ingredients: z.array(recipeComponentSchema), products: z.array(recipeComponentSchema).min(1),
});
export type Recipe = z.infer<typeof recipeSchema>;
export interface ProductionNode {
  item: string; type: "item" | "fluid"; ratePerMinute: number; recipe?: string; craftingTime?: number;
  category?: string; machinesAtSpeedOne: number; ingredients: ProductionNode[]; raw: boolean; alternatives?: string[];
}
export interface ProductionPlan { target: string; ratePerMinute: number; root: ProductionNode; rawDemandPerMinute: Record<string, number>; warnings: string[] }

export function planProduction(rawRecipes: Recipe[], item: string, ratePerMinute: number): ProductionPlan {
  if (!item.trim()) throw new Error("item must not be empty");
  if (!Number.isFinite(ratePerMinute) || ratePerMinute <= 0) throw new Error("ratePerMinute must be positive");
  const recipes = z.array(recipeSchema).parse(rawRecipes);
  const byProduct = new Map<string, Recipe[]>();
  for (const recipe of recipes) for (const product of recipe.products) {
    const existing = byProduct.get(product.item) ?? []; existing.push(recipe); byProduct.set(product.item, existing);
  }
  const rawDemandPerMinute: Record<string, number> = {}; const warnings: string[] = [];
  const visit = (name: string, rate: number, stack: string[], type: "item" | "fluid" = "item"): ProductionNode => {
    if (stack.includes(name)) throw new Error(`recipe cycle: ${[...stack, name].join(" -> ")}`);
    const alternatives = byProduct.get(name) ?? [];
    const recipe = alternatives.filter((candidate) => candidate.enabled).sort((a, b) => a.name.localeCompare(b.name))[0];
    if (!recipe) {
      rawDemandPerMinute[name] = (rawDemandPerMinute[name] ?? 0) + rate;
      if (alternatives.length > 0) warnings.push(`${name}: only locked recipes are available`);
      return { item: name, type, ratePerMinute: rate, machinesAtSpeedOne: 0, ingredients: [], raw: true, alternatives: alternatives.map((value) => value.name) };
    }
    const output = recipe.products.find((product) => product.item === name)!;
    const expectedOutput = output.amount * (output.probability ?? 1);
    if (expectedOutput <= 0) throw new Error(`recipe ${recipe.name} has zero expected output for ${name}`);
    const craftsPerMinute = rate / expectedOutput;
    return {
      item: name, type: output.type, ratePerMinute: rate, recipe: recipe.name, craftingTime: recipe.energy,
      category: recipe.category, machinesAtSpeedOne: craftsPerMinute * recipe.energy / 60, raw: false,
      alternatives: alternatives.filter((value) => value.name !== recipe.name).map((value) => value.name),
      ingredients: recipe.ingredients.map((ingredient) => visit(ingredient.item, craftsPerMinute * ingredient.amount, [...stack, name], ingredient.type)),
    };
  };
  return { target: item, ratePerMinute, root: visit(item, ratePerMinute, []), rawDemandPerMinute, warnings: [...new Set(warnings)] };
}

export async function planProductionFromGame(bridge: Bridge, item: string, ratePerMinute: number): Promise<ProductionPlan> {
  const response = await bridge.call<{ recipes: unknown[] }>("get_recipe_graph", { item, include_all: true });
  return planProduction(z.array(recipeSchema).parse(response.recipes), item, ratePerMinute);
}

export async function productionPlansForStrategy(bridge: Bridge, text: string): Promise<ProductionPlan[]> {
  const requests = [...text.matchAll(/\b([a-z][a-z0-9-]{2,})\s+(?:at\s+)?(\d+(?:\.\d+)?)\s*(?:\/\s*min|per\s+minute)\b/gi)]
    .slice(0, 4).map((match) => ({ item: match[1]!.toLowerCase(), rate: Number(match[2]) }));
  const lower = text.toLowerCase();
  const defaults: Array<[RegExp, string]> = [
    [/\b(red|automation) science\b/, "automation-science-pack"],
    [/\b(green|logistic) science\b/, "logistic-science-pack"],
    [/\bblue science\b/, "chemical-science-pack"],
    [/\bpurple science\b/, "production-science-pack"],
    [/\byellow science\b/, "utility-science-pack"],
  ];
  for (const [pattern, target] of defaults) if (pattern.test(lower) && !requests.some((value) => value.item === target)) requests.push({ item: target, rate: 60 });
  return Promise.all(requests.slice(0, 4).map((request) => planProductionFromGame(bridge, request.item, request.rate)));
}

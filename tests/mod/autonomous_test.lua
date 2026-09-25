-- Offline tests for the read-only autonomous observation RPC helpers.
local here = (arg and arg[0] or "."):match("^(.*)/[^/]+$") or "."
package.path = here .. "/../../mod/agentic-companion/?.lua;" .. package.path

local failures = 0
local function check(value, message)
  if value then print("ok   " .. message) else failures = failures + 1 print("FAIL " .. message) end
end

_G.defines = {
  inventory = { chest = 1 },
  entity_status = { working = 1, normal = 2 },
  flow_precision_index = { one_minute = 1 },
}
local inventory = { get_item_count = function(name) return name == "plate" and 20 or 0 end }
local chest = { status = 1, get_inventory = function(index) if index == 1 then return inventory end end, get_item_count = function() return 0 end }
local surface = {
  count_entities_filtered = function(args) return args.name == "assembling-machine-1" and 2 or 0 end,
  find_entities_filtered = function() return { chest } end,
}
local stats = { get_flow_count = function(args) return args.name == "plate" and 60 or 0 end }
local force = {
  technologies = { automation = { researched = true } },
  get_item_production_statistics = function() return stats end,
  recipes = {
    gear = { name = "gear", category = "crafting", energy = 0.5, enabled = true,
      ingredients = { { name = "iron-plate", amount = 2, type = "item" } },
      products = { { name = "iron-gear-wheel", amount = 1, type = "item" } } },
  },
}
package.loaded["scripts.companion"] = { get = function() return { force = force, surface = surface } end }
_G.game = { tick = 42, connected_players = {}, forces = { player = force }, surfaces = { surface }, get_entity_by_unit_number = function() return chest end }

local autonomous = require("scripts.autonomous")
local verified = autonomous.verify({ checks = {
  { kind = "entity_count", entity = "assembling-machine-1", minimum = 2, area = { x = 0, y = 0, radius = 5 } },
  { kind = "inventory", item = "plate", minimum = 10, unit_number = 1 },
  { kind = "research", technology = "automation" },
  { kind = "production", item = "plate", minimum_per_minute = 60 },
  { kind = "operational", entity = "assembling-machine-1", minimum = 1, area = { x = 0, y = 0, radius = 5 } },
} })
check(verified.tick == 42 and #verified.results == 5, "autonomous verification returns tick and every result")
for i, result in ipairs(verified.results) do check(result.ok, "verification predicate " .. i .. " passes") end

local graph = autonomous.recipe_graph({ item = "iron-gear-wheel", include_all = true })
check(#graph.recipes == 1 and graph.recipes[1].ingredients[1].item == "iron-plate", "recipe graph uses running force recipes")
check(graph.recipes[1].products[1].amount == 1, "recipe graph normalizes products")

print(failures == 0 and "\nALL TESTS PASSED" or ("\n" .. failures .. " FAILURES"))
os.exit(failures == 0 and 0 or 1)

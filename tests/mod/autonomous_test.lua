-- Offline tests for the read-only autonomous observation RPC helpers.
local here = (arg and arg[0] or "."):match("^(.*)/[^/]+$") or "."
package.path = here .. "/../../mod/agentic-companion/?.lua;" .. package.path

local failures = 0
local function check(value, message)
  if value then print("ok   " .. message) else failures = failures + 1 print("FAIL " .. message) end
end

_G.defines = {
  inventory = { chest = 1 },
  entity_status = { working = 1, normal = 2, no_power = 3, no_fuel = 4, no_ingredients = 5, full_output = 6 },
  flow_precision_index = { one_minute = 1 },
}
local inventory = { get_item_count = function(name) return name == "plate" and 20 or 0 end }
local chest = { status = 1, get_inventory = function(index) if index == 1 then return inventory end end, get_item_count = function() return 0 end }
local force
local surface = {
  count_entities_filtered = function(args)
    if args.type == "resource" and args.name == "iron-ore" and args.force == nil then return 735 end
    if args.name == "assembling-machine-1" and args.force == force then return 2 end
    return 0
  end,
  find_entities_filtered = function() return { chest } end,
}
local stats = { get_flow_count = function(args) return args.name == "plate" and 60 or 0 end }
force = {
  technologies = { automation = { researched = true } },
  get_item_production_statistics = function() return stats end,
  recipes = {
    gear = { name = "gear", category = "crafting", energy = 0.5, enabled = true,
      ingredients = { { name = "iron-plate", amount = 2, type = "item" } },
      products = { { name = "iron-gear-wheel", amount = 1, type = "item" } } },
  },
}
package.loaded["scripts.companion"] = { get = function() return { force = force, surface = surface } end }
local player_p = { name = "P", position = { x = 0, y = 0 }, surface = surface }
local player_q = { name = "Q", position = { x = 200, y = 0 }, surface = surface }
local players = { P = player_p, Q = player_q }
local ada = { valid = true, position = { x = 100, y = 0 }, surface = surface }
local babbage = { valid = true, position = { x = 2, y = 0 }, surface = surface }
_G.game = { tick = 42, connected_players = { player_p, player_q }, forces = { player = force }, surfaces = { surface }, get_entity_by_unit_number = function() return chest end, get_player = function(name) return players[name] end }
_G.storage = { autonomous = { event_counts = { rocket_launched = 1 } }, companions = { Ada = { entity = ada }, Babbage = { entity = babbage } } }

local autonomous = require("scripts.autonomous")
local verified = autonomous.verify({ checks = {
  { kind = "entity_count", entity = "assembling-machine-1", minimum = 2, area = { x = 0, y = 0, radius = 5 } },
  { kind = "resource_count", resource = "iron-ore", minimum = 8, area = { x = -34, y = 83.5, radius = 20 } },
  { kind = "inventory", item = "plate", minimum = 10, unit_number = 1 },
  { kind = "research", technology = "automation" },
  { kind = "production", item = "plate", minimum_per_minute = 60 },
  { kind = "operational", entity = "assembling-machine-1", minimum = 1, area = { x = 0, y = 0, radius = 5 } },
} })
check(verified.tick == 42 and #verified.results == 6, "autonomous verification returns tick and every result")
for i, result in ipairs(verified.results) do check(result.ok, "verification predicate " .. i .. " passes") end

local graph = autonomous.recipe_graph({ item = "iron-gear-wheel", include_all = true })
check(#graph.recipes == 1 and graph.recipes[1].ingredients[1].item == "iron-plate", "recipe graph uses running force recipes")
check(graph.recipes[1].products[1].amount == 1, "recipe graph normalizes products")

chest.status = defines.entity_status.working
local clear = autonomous.verify({ checks = { { kind = "no_factory_blocker", area = { x = 0, y = 0, radius = 5 } } } })
check(clear.results[1].ok == true, "no_factory_blocker passes with zero blockers")
chest.status = defines.entity_status.no_power
local blocked = autonomous.verify({ checks = { { kind = "no_factory_blocker", area = { x = 0, y = 0, radius = 5 } } } })
check(blocked.results[1].ok == false and blocked.results[1].actual == 1,
  "no_factory_blocker fails with one or more blockers")
local launched = autonomous.verify({ checks = { { kind = "event_count", event = "rocket_launched", minimum = 1 } } })
check(launched.results[1].ok == true, "event_count observes persisted rocket launches")
local wrong_companion = autonomous.verify({ checks = { { kind = "companion_near_player", companion = "Ada", player = "P", maximum_distance = 5 } } })
check(wrong_companion.results[1].ok == false and wrong_companion.results[1].actual == 100,
  "companion_near_player does not substitute a nearby companion")
ada.position = { x = 3, y = 0 }
babbage.position = { x = 100, y = 0 }
local assigned_nearby = autonomous.verify({ checks = { { kind = "companion_near_player", companion = "Ada", player = "P", maximum_distance = 5 } } })
check(assigned_nearby.results[1].ok == true and assigned_nearby.results[1].actual == 3,
  "companion_near_player passes for the assigned nearby companion")
ada.position = { x = 100, y = 0 }
player_q.position = { x = 101, y = 0 }
local wrong_player = autonomous.verify({ checks = { { kind = "companion_near_player", companion = "Ada", player = "P", maximum_distance = 5 } } })
check(wrong_player.results[1].ok == false and wrong_player.results[1].actual == 100,
  "companion_near_player does not substitute another nearby player")
local missing_identity = autonomous.verify({ checks = {
  { kind = "companion_near_player", companion = "Missing", player = "P", maximum_distance = 5 },
  { kind = "companion_near_player", companion = "Ada", player = "Missing", maximum_distance = 5 },
} })
check(missing_identity.results[1].ok == false and missing_identity.results[2].ok == false,
  "companion_near_player fails cleanly for missing named identities")

force.recipes.probability = { name = "probability", category = "chemistry", energy = 1, enabled = true,
  ingredients = {}, products = { { name = "rare", amount_min = 2, amount_max = 4, probability = 0.5, type = "item" } } }
local probability = autonomous.recipe_graph({ item = "rare" })
check(probability.recipes[1].products[1].amount == 1.5, "recipe graph normalizes expected probabilistic output")

print(failures == 0 and "\nALL TESTS PASSED" or ("\n" .. failures .. " FAILURES"))
os.exit(failures == 0 and 0 or 1)

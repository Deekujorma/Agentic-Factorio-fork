-- Narrow, read-only queries used by the autonomous supervisor.  This module
-- deliberately exposes observations, never arbitrary Lua or mutation.
local companion = require("scripts.companion")

local M = {}

local function force_and_surface()
  local c = companion.get()
  if c then return c.force, c.surface end
  local player = game.connected_players[1]
  if player then return player.force, player.surface end
  return game.forces.player, game.surfaces[1]
end

local function area_of(value)
  if type(value) ~= "table" or tonumber(value.x) == nil or tonumber(value.y) == nil then
    error("verification area must contain numeric x and y")
  end
  local radius = math.max(0, math.min(tonumber(value.radius) or 0, 256))
  return {{value.x - radius, value.y - radius}, {value.x + radius, value.y + radius}}
end

local function inventory_total(entity, item)
  local total, seen = 0, {}
  for _, index in pairs(defines.inventory) do
    if type(index) == "number" and not seen[index] then
      seen[index] = true
      local ok, inventory = pcall(entity.get_inventory, index)
      if ok and inventory then total = total + inventory.get_item_count(item) end
    end
  end
  local ok, belt = pcall(entity.get_item_count, item)
  if ok and type(belt) == "number" then total = math.max(total, belt) end
  return total
end

function M.verify(params)
  local force, surface = force_and_surface()
  local checks = params.checks
  if type(checks) ~= "table" or #checks == 0 or #checks > 32 then
    error("verify_autonomous needs 1-32 checks")
  end
  local results = {}
  for i, check in ipairs(checks) do
    local kind, actual, expected = check.kind, nil, nil
    if kind == "entity_count" then
      expected = math.max(0, tonumber(check.minimum) or 0)
      actual = surface.count_entities_filtered({area = area_of(check.area), name = check.entity, force = force})
    elseif kind == "inventory" then
      expected = math.max(0, tonumber(check.minimum) or 0)
      local entity
      if check.unit_number then entity = game.get_entity_by_unit_number(tonumber(check.unit_number)) end
      if not entity and check.position then
        local found = surface.find_entities_filtered({position = check.position, radius = 1.5, force = force})
        entity = found[1]
      end
      actual = entity and inventory_total(entity, check.item) or 0
    elseif kind == "research" then
      local technology = force.technologies[check.technology]
      actual, expected = technology ~= nil and technology.researched, true
    elseif kind == "production" then
      expected = math.max(0, tonumber(check.minimum_per_minute) or 0)
      actual = force.get_item_production_statistics(surface).get_flow_count({
        name = check.item, category = "input", count = true,
        precision_index = defines.flow_precision_index.one_minute,
      })
    elseif kind == "operational" then
      expected = math.max(1, tonumber(check.minimum) or 1)
      actual = 0
      for _, entity in ipairs(surface.find_entities_filtered({area = area_of(check.area), name = check.entity, force = force})) do
        local ok, status = pcall(function() return entity.status end)
        if ok and (status == defines.entity_status.working or status == defines.entity_status.normal) then
          actual = actual + 1
        end
      end
    elseif kind == "no_factory_blocker" then
      actual, expected = 0, 0
      for _, entity in ipairs(surface.find_entities_filtered({area = area_of(check.area), name = check.entity, force = force})) do
        local ok, status = pcall(function() return entity.status end)
        if ok and (status == defines.entity_status.no_power or status == defines.entity_status.no_fuel
          or status == defines.entity_status.no_ingredients or status == defines.entity_status.full_output) then
          actual = actual + 1
        end
      end
    else
      error("unsupported autonomous verification kind: " .. tostring(kind))
    end
    results[i] = {kind = kind, ok = actual == true or (type(actual) == "number" and actual >= expected), actual = actual, expected = expected}
  end
  return {tick = game.tick, results = results}
end

local function amount_of(product)
  if product.amount then return product.amount end
  if product.amount_min and product.amount_max then return (product.amount_min + product.amount_max) / 2 end
  return 1
end

function M.recipe_graph(params)
  local force = force_and_surface()
  local target = params.item
  if type(target) ~= "string" or target == "" then error("get_recipe_graph needs item") end
  local recipes = {}
  for _, recipe in pairs(force.recipes) do
    local products = {}
    local produces_target = false
    for _, product in ipairs(recipe.products) do
      products[#products + 1] = {item = product.name, amount = amount_of(product), type = product.type}
      if product.name == target then produces_target = true end
    end
    if produces_target or params.include_all == true then
      local ingredients = {}
      for _, ingredient in ipairs(recipe.ingredients) do
        ingredients[#ingredients + 1] = {item = ingredient.name, amount = ingredient.amount, type = ingredient.type}
      end
      recipes[#recipes + 1] = {
        name = recipe.name, category = recipe.category, energy = recipe.energy,
        enabled = recipe.enabled, ingredients = ingredients, products = products,
      }
    end
  end
  return {tick = game.tick, item = target, recipes = recipes}
end

return M

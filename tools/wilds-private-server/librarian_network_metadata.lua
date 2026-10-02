-- Inventaire borne des signatures reseau : aucune instance ni valeur de jeu.
-- Les candidats viennent de chaines statiques ; leur presence reste a verifier.
local LIMITS = {
    types = 128, methods_per_type = 128, fields_per_type = 64,
    params_per_method = 16, types_per_frame = 2, name_length = 512,
    errors = 256,
}
local OUTPUT = "librarian_network_metadata.json"
local SEEDS = {
    "app.net_lobby_session", "app.net_local_session", "app.net_quest_session",
    "app.net_session_manager", "app.NetworkRequestManager",
    "app.NetworkRequestManager.INet_LinkParty",
    "app.NetworkRequestManager.INet_LinkSession",
    "via.network.SessionBase", "via.network.SessionRebe", "via.network.SessionSteam",
    "via.network.SessionPlayFab", "via.network.SessionPFMP",
    "via.network.ContextBase", "via.network.ContextRebe", "via.network.ContextSteam",
    "via.network.ConnectionString", "via.network.Matchmaking",
    "via.network.AutoMatchmaking", "via.network.InvitationRebe",
    "via.network.InvitationPlayFab", "via.network.SubsidiarySessionProtocol",
}

local report = {
    schema_version = 1,
    mode = "metadata_only",
    output_file = OUTPUT,
    complete = false,
    limits = LIMITS,
    types = {},
    errors = {},
    counts = {
        queued = 0, processed = 0, found = 0, candidate_not_found = 0,
        api_error = 0, methods_omitted = 0, fields_omitted = 0,
        params_omitted = 0, type_limit_hits = 0,
        name_limit_hits = 0, errors_omitted = 0,
    },
}
local queue, seen, cursor, finished = {}, {}, 1, false

-- Les messages bruts d'exception peuvent contenir des adresses : on les omet.
local function record_error(candidate, stage, kind)
    report.counts.api_error = report.counts.api_error + 1
    if #report.errors < LIMITS.errors then
        report.errors[#report.errors + 1] = {
            candidate = candidate, stage = stage, kind = kind or "api_error",
        }
    else
        report.counts.errors_omitted = report.counts.errors_omitted + 1
    end
end

local function metadata(object, getter, candidate)
    local ok, value = pcall(function() return object[getter](object) end)
    if not ok then
        record_error(candidate, getter)
        return nil, false
    end
    return value, true
end

local function text_name(value, candidate, stage)
    if type(value) ~= "string" then
        record_error(candidate, stage, "invalid_metadata_string")
        return nil
    end
    if #value > LIMITS.name_length then
        report.counts.name_limit_hits = report.counts.name_limit_hits + 1
        return nil
    end
    return value
end

local function network_type(name)
    return name:match("^via%.network%.") ~= nil
        or name:match("^app%.net_") ~= nil
        or name == "app.NetworkRequestManager"
        or name:match("^app%.NetworkRequestManager%.") ~= nil
end

local function enqueue(name, origin, source)
    if not name or seen[name] then return end
    if #queue >= LIMITS.types then
        report.counts.type_limit_hits = report.counts.type_limit_hits + 1
        return
    end
    seen[name] = true
    queue[#queue + 1] = { name = name, origin = origin, source = source }
    report.counts.queued = #queue
end

-- Les references sont des descripteurs de type, jamais des objets du jeu.
local function type_name(definition, candidate, source)
    if definition == nil then return nil end
    local value, ok = metadata(definition, "get_full_name", candidate)
    if not ok then return nil end
    local name = text_name(value, candidate, "get_full_name")
    if name and network_type(name) then enqueue(name, "metadata_reference", source) end
    return name
end

local function metadata_list(object, getter, candidate)
    local value, ok = metadata(object, getter, candidate)
    if not ok then return {} end
    if type(value) ~= "table" then
        record_error(candidate, getter, "invalid_metadata_list")
        return {}
    end
    return value
end

local function boolean_metadata(object, getter, candidate)
    local value, ok = metadata(object, getter, candidate)
    if not ok then return nil end
    if type(value) ~= "boolean" then
        record_error(candidate, getter, "invalid_metadata_boolean")
        return nil
    end
    return value
end

local function describe_method(method, candidate)
    local raw_name, name_ok = metadata(method, "get_name", candidate)
    local name = name_ok and text_name(raw_name, candidate, "get_name") or nil
    local result = { name = name, params = {} }
    result.is_static = boolean_metadata(method, "is_static", candidate)
    local return_type = metadata(method, "get_return_type", candidate)
    result.return_type = type_name(return_type, candidate, candidate .. ":return")
    local declared, count_ok = metadata(method, "get_num_params", candidate)
    if count_ok and type(declared) == "number" and declared >= 0
        and declared < math.huge and declared == math.floor(declared) then
        result.parameter_count = declared
    else
        if count_ok then record_error(candidate, "get_num_params", "invalid_metadata_count") end
        declared = 0
    end
    local types = metadata_list(method, "get_param_types", candidate)
    local names = metadata_list(method, "get_param_names", candidate)
    local total = math.max(declared, #types, #names)
    local count = math.min(total, LIMITS.params_per_method)
    result.params_omitted = total - count
    report.counts.params_omitted = report.counts.params_omitted + result.params_omitted
    for i = 1, count do
        local parameter = { index = i }
        if names[i] ~= nil then
            parameter.name = text_name(names[i], candidate, "get_param_names")
        end
        parameter.type = type_name(types[i], candidate, candidate .. ":parameter")
        result.params[#result.params + 1] = parameter
    end
    return result
end

local function describe_field(field, candidate)
    local raw_name, name_ok = metadata(field, "get_name", candidate)
    local field_type = metadata(field, "get_type", candidate)
    return {
        name = name_ok and text_name(raw_name, candidate, "get_name") or nil,
        type = type_name(field_type, candidate, candidate .. ":field"),
        is_static = boolean_metadata(field, "is_static", candidate),
        is_literal = boolean_metadata(field, "is_literal", candidate),
    }
end

local function describe_candidate(item)
    local result = {
        candidate = item.name, origin = item.origin, source = item.source,
        status = "api_error", methods = {}, fields = {},
    }
    report.types[#report.types + 1] = result
    report.counts.processed = report.counts.processed + 1
    local ok, definition = pcall(function() return sdk.find_type_definition(item.name) end)
    if not ok then
        record_error(item.name, "find_type_definition")
        return
    end
    if definition == nil then
        result.status = "candidate_not_found"
        report.counts.candidate_not_found = report.counts.candidate_not_found + 1
        return
    end
    result.status = "found"
    report.counts.found = report.counts.found + 1
    local raw_name, name_ok = metadata(definition, "get_full_name", item.name)
    result.full_name = name_ok and text_name(raw_name, item.name, "get_full_name") or nil
    local methods = metadata_list(definition, "get_methods", item.name)
    local method_count = math.min(#methods, LIMITS.methods_per_type)
    result.methods_omitted = #methods - method_count
    report.counts.methods_omitted = report.counts.methods_omitted + result.methods_omitted
    for i = 1, method_count do
        result.methods[#result.methods + 1] = describe_method(methods[i], item.name)
    end
    local fields = metadata_list(definition, "get_fields", item.name)
    local field_count = math.min(#fields, LIMITS.fields_per_type)
    result.fields_omitted = #fields - field_count
    report.counts.fields_omitted = report.counts.fields_omitted + result.fields_omitted
    for i = 1, field_count do
        result.fields[#result.fields + 1] = describe_field(fields[i], item.name)
    end
end

for _, name in ipairs(SEEDS) do
    local origin = "static_exe_string"
    if name == "app.NetworkRequestManager" then origin = "inferred_parent"
    elseif name:match("^app%.NetworkRequestManager%.") then
        origin = "inferred_declaring_type_from_member_string"
    end
    enqueue(name, origin)
end
local version_ok, version = pcall(function() return sdk.get_tdb_version() end)
if version_ok and type(version) == "number" and version >= 0
    and version < math.huge and version == math.floor(version) then
    report.tdb_version = version
else
    record_error("", "get_tdb_version", version_ok and "invalid_metadata_count" or "api_error")
end

local function finish()
    -- Une seule tentative d'ecriture ; aucune reprise implicite chaque image.
    finished = true
    report.complete = true
    local ok, saved = pcall(function() return json.dump_file(OUTPUT, report, 2) end)
    if not ok or saved ~= true then
        if log and log.error then log.error("[LIB] Export des metadonnees reseau impossible.") end
    elseif log and log.info then
        log.info("[LIB] Metadonnees reseau exportees : " .. OUTPUT)
    end
end

-- Dans un test isole, capturer ce callback puis simuler au plus 64 images.
re.on_frame(function()
    if finished then return end
    for _ = 1, LIMITS.types_per_frame do
        local item = queue[cursor]
        if not item then break end
        cursor = cursor + 1
        describe_candidate(item)
    end
    if cursor > #queue then finish() end
end)

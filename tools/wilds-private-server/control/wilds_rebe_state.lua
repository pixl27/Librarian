-- Librarian: poll via.rebe.RebeService and log the exact auth failure cause.
--
-- We need to know WHY the faked /sign is rejected. RebeService.get_LastError()
-- returns a via.rebe.RebeError carrying a Cause (JsonFormat / ServerResponse /
-- Expired / ...) and a Sub (HttpMtmSign / ...). JsonFormat => schema problem,
-- iterate the JSON keys. ServerResponse => the stub's missing response headers.

local CAUSE = {[0]="None","Timeout","NativeApi","ServerResponse","JsonFormat",
               "Suspended","Maintenance","Expired","UniqueIdChanged","LowLevel"}
local SUB   = {[0]="Base","HttpHjm","HttpMtmSign","HttpMtmRefresh",
               "HttpMtmCapcomLinkInitialize","HttpMtmCapcomLinkFinalize"}

local function safe(f, ...) local ok, r = pcall(f, ...); if ok then return r end; return nil end
local function emit(s) log.info("[wilds_rebe_state] " .. s) end

-- Read an int out of an object regardless of whether Cause/Sub are fields,
-- properties, or an enum box.
local function as_int(x)
  if type(x) == "number" then return x end
  if type(x) == "userdata" then
    local v = safe(function() return x:get_field("value__") end); if type(v)=="number" then return v end
    v = safe(function() return x:call("get_value__") end); if type(v)=="number" then return v end
  end
  return nil
end

local svc, svc_native
local svc_td = safe(sdk.find_type_definition, "via.rebe.RebeService")
local function service()
  if svc then return svc, false end
  if svc_native then return svc_native, true end
  svc = safe(sdk.get_managed_singleton, "via.rebe.RebeService")
  if svc then return svc, false end
  svc_native = safe(sdk.get_native_singleton, "via.rebe.RebeService")
  if svc_native then return svc_native, true end
  return nil
end

-- Uniform getter across managed (:call) and native (call_native_func) instances.
local function getf(inst, native, method)
  if native then return safe(function() return sdk.call_native_func(inst, svc_td, method) end) end
  return safe(function() return inst:call(method) end)
end

-- One-time: dump the dev-flag and state enums (a bypass flag would live here).
local dumped = false
local function dump_enum(name)
  local td = safe(sdk.find_type_definition, name)
  if not td then emit("(enum not found) " .. name); return end
  emit("ENUM " .. name)
  local fs = safe(function() return td:get_fields() end)
  if fs then for _, f in ipairs(fs) do
    local fn = safe(function() return f:get_name() end) or "?"
    if fn ~= "value__" then
      local v = safe(function() return f:get_data(nil) end)
      emit(string.format("   %-28s = %s", fn, tostring(v)))
    end
  end end
end
local function dump_error_type()
  if dumped then return end; dumped = true
  dump_enum("via.rebe.RebeDevFlags")
  dump_enum("via.rebe.RebeServiceState")
  dump_enum("via.rebe.RebeErrorCause")
end

local function read_error(err)
  if not err then return "nil" end
  local cause = as_int(safe(function() return err:call("get_Cause") end))
  local sub   = as_int(safe(function() return err:call("get_Sub") end))
  local nat   = as_int(safe(function() return err:call("get_Native") end))
  local valid = safe(function() return err:call("get_Valid") end)
  local cn = cause and (CAUSE[cause] or ("#"..cause)) or "?"
  local sn = sub   and (SUB[sub]     or ("#"..sub))   or "?"
  local nh = nat and string.format("0x%X(%d)", nat, nat) or "?"
  return string.format("cause=%s sub=%s native=%s valid=%s", cn, sn, nh, tostring(valid))
end

local n, last = 0, ""
local verbose_set = false
re.on_frame(function()
  n = n + 1
  if n % 120 ~= 0 then return end        -- ~ every 2s
  if n > 60 * 60 * 45 then return end       -- keep polling ~45 min (candidate harness)
  local s, native = service()
  if not s then emit("RebeService singleton not available yet"); return end
  dump_error_type()

  local state = as_int(getf(s, native, "get_State"))
  local seq   = getf(s, native, "get_AuthSequence")
  local auth  = getf(s, native, "get_Authorized")
  local tok   = getf(s, native, "get_RebeToken")
  local toklen = (type(tok)=="string") and #tok or 0
  local err   = getf(s, native, "get_LastError")
  -- Turn on rebe verbose once, in case it logs the exact JSON parse failure.
  if not verbose_set then
    verbose_set = true
    if native then safe(function() sdk.call_native_func(s, svc_td, "set_Verbose", true) end)
    else safe(function() s:call("set_Verbose", true) end) end
    emit("set_Verbose(true) attempted; now Verbose=" .. tostring(getf(s, native, "get_Verbose")))
  end
  local devflags = getf(s, native, "get_DevFlags")
  if devflags ~= nil then emit("DevFlags=" .. tostring(devflags) .. " Verbose=" .. tostring(getf(s, native, "get_Verbose"))) end

  -- Edge-trigger on the (state,seq,tokenLen) tuple so each fresh auth attempt
  -- re-logs its cause even when consecutive attempts fail identically. The
  -- candidate harness relies on one STATE line per attempt.
  local key = tostring(state) .. "|" .. tostring(seq) .. "|" .. tostring(toklen)
  local line = string.format("STATE state=%s seq=%s authorized=%s tokenLen=%d  err{%s}",
    tostring(state), tostring(seq), tostring(auth), toklen, read_error(err))
  if key ~= last then emit(line); last = key end
  if state == 3 or auth == true or toklen > 0 then emit("AUTHORIZED reached! tokenLen=" .. toklen) end
end)

emit("rebe_state poller armed")

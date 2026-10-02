-- wilds_redirect.lua  --  REFramework autorun hook (redirection voie #1)
-- Points the Capcom control-plane (Rebe meta-backend + app.Net_APIServer REST)
-- at a LOCAL server (wilds_localserver.mjs on http://127.0.0.1:21080).
--
-- Mechanism (recovered statically, all confirmed present in the running image):
--   * via.rebe.RebeService exposes static set_*UriStr setters for every meta
--     endpoint (Hjm/Mtm/Mts/Tmr/Nkm/Wlt/GssSel/GdkWebServiceEndpoint).
--   * app.Net_APIServer.initialize(System.String) takes the REST base host.
--   * RebeDevFlags.HjmIgnore lets the client skip the Hjm auth step.
--
-- HONEST LIMITS -- read before running:
--   1. This redirects the CONTROL PLANE only. It brings the client to the online
--      menu / lobby. It does NOT redirect the playable hunt: combat runs on
--      PlayFab Party P2P (Azure), which is native (PartyWin.dll) and NOT settable
--      here. A local server cannot host the hunt. See RAPPORT_FAISABILITE_WILDS.md.
--   2. LoginWithSteam still targets <titleid>.playfabapi.com (native, not a Rebe
--      URI). Even with everything below pointed local, booting the game WILL try
--      to reach PlayFab/Microsoft unless that native call is separately stubbed.
--      => Only run this against a live client when you accept that upstream contact.
--   3. Do not treat a green boot as "co-op works". Verify each stage.
--
-- Install: drop in  <game>/reframework/autorun/  and start the local server first.

local LOCAL_BASE   = "http://127.0.0.1:21080"
local LOCAL_WS     = "ws://127.0.0.1:21080"

-- Only the Hjm entry point is redirected. Every other service address (mtm, nkm, wlt, ...) and
-- the REST/notify bases come from the system.json our server hands back, so they follow it.
-- (Observed 2026-09-28: the real client GETs <hjm><path>, path = /systems/EAR-P-WW/<rev>/system.json.)
local REBE_URIS = {
  set_HjmUriStr     = LOCAL_BASE .. "/hjm",
  set_HjmUriPathStr = "/hjm",
}

local log = function(s) log.info("[wilds_redirect] " .. tostring(s)) end

local function td(name) return sdk.find_type_definition(name) end

local function call_static(type_name, method_name, ...)
  local t = td(type_name)
  if not t then log("missing type " .. type_name); return end
  local m = t:get_method(method_name)
  if not m then log("missing method " .. type_name .. "." .. method_name); return end
  local ok, err = pcall(function(...) m:call(nil, ...) end, ...)
  if not ok then log("call failed " .. method_name .. ": " .. tostring(err))
  else log("set " .. method_name) end
end

local applied = false
local function apply_redirect()
  if applied then return end
  local rebe = td("via.rebe.RebeService")
  if not rebe then return end            -- Rebe not up yet; retry next frame
  call_static("via.rebe.RebeService", "set_Verbose", true)
  for setter, uri in pairs(REBE_URIS) do
    call_static("via.rebe.RebeService", setter, uri)
  end
  applied = true
  log("Rebe URIs redirected to " .. LOCAL_BASE)
end

-- Force the REST base host on app.Net_APIServer.initialize(String).
local apis = td("app.Net_APIServer")
if apis then
  local init = apis:get_method("initialize")
  if init then
    sdk.hook(init, function(args)
      -- args[2] = 'this', args[3] = the base-url string (managed System.String)
      local ok, s = pcall(function() return sdk.to_managed_object(args[3]):ToString() end)
      log("Net_APIServer.initialize original base = " .. (ok and tostring(s) or "?"))
      -- replace the argument with our local base
      local newstr = sdk.create_managed_string(LOCAL_BASE)
      args[3] = newstr:get_address()
      log("Net_APIServer.initialize base -> " .. LOCAL_BASE)
    end, function(retval) return retval end)
    log("hooked app.Net_APIServer.initialize")
  end
  -- Observe the real header/envelope model for validation (read-only).
  local addh = apis:get_method("addAPIHeader")
  if addh then
    sdk.hook(addh, function(args)
      log("addAPIHeader called (inspect the cNetHttpRequest to confirm header model)")
    end, function(retval) return retval end)
  end
end

re.on_frame(function()
  if not applied then apply_redirect() end
end)

log("loaded. Start wilds_localserver.mjs on " .. LOCAL_BASE .. " before online boot. WS hub: " .. LOCAL_WS)

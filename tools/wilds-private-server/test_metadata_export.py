"""Exercise the exporter in isolated Lua, with no game, filesystem or network APIs.

Requires lupa in the test Python environment only; the game exporter has no
third-party dependency beyond its existing REFramework host.
"""
from pathlib import Path
import unittest
from lupa import LuaRuntime

SCRIPT = Path(__file__).with_name("librarian_network_metadata.lua").read_text(encoding="utf-8")
MOCK = r'''
os, io, package, require, python = nil, nil, nil, nil, nil
definitions, logs = {}, {}
lookups, saves, saved, frames = 0, 0, nil, 0
local function locked(t)
    return setmetatable(t, {__index=function(_, key) error("Unexpected API: "..key) end})
end
function type_ref(name)
    return locked({get_full_name=function() return name end})
end
function type_def(name, methods, fields)
    return locked({
        get_full_name=function() return name end,
        get_methods=function() return methods or {} end,
        get_fields=function() return fields or {} end,
    })
end
function method(name, returned, parameters, declared)
    return locked({
        get_name=function() return name end,
        get_return_type=function() return type_ref(returned) end,
        get_num_params=function() return declared or #parameters end,
        get_param_types=function() return parameters end,
        get_param_names=function() return {} end,
        is_static=function() return false end,
    })
end
sdk=locked({
    find_type_definition=function(name)
        lookups=lookups+1
        if finder then return finder(name) end
        return definitions[name]
    end,
    get_tdb_version=function() return 77 end,
})
re=locked({on_frame=function(fn) callback=fn end})
json=locked({dump_file=function(path, report, indent)
    saves=saves+1; saved=report; saved_path=path
    return not fail_save
end})
log=locked({info=function(msg) logs[#logs+1]=msg end,
    error=function(msg) logs[#logs+1]=msg end})
function tick()
    local before=lookups
    frames=frames+1
    callback()
    assert(lookups-before<=2, "per-frame budget exceeded")
end
'''


def run(fixture=""):
    lua = LuaRuntime(register_eval=False, register_builtins=False)
    lua.execute(MOCK)
    lua.execute(fixture)
    lua.execute(SCRIPT)
    for _ in range(70):
        lua.globals().tick()
    return lua


class MetadataTests(unittest.TestCase):
    def test_missing_types_finish_once_and_stop(self):
        lua = run()
        g = lua.globals()
        self.assertEqual(g.lookups, 21)
        self.assertEqual(g.saves, 1)
        self.assertEqual(g.saved.counts.candidate_not_found, 21)
        self.assertEqual(g.saved.counts.api_error, 0)
        self.assertEqual(g.saved_path, "librarian_network_metadata.json")
        self.assertTrue(g.saved.complete)

    def test_signatures_and_cycles_without_any_instance_access(self):
        lua = run('''
        definitions["via.network.SessionBase"]=type_def("via.network.SessionBase", {
            method("join", "via.network.SessionBase", {type_ref("System.String")}),
        }, {{get_name=function() return "state" end,
            get_type=function() return type_ref("via.network.SessionBase") end,
            is_static=function() return false end, is_literal=function() return false end}})
        ''')
        g = lua.globals()
        self.assertEqual(g.lookups, 21)
        self.assertEqual(g.saved.counts.found, 1)
        self.assertEqual(g.saved.counts.api_error, 0)
        found = next(t for t in g.saved.types.values() if t.status == "found")
        self.assertEqual(found.methods[1].name, "join")
        self.assertEqual(found.methods[1].params[1].type, "System.String")
        self.assertEqual(found.fields[1].type, "via.network.SessionBase")

    def test_bounds_hold_for_large_connected_metadata(self):
        lua = run('''
        local many, fields, params = {}, {}, {}
        for i=1,30 do params[i]=type_ref("System.Int32") end
        for i=1,140 do many[i]=method("m"..i, "via.network.Child"..i, params) end
        for i=1,70 do fields[i]={get_name=function() return "f" end,
            get_type=function() return type_ref("System.Int32") end,
            is_static=function() return true end,is_literal=function() return false end} end
        finder=function(name)
            if name=="via.network.SessionBase" then return type_def(name,many,fields) end
            return type_def(name)
        end
        ''')
        g = lua.globals()
        self.assertEqual(g.lookups, 128)
        self.assertEqual(g.saves, 1)
        self.assertEqual(g.saved.counts.methods_omitted, 12)
        self.assertEqual(g.saved.counts.fields_omitted, 6)
        self.assertEqual(g.saved.counts.params_omitted, 128 * 14)
        self.assertGreater(g.saved.counts.type_limit_hits, 0)

    def test_api_failure_never_copies_raw_exception(self):
        lua = run('''finder=function() error("PRIVATE_TOKEN_AND_ADDRESS") end''')
        g = lua.globals()
        self.assertEqual(g.saved.counts.api_error, 21)
        for error in g.saved.errors.values():
            self.assertEqual(error.stage, "find_type_definition")
            self.assertEqual(error.kind, "api_error")
            self.assertNotIn("PRIVATE", str(list(error.items())))

    def test_failed_save_does_not_retry_each_frame(self):
        lua = run("fail_save=true")
        self.assertEqual(lua.globals().saves, 1)
        self.assertIn("impossible", lua.globals().logs[1])


if __name__ == "__main__":
    unittest.main()

import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("discover", Path(__file__).with_name("discover-network-types.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DiscoveryTests(unittest.TestCase):
    def test_candidates_are_evidence_not_runtime_claims(self):
        result = module.discover(b"via.network.SessionRebe\0app.NetworkRequestManager.INet_LinkSession.inviteSession\0")
        self.assertEqual(result["candidateCount"], 2)
        self.assertFalse(result["runtimeValidated"])
        self.assertEqual(result["candidates"][0]["name"], "app.NetworkRequestManager.INet_LinkSession")
        self.assertEqual(result["candidates"][0]["evidence"], "inferred_declaring_type_from_member_string")

    def test_excludes_neighboring_values_and_partial_identifiers(self):
        data = b"Authorization: PRIVATE_VALUE\0xvia.network.SessionRebe\0via.network.SessionRebe\0PRIVATE_VALUE"
        result = module.discover(data)
        self.assertEqual(result["symbolCount"], 1)
        self.assertNotIn("PRIVATE_VALUE", str(result))

    def test_deduplicates_and_ignores_unrelated_types(self):
        result = module.discover(b"via.network.SessionRebe\0via.network.SessionRebe\0via.MusicSession\0")
        self.assertEqual(result["candidateCount"], 1)

    def test_incomplete_or_overlong_identifiers_are_not_candidates(self):
        self.assertEqual(module.discover(b"via.network." + b"A" * 170 + b"\0")["candidateCount"], 0)
        self.assertEqual(module.discover(b"via.network.SessionRebe")["candidateCount"], 0)


if __name__ == "__main__":
    unittest.main()

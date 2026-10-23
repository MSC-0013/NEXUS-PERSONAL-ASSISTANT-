import os
import json
import unittest

CONTRACT_PATH = os.path.join(os.path.dirname(__file__), "..", "training", "contracts", "agent-contract-v1.json")

def validate_schema(data, schema):
    """
    Minimal zero-dependency JSON Schema Draft-07 validator for agent-contract-v1.json.
    Verifies type, required, enum, additionalProperties, minLength, maxLength, minimum, maximum.
    """
    if "oneOf" in schema:
        matches = 0
        errors = []
        for s in schema["oneOf"]:
            try:
                validate_schema(data, s)
                matches += 1
            except ValueError as e:
                errors.append(str(e))
        if matches == 1:
            return True
        elif matches == 0:
            raise ValueError(f"Data matches no schema in oneOf. Sub-errors: {errors}")
        else:
            raise ValueError(f"Data matches {matches} schemas in oneOf (must match exactly 1)")

    if "type" in schema:
        t = schema["type"]
        if t == "object":
            if not isinstance(data, dict):
                raise ValueError(f"Expected object, got {type(data).__name__}")
            if "required" in schema:
                for req in schema["required"]:
                    if req not in data:
                        raise ValueError(f"Missing required property '{req}'")
            if schema.get("additionalProperties") is False:
                props = schema.get("properties", {})
                for k in data:
                    if k not in props:
                        raise ValueError(f"Disallowed additional property '{k}'")
            if "properties" in schema:
                for k, prop_val in data.items():
                    if k in schema["properties"]:
                        validate_schema(prop_val, schema["properties"][k])
        elif t == "string":
            if not isinstance(data, str):
                raise ValueError(f"Expected string, got {type(data).__name__}")
            if "enum" in schema and data not in schema["enum"]:
                raise ValueError(f"Value '{data}' not in enum {schema['enum']}")
            if "minLength" in schema and len(data) < schema["minLength"]:
                raise ValueError(f"String length {len(data)} < minLength {schema['minLength']}")
            if "maxLength" in schema and len(data) > schema["maxLength"]:
                raise ValueError(f"String length {len(data)} > maxLength {schema['maxLength']}")
        elif t == "integer":
            if not isinstance(data, int) or isinstance(data, bool):
                raise ValueError(f"Expected integer, got {type(data).__name__}")
            if "minimum" in schema and data < schema["minimum"]:
                raise ValueError(f"Integer {data} < minimum {schema['minimum']}")
            if "maximum" in schema and data > schema["maximum"]:
                raise ValueError(f"Integer {data} > maximum {schema['maximum']}")

    return True

class TestContractParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        self_path = os.path.abspath(CONTRACT_PATH)
        assert os.path.exists(self_path), f"Contract file missing: {self_path}"
        with open(self_path, "r", encoding="utf-8") as f:
            cls.schema = json.load(f)

    def test_schema_structure(self):
        self.assertEqual(self.schema.get("title"), "NexusTurnResponse")
        self.assertIn("oneOf", self.schema)
        self.assertEqual(len(self.schema["oneOf"]), 8)  # final + 7 tools

    def test_positive_final_response(self):
        doc = {"kind": "final", "content": "Operation completed successfully."}
        self.assertTrue(validate_schema(doc, self.schema))

    def test_positive_get_current_time(self):
        doc1 = {"kind": "tool_call", "name": "get_current_time", "arguments": {}}
        doc2 = {"kind": "tool_call", "name": "get_current_time", "arguments": {"timezone": "Asia/Kolkata"}}
        self.assertTrue(validate_schema(doc1, self.schema))
        self.assertTrue(validate_schema(doc2, self.schema))

    def test_positive_calculate(self):
        doc = {"kind": "tool_call", "name": "calculate", "arguments": {"expression": "(42 * 17) + 12"}}
        self.assertTrue(validate_schema(doc, self.schema))

    def test_positive_search_knowledge(self):
        doc = {"kind": "tool_call", "name": "search_knowledge", "arguments": {"query": "vector index architecture", "limit": 10}}
        self.assertTrue(validate_schema(doc, self.schema))

    def test_positive_read_workspace_file(self):
        doc = {"kind": "tool_call", "name": "read_workspace_file", "arguments": {"relative_path": "src/gateway.ts"}}
        self.assertTrue(validate_schema(doc, self.schema))

    def test_positive_create_task(self):
        doc = {"kind": "tool_call", "name": "create_task", "arguments": {"goal": "Index repository files for search."}}
        self.assertTrue(validate_schema(doc, self.schema))

    def test_positive_propose_workspace_write(self):
        doc = {
            "kind": "tool_call",
            "name": "propose_workspace_write",
            "arguments": {
                "relative_path": "README.md",
                "proposed_content": "# NEXUS Project Documentation"
            }
        }
        self.assertTrue(validate_schema(doc, self.schema))

    def test_positive_propose_workspace_patch(self):
        doc = {
            "kind": "tool_call",
            "name": "propose_workspace_patch",
            "arguments": {
                "relative_path": "package.json",
                "target_snippet": "\"version\": \"1.0.0\"",
                "replacement_snippet": "\"version\": \"1.0.1\""
            }
        }
        self.assertTrue(validate_schema(doc, self.schema))

    def test_negative_extra_properties(self):
        doc = {"kind": "final", "content": "Hi", "extra_injection": "malicious"}
        with self.assertRaises(ValueError):
            validate_schema(doc, self.schema)

    def test_negative_unknown_tool(self):
        doc = {"kind": "tool_call", "name": "run_shell", "arguments": {"command": "ls"}}
        with self.assertRaises(ValueError):
            validate_schema(doc, self.schema)

    def test_negative_missing_required_arguments(self):
        doc = {"kind": "tool_call", "name": "calculate", "arguments": {}}
        with self.assertRaises(ValueError):
            validate_schema(doc, self.schema)

    def test_negative_type_mismatch(self):
        doc = {"kind": "tool_call", "name": "search_knowledge", "arguments": {"query": "test", "limit": "five"}}
        with self.assertRaises(ValueError):
            validate_schema(doc, self.schema)

    def test_negative_content_overflow(self):
        overflow_content = "X" * 4097
        doc = {
            "kind": "tool_call",
            "name": "propose_workspace_write",
            "arguments": {
                "relative_path": "big.txt",
                "proposed_content": overflow_content
            }
        }
        with self.assertRaises(ValueError):
            validate_schema(doc, self.schema)

if __name__ == "__main__":
    unittest.main()

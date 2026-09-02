import math
import unittest

import pandas as pd

from app import app
from modules.leveling.routes import normalize_saved_circuits, parse_circuit_path
from modules.leveling.core.circuit_detection import find_fixed_to_fixed_paths
from modules.leveling.core.control_points import apply_anchor_elevation, validate_control_points
from modules.leveling.core.leg_computation import validate_field_data


class ValidationRegressionTests(unittest.TestCase):
    def test_fractional_sequence_is_discarded_instead_of_truncated(self):
        source = pd.DataFrame(
            [
                {"RunID": "R1", "Sequence": 1, "PointID": "A", "Raw_Elevation": 10},
                {"RunID": "R1", "Sequence": 1.5, "PointID": "B", "Raw_Elevation": 11},
                {"RunID": "R1", "Sequence": 2, "PointID": "C", "Raw_Elevation": 12},
            ]
        )

        validated, errors, warnings = validate_field_data(source)

        self.assertEqual(validated["Sequence"].tolist(), [1, 2])
        self.assertFalse(errors)
        self.assertTrue(any("non-integer Sequence" in warning for warning in warnings))

    def test_non_finite_observation_and_control_are_rejected(self):
        field = pd.DataFrame(
            [
                {"RunID": "R1", "Sequence": 1, "PointID": "A", "Raw_Elevation": 10},
                {"RunID": "R1", "Sequence": 2, "PointID": "B", "Raw_Elevation": math.inf},
            ]
        )
        control = pd.DataFrame(
            [{"PointID": "A", "Elevation": math.inf, "Fixed": "Y"}]
        )

        validated_field, field_errors, _ = validate_field_data(field)
        validated_control, control_errors, _ = validate_control_points(control)

        self.assertTrue(validated_field.empty)
        self.assertTrue(field_errors)
        self.assertTrue(validated_control.empty)
        self.assertTrue(control_errors)

    def test_non_finite_anchor_is_rejected(self):
        control = pd.DataFrame([{"PointID": "A", "Elevation": 10.0, "Fixed": "N"}])
        updated, errors = apply_anchor_elevation(control, "A", "nan")

        self.assertTrue(errors)
        self.assertEqual(updated.iloc[0]["Fixed"], "N")


class CircuitStateRegressionTests(unittest.TestCase):
    def test_circuit_state_requires_expected_shapes(self):
        with self.assertRaises(ValueError):
            normalize_saved_circuits({"Circuit_ID": "CIR-1", "Path": []})
        with self.assertRaises(ValueError):
            parse_circuit_path('{"not": "a path"}')
        with self.assertRaises(ValueError):
            normalize_saved_circuits([{"Circuit_ID": "CIR-1", "Path": [{"bad": 1}]}])

    def test_path_deduplication_preserves_distinct_routes(self):
        graph = {
            "A": ["B", "C"],
            "B": ["A", "C", "D"],
            "C": ["A", "B", "D"],
            "D": ["B", "C"],
        }

        paths = find_fixed_to_fixed_paths(graph, {"A", "D"})
        canonical_paths = {min(tuple(path), tuple(reversed(path))) for path in paths}

        self.assertIn(("A", "B", "D"), canonical_paths)
        self.assertIn(("A", "C", "D"), canonical_paths)
        self.assertIn(("A", "B", "C", "D"), canonical_paths)
        self.assertIn(("A", "C", "B", "D"), canonical_paths)

    def test_malformed_post_state_is_reported_instead_of_raising(self):
        app.config.update(TESTING=True)
        response = app.test_client().post(
            "/leveling/",
            data={
                "action": "process",
                "saved_circuits_json": "not-json",
                "current_circuit_path_json": "[]",
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Unexpected error while processing the file", response.data)

    def test_circuit_json_is_html_attribute_escaped(self):
        app.config.update(TESTING=True)
        response = app.test_client().post(
            "/leveling/",
            data={
                "action": "process",
                "saved_circuits_json": '[{"Circuit_ID":"CIR-1","Path":["A\' autofocus onfocus=alert(1) x=\'"]}]',
                "current_circuit_path_json": "[]",
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertNotIn(b"A' autofocus onfocus=alert(1) x='", response.data)
        self.assertIn(b"&#39; autofocus onfocus=alert(1) x=&#39;", response.data)


if __name__ == "__main__":
    unittest.main()

import unittest

from app import app
from modules.bridge.core.deflection import build_profile, fit_parabola


class DeflectionCoreTests(unittest.TestCase):
    def test_fit_parabola_recovers_symmetric_peak(self):
        points = [
            {"station": 0, "deflection": 0},
            {"station": 75, "deflection": 1.05},
            {"station": 150, "deflection": 0},
        ]

        coefficients, r_squared = fit_parabola(points)

        self.assertAlmostEqual(r_squared, 1.0, places=6)
        # A parabola through these 3 points peaks at the midpoint station.
        a, b, c = coefficients
        peak_station = -b / (2 * a)
        self.assertAlmostEqual(peak_station, 75.0, places=3)

    def test_build_profile_endpoints_match_input_stations(self):
        points = [
            {"station": 0, "deflection": 0},
            {"station": 75, "deflection": 1.05},
            {"station": 150, "deflection": 0},
        ]

        stations, deflections = build_profile(points, intervals=4)

        self.assertEqual(len(stations), 5)
        self.assertAlmostEqual(stations[0], 0.0)
        self.assertAlmostEqual(stations[-1], 150.0)
        self.assertAlmostEqual(deflections[0], 0.0, places=6)
        self.assertAlmostEqual(deflections[-1], 0.0, places=6)


class BridgeRoutesTests(unittest.TestCase):
    def setUp(self):
        app.config.update(TESTING=True)
        self.client = app.test_client()

    def test_index_page_served_under_bridge_prefix(self):
        response = self.client.get("/bridge/")

        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Girder and Top of Deck Deflected points", response.data)

    def test_help_opens_the_user_manual(self):
        index = self.client.get("/bridge/")
        self.assertIn(b'href="/bridge/manual"', index.data)

        response = self.client.get("/bridge/manual")

        self.assertEqual(response.status_code, 200)
        self.assertIn(b"User Manual", response.data)
        for anchor in (b'id="overhang"', b'id="exports"', b'id="methods"', b'id="troubleshooting"'):
            self.assertIn(anchor, response.data)

    def test_health_endpoint(self):
        response = self.client.get("/bridge/api/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"status": "ok"})

    def test_fit_parabola_endpoint_rejects_too_few_points(self):
        response = self.client.post(
            "/bridge/api/fit-parabola",
            json={"points": [{"station": 0, "deflection": 0}]},
        )

        self.assertEqual(response.status_code, 400)

    def test_build_profile_endpoint_rejects_out_of_range_intervals(self):
        response = self.client.post(
            "/bridge/api/build-profile",
            json={
                "points": [
                    {"station": 0, "deflection": 0},
                    {"station": 1, "deflection": 1},
                    {"station": 2, "deflection": 0},
                ],
                "intervals": 999,
            },
        )

        self.assertEqual(response.status_code, 400)

    def test_build_profile_endpoint_happy_path(self):
        response = self.client.post(
            "/bridge/api/build-profile",
            json={
                "points": [
                    {"station": 0, "deflection": 0},
                    {"station": 75, "deflection": 1.05},
                    {"station": 150, "deflection": 0},
                ],
                "intervals": 4,
            },
        )

        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(len(body["profile"]), 5)


if __name__ == "__main__":
    unittest.main()

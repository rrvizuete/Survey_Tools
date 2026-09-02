import unittest

from app import app


class ToolboxShellTests(unittest.TestCase):
    def setUp(self):
        app.config.update(TESTING=True)
        self.client = app.test_client()

    def test_home_lists_registered_modules(self):
        response = self.client.get("/")

        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Survey Toolbox", response.data)
        self.assertIn(b"Leveling Adjustment", response.data)
        self.assertIn(b"/leveling/", response.data)
        self.assertIn(b"Bridge Superstructure", response.data)
        self.assertIn(b"/bridge/", response.data)

    def test_leveling_module_is_mounted_under_its_prefix(self):
        response = self.client.get("/leveling/")

        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Leveling Adjustment", response.data)

    def test_bridge_module_is_mounted_under_its_prefix(self):
        response = self.client.get("/bridge/")

        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Girder and Top of Deck Deflected points", response.data)


if __name__ == "__main__":
    unittest.main()

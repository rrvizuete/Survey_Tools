import os

from flask import Flask

from toolbox import toolbox_bp
from modules.leveling import leveling_bp
from modules.bridge import bridge_bp


def create_app() -> Flask:
    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024

    app.register_blueprint(toolbox_bp)
    app.register_blueprint(leveling_bp, url_prefix="/leveling")
    app.register_blueprint(bridge_bp, url_prefix="/bridge")

    return app


app = create_app()

if __name__ == "__main__":
    app.run(debug=os.environ.get("FLASK_DEBUG", "").lower() in {"1", "true", "yes"})

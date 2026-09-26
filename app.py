import os
import socket

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


def _find_available_port(preferred: int, host: str = "127.0.0.1", attempts: int = 20) -> int:
    """Return `preferred` if it's free, otherwise the next free port after it.

    Other local software (e.g. Bentley ProjectWise Drive) can already be
    bound to 5000, which makes the dev server fail outright on Windows
    instead of just picking another port. Probe with a throwaway socket
    rather than trying app.run() repeatedly, so nothing is left half-started.
    """
    for port in range(preferred, preferred + attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind((host, port))
            except OSError:
                continue
            return port
    return preferred


app = create_app()

if __name__ == "__main__":
    debug = os.environ.get("FLASK_DEBUG", "").lower() in {"1", "true", "yes"}
    preferred_port = int(os.environ.get("PORT", "5000"))
    port = _find_available_port(preferred_port)
    if port != preferred_port:
        print(f"Port {preferred_port} is in use, starting on {port} instead.")
    app.run(debug=debug, port=port)

from flask import Blueprint

bridge_bp = Blueprint(
    "bridge",
    __name__,
    template_folder="templates",
    static_folder="static",
)

from . import routes  # noqa: E402  (registers routes on bridge_bp)

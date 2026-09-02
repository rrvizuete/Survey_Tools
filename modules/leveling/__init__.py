from flask import Blueprint

leveling_bp = Blueprint(
    "leveling",
    __name__,
    template_folder="templates",
    static_folder="static",
)

from . import routes  # noqa: E402  (registers routes on leveling_bp)

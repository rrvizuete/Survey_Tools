from flask import Blueprint

toolbox_bp = Blueprint(
    "toolbox",
    __name__,
    template_folder="templates",
)

from . import routes  # noqa: E402  (registers routes on toolbox_bp)

from flask import render_template, url_for

from . import toolbox_bp

TOOLS = [
    {
        "name": "Leveling Adjustment",
        "description": "Field review, blunder detection, and network/circuit least-squares adjustment.",
        "endpoint": "leveling.index",
        "status": "available",
    },
    {
        "name": "Bridge Superstructure",
        "description": "Girder/top-of-deck deflection profiles and plan-view geometry.",
        "endpoint": "bridge.index",
        "status": "available",
    },
]


@toolbox_bp.route("/")
def home():
    tools = [
        {
            **tool,
            "url": url_for(tool["endpoint"]) if tool["endpoint"] else None,
        }
        for tool in TOOLS
    ]
    return render_template("toolbox/home.html", tools=tools)

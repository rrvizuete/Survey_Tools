# Bridge sample data (local only)

Drop real project files here for local testing of the Deflected Deck workflow:

- the **top-of-deck DTM** as a LandXML surface (`.xml`)
- the **girder data sheet** (`.xlsx`) matching the Download Template columns

Everything in this folder except this README is gitignored, so real project
data stays out of the repository. If a file should become a permanent test
fixture, add it explicitly with `git add -f <path>` and confirm it contains no
client-sensitive information first.

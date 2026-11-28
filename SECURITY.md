# Security

Please report vulnerabilities privately: on the repository's **Security** tab, choose **Report a
vulnerability**. Do not open a public issue for them.

Supported: the latest released version (0.x). Fixes ship as a new npm version, which LayerMap's
launcher installs within an hour of a session running.

LayerMap's tools only read the repository and its map. It runs locally, makes no network requests
but npm's, to install and update itself, and stores maps only in the user cache (see
[PRIVACY.md](PRIVACY.md)).

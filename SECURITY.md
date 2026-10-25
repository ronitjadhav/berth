# Security

## Reporting a vulnerability

Please report it privately: on GitHub, open the **Security** tab of this repository and choose **Report a vulnerability**. Do not open a public issue.

Include the GNOME Shell and Docker versions, what you did and what happened. You will get an answer within a week.

## Scope

Berth runs the local `docker` CLI on behalf of the logged-in user and opens a terminal, file manager or browser when asked. It makes no network requests of its own. Issues worth reporting include:

- a container name, label, path or other Docker output that makes Berth run a command the user did not ask for
- secrets (environment variables, credentials) shown in the menu or written to logs
- anything that survives disabling the extension: processes, timers, signal handlers

Only the latest release is supported.

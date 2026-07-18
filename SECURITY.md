# Security Policy

## Trust model

This server gives its MCP client (an AI assistant) full read/write access to whatever
project directory you point it at via `set_project` / `--project`, plus the ability to
launch processes for playtesting (NW.js) and to serve project files over HTTP/HTTPS. There
is **no authentication, authorization, or sandboxing** — anything that can reach the server
can call any tool. This is intentional for a local developer tool, but it means the server
is only as safe as the boundary around it:

- **stdio mode** (the default): the server is a child process of your MCP client, reachable
  only by that client. This is the trust boundary — don't run it as a shared/system service.
- **`--http` mode**: binds to `127.0.0.1` only and rejects connections whose remote address
  isn't loopback, so it is not reachable from your network by default. **Do not** put it
  behind a reverse proxy, port-forward it, or tunnel it (e.g. ngrok) to the public internet —
  doing so would give unauthenticated file read/write and process-launch access to anyone
  who finds the URL. If you need remote access, add authentication in front of it yourself;
  the server does not provide any.
- The self-signed TLS certificate in `--http` mode is for encrypting localhost traffic
  against other local processes, not for identity verification — it does not indicate the
  server is safe to expose beyond your own machine.

## Backups

Every file the server modifies is snapshotted to `<project>/.mcp-backups/` before its first
change each session (see the README). This protects against the AI client making a mistake,
not against a malicious actor — anyone with server access could also read or delete backups.

## Reporting a vulnerability

If you find a security issue in this server itself (e.g. a path traversal that escapes the
selected project directory, a way to reach the HTTP listener from outside localhost despite
the guard, or similar), please open a GitHub issue. For anything you believe should not be
public until fixed, contact the maintainer directly via their GitHub profile rather than
filing a public issue.

This is a community-maintained tool with no SLA on response time.

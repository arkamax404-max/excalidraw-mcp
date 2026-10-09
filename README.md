# excalidraw-mcp

MCP server (stdio) that lets any agent create, list, read and delete Excalidraw
diagrams in a self-hosted Excalidraw deployment, acting as a single configured user.

The server talks to the Excalidraw HTTP API over a session login, so the deployment
must expose the standard authenticated endpoints (`/api/auth/login`, `/api/files`,
`/api/ai/diagram`).

## Requirements

- Node.js >= 20
- A reachable Excalidraw server and an active user account on it

## Configuration

The MCP reads its connection settings from an environment file. Copy `.env.example`
to `.env` and fill it in:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `EXCALIDRAW_BASE_URL` | no | `http://localhost:3030` | Base URL of the Excalidraw server |
| `EXCALIDRAW_USERNAME` | yes | — | User that owns the generated diagrams |
| `EXCALIDRAW_PASSWORD` | yes | — | Password of that user |
| `EXCALIDRAW_TIMEOUT_MS` | no | `30000` | Per-request timeout |

`.env` is git-ignored. Never commit real credentials.

## Development

```bash
npm install
npm run build
npm test
```

## Status

Under construction. Task plan: `odd/tasks/excalidraw-mcp.md`.

# Connecting AI agents

The server is a local **stdio** MCP server: the agent starts it as a child process and
talks JSON-RPC over stdin/stdout. Every MCP-capable desktop or terminal agent can run it.
It answers both 2026-07-28 clients (stateless `server/discover`) and clients still on the
2025 `initialize` handshake. It can also run on its own and serve a local URL
(`http://localhost:8080/mcp`) for clients that connect instead: see
[Local URL (HTTP mode)](#local-url-http-mode).

Replace `/ABS/PATH/QuickBase-MCP-Server` with the absolute path of this folder
(Windows: `C:\\Tools\\QuickBase-MCP-Server`, with double backslashes in JSON).
Build once with `npm ci` in the clone. Two alternatives to the absolute path:

- after `npm link` in the clone: `"command": "quickbase-mcp"` with no `args` (macOS/Linux; on
  Windows the `.cmd` shim is not started by every client, so keep `node` + the full path);
- without a clone: `"command": "npx", "args": ["-y", "github:YousifStellantis/QuickBase-MCP-Server"]`
  (needs git access to the repository; the first start builds it).

Keep tokens out of files you commit: use the client's secret/input mechanism, an
environment variable, or a gitignored `.env` next to a `quickbase-mcp.config.json`.

## Claude Code

```bash
claude mcp add quickbase --scope user \
  -e QB_REALM=yourcompany.quickbase.com \
  -e QB_USER_TOKEN="$QB_USER_TOKEN" \
  -e QB_APP_ID=bxxxxxxxx \
  -- node /ABS/PATH/QuickBase-MCP-Server/build/index.js
```

Project-scoped alternative (`.mcp.json` in the repo; `${VAR}` is expanded from your shell):

```json
{
  "mcpServers": {
    "quickbase": {
      "command": "node",
      "args": ["/ABS/PATH/QuickBase-MCP-Server/build/index.js"],
      "env": {
        "QB_REALM": "yourcompany.quickbase.com",
        "QB_USER_TOKEN": "${QB_USER_TOKEN}",
        "QB_APP_ID": "bxxxxxxxx",
        "QB_WORKSPACE": "."
      }
    }
  }
}
```

Skills as native Claude Code skills (until Claude Code implements the MCP Skills
extension): `node /ABS/PATH/QuickBase-MCP-Server/build/index.js install-skills --dir .claude/skills`.
Prompts appear as `/mcp__quickbase__build-code-page` etc.

## Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS),
`%APPDATA%\Claude\claude_desktop_config.json` (Windows), `~/.config/Claude/claude_desktop_config.json` (Linux):

```json
{
  "mcpServers": {
    "quickbase": {
      "command": "node",
      "args": ["/ABS/PATH/QuickBase-MCP-Server/build/index.js"],
      "env": {
        "QB_REALM": "yourcompany.quickbase.com",
        "QB_USER_TOKEN": "your-service-account-token",
        "QB_APP_ID": "bxxxxxxxx",
        "QB_WORKSPACE": "/ABS/PATH/your-code-pages-repo"
      }
    }
  }
}
```

Fully quit and restart Claude Desktop. Server logs: `~/Library/Logs/Claude/mcp-server-quickbase.log`
(macOS) or `%APPDATA%\Claude\logs\` (Windows). Set `QB_WORKSPACE`: Desktop starts servers
with a working directory you do not control.

## VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json`; the token is prompted once and stored by VS Code:

```json
{
  "inputs": [
    { "type": "promptString", "id": "qb-token", "description": "Quickbase user token", "password": true }
  ],
  "servers": {
    "quickbase": {
      "type": "stdio",
      "command": "node",
      "args": ["/ABS/PATH/QuickBase-MCP-Server/build/index.js"],
      "env": {
        "QB_REALM": "yourcompany.quickbase.com",
        "QB_USER_TOKEN": "${input:qb-token}",
        "QB_APP_ID": "bxxxxxxxx",
        "QB_WORKSPACE": "${workspaceFolder}"
      }
    }
  }
}
```

VS Code also reads a `.mcp.json` at the workspace root (top-level `mcpServers`). That format
has no `inputs`: save the token as a user environment variable and write
`"QB_USER_TOKEN": "${QB_USER_TOKEN}"`. VS Code's editor flags `${QB_USER_TOKEN}` as an unknown
variable; that warning is harmless, the value is read from the environment when the server
starts. Restart VS Code after setting the variable. If your organization restricts which MCP
servers VS Code may start (`chat.mcp.access` shows "managed by your organization"), see
[Local URL (HTTP mode)](#local-url-http-mode).

## Cursor

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "quickbase": {
      "command": "node",
      "args": ["/ABS/PATH/QuickBase-MCP-Server/build/index.js"],
      "env": { "QB_REALM": "yourcompany.quickbase.com", "QB_USER_TOKEN": "…", "QB_APP_ID": "bxxxxxxxx" }
    }
  }
}
```

If the client limits the total number of tools, trim them with
`"QB_TOOLSETS": "apps,records,codepages,skills"`.

## OpenAI Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.quickbase]
command = "node"
args = ["/ABS/PATH/QuickBase-MCP-Server/build/index.js"]
env = { QB_REALM = "yourcompany.quickbase.com", QB_USER_TOKEN = "…", QB_APP_ID = "bxxxxxxxx" }
```

## Gemini CLI

`~/.gemini/settings.json` (or `.gemini/settings.json` in a project):

```json
{
  "mcpServers": {
    "quickbase": {
      "command": "node",
      "args": ["/ABS/PATH/QuickBase-MCP-Server/build/index.js"],
      "env": { "QB_REALM": "yourcompany.quickbase.com", "QB_USER_TOKEN": "$QB_USER_TOKEN", "QB_APP_ID": "bxxxxxxxx" },
      "timeout": 60000
    }
  }
}
```

## Windsurf, LM Studio, JetBrains AI Assistant, Goose, others

Most clients accept the same `mcpServers` block as Claude Desktop:

- Windsurf: `~/.codeium/windsurf/mcp_config.json`.
- LM Studio (fully local models): Program > Install > Edit `mcp.json`.
- JetBrains AI Assistant: Settings > Tools > AI Assistant > Model Context Protocol > Add (paste the JSON).
- Goose: `goose configure` > Add Extension > Command-line Extension, command
  `node /ABS/PATH/QuickBase-MCP-Server/build/index.js`, then add the environment variables.

Smaller local models call tools less reliably; keep `QB_ALLOW_WRITES` off with them and
trim toolsets so the tool list stays short.

## Local URL (HTTP mode)

Use this when the client, or your organization's policy, connects to a local MCP server at a
URL instead of starting one. Start the server in a terminal and keep it open while you work.
It prints `QuickBase MCP Server is running at http://localhost:8080/mcp`.

Windows (PowerShell). Save the token once as a user environment variable, so it never sits in
a file, then open a new terminal:

```powershell
setx QB_USER_TOKEN "<token>"
```

Then, each time you start the server:

```powershell
$env:QB_REALM = "yourcompany.quickbase.com"
$env:QB_APP_ID = "bxxxxxxxx"
$env:QB_WORKSPACE = "C:\path\to\your-code-pages-repo"
$env:HTTPS_PROXY = "http://HOST:PORT"   # only behind a corporate proxy
node C:\Tools\QuickBase-MCP-Server\build\index.js http
```

macOS / Linux:

```bash
QB_REALM=yourcompany.quickbase.com QB_USER_TOKEN="$QB_USER_TOKEN" QB_APP_ID=bxxxxxxxx \
  QB_WORKSPACE=/ABS/PATH/your-code-pages-repo node /ABS/PATH/QuickBase-MCP-Server/build/index.js http
```

Then connect the client to `http://localhost:8080/mcp`:

- **VS Code**, `.vscode/mcp.json`:

  ```json
  { "servers": { "quickbase": { "type": "http", "url": "http://localhost:8080/mcp" } } }
  ```

  If your organization publishes its own entry for a local server at `http://localhost:8080/mcp`
  in VS Code's MCP server list (Extensions view, search `@mcp`), install that entry instead: it
  connects to the same address.
- **Claude Code**: `claude mcp add --transport http quickbase http://localhost:8080/mcp`
- **Others**: any client that supports Streamable HTTP, with the same URL.

`--port <n>` or `QB_HTTP_PORT` changes the port. The server answers only on this computer
(127.0.0.1 and ::1) and refuses requests whose `Host` or `Origin` header is not local. Any
program running on the computer can call it while it runs, so stop it (Ctrl+C) when you're done.

## Check the setup

```bash
QB_REALM=yourcompany.quickbase.com QB_USER_TOKEN=… QB_APP_ID=bxxxxxxxx node build/index.js doctor
```

Then, in the agent: "Run test_connection".

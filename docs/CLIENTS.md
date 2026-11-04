# Connecting AI agents

The server is a local **stdio** MCP server: the agent starts it as a child process and
talks JSON-RPC over stdin/stdout. Every MCP-capable desktop or terminal agent can run it.
It answers both 2026-07-28 clients (stateless `server/discover`) and clients still on the
2025 `initialize` handshake.

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

## Check the setup

```bash
QB_REALM=yourcompany.quickbase.com QB_USER_TOKEN=… QB_APP_ID=bxxxxxxxx node build/index.js doctor
```

Then, in the agent: "Run test_connection".

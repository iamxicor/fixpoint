# Fixpoint Claude Code plugin

Skills: `/fixpoint:init`, `/fixpoint:scan`, `/fixpoint:optimize-screen`, `/fixpoint:optimize-app`, `/fixpoint:baseline`, `/fixpoint:report`.
The MCP server (`fixpoint_*` tools) wraps the harness; the skills tell the agent how to use it and what it is allowed to change.

Local install from a clone of the Fixpoint repo (after `pnpm install && pnpm build`):

```bash
claude --plugin-dir /path/to/fixpoint/plugin
```

The MCP server resolves the app from `CLAUDE_PROJECT_DIR`; open Claude Code in the React Native app's directory.

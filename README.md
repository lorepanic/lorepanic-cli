# lorepanic

Sync your [LorePanic](https://lorepanic.com) campaigns to a local folder of
markdown that coding agents (Claude Code, Codex, OpenCode) understand natively.

Your campaign becomes a repo: documents, notes, characters, and session
transcripts as plain files, with an `AGENTS.md` so any agent knows the layout.
Write prep notes in your own editor, push them back, and they are indexed and
searchable in LorePanic at the table.

## Install

```bash
npm install -g lorepanic
# or one-off:
npx lorepanic login
```

Requires Node 20+.

## Usage

```bash
lorepanic login                 # device-code flow, approve in the browser
lorepanic pull                  # materialize a campaign into ./<campaign-slug>/
lorepanic push                  # send changed or new notes/ files back
lorepanic sync                  # push, then pull
lorepanic campaigns             # list your campaigns
lorepanic logout                # forget local credentials
```

## Workspace layout

```
my-campaign/
  AGENTS.md                 # generated: layout + conventions for agents
  CLAUDE.md                 # points Claude Code at AGENTS.md
  .claude/skills/           # prep-session, recap, npc
  .lorepanic/state.json     # sync bookkeeping (do not edit)
  documents/<category>/     # source material (read-only)
  notes/                    # your notes (editable, two-way sync)
  characters/<type>/        # PCs and NPCs (read-only for now)
  sessions/<nn>-<name>/     # session notes + transcripts (read-only)
```

Every synced file carries front-matter with the server entity `id`. New `.md`
files you drop into `notes/` are created server-side on the next push.

## Conflicts

Sync is optimistic and never silently overwrites:

- `pull` onto a locally edited file writes the server version next to it as
  `<name>.remote.md` and tells you.
- `push` of a note that changed server-side is rejected; merge, then
  `lorepanic push --force` (the server keeps full version history either way).
- `push --prune` deletes notes on the server whose local files you removed.

## Notes

- The CLI talks to `https://lorepanic.com` by default; use
  `lorepanic login --api-url http://localhost:8001` against a dev instance.
- Documents that are copies of licensed/published content are not exported;
  they stay searchable in the LorePanic app.
- `logout` removes the local credential. A server-side token management UI is
  planned; contact support if you need a token revoked in the meantime.

## Development

```bash
npm ci
npm run build
```

Issues and contributions are welcome on
[GitHub](https://github.com/lorepanic/lorepanic-cli). For account or security
questions, email [contact@lorepanic.com](mailto:contact@lorepanic.com).

import type { Manifest, ManifestEntity } from "./api.js";

/** Filesystem-safe slug: lowercase ascii, dashes, bounded length. */
export function slug(input: string): string {
  const s = input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s.length > 0 ? s : "untitled";
}

type FrontMatterValue = string | number | boolean | null | Record<string, unknown>;

/**
 * Minimal front-matter serializer. Every value is JSON-encoded, which is
 * valid YAML for strings, numbers, booleans and flow-style objects, and
 * trivially parseable back with JSON.parse.
 */
export function frontMatter(fields: Record<string, FrontMatterValue | undefined>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

export interface ParsedFrontMatter {
  fields: Record<string, unknown>;
  body: string;
}

/** Parse a file previously written by the CLI (JSON-encoded values). */
export function parseFrontMatter(content: string): ParsedFrontMatter | null {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return null;
  const fields: Record<string, unknown> = {};
  for (const line of content.slice(4, end).split("\n")) {
    const sep = line.indexOf(": ");
    if (sep === -1) continue;
    const key = line.slice(0, sep);
    try {
      fields[key] = JSON.parse(line.slice(sep + 2));
    } catch {
      fields[key] = line.slice(sep + 2);
    }
  }
  return { fields, body: content.slice(end + 5).replace(/^\n/, "") };
}

export function sessionDirName(entity: ManifestEntity): string {
  const nn =
    entity.session_number != null ? String(entity.session_number).padStart(2, "0") : "xx";
  return `${nn}-${slug(entity.title)}`;
}

export function generateAgentsMd(manifest: Manifest): string {
  const { campaign } = manifest;
  const counts = { document: 0, note: 0, character: 0, session: 0 };
  for (const e of manifest.entities) counts[e.type] += 1;

  return `# ${campaign.name}

This folder is a LorePanic campaign workspace, synced with \`lorepanic pull\`.
System: ${campaign.system}. ${campaign.description ?? ""}

## Layout

- \`documents/<category>/\`: the campaign's source material (adventures, rules,
  handouts) as markdown. ${counts.document} document(s). READ-ONLY: edits here
  are never pushed and will be flagged as conflicts on the next pull.
- \`notes/\`: the GM's campaign notes. ${counts.note} note(s). EDITABLE: change
  them, add new .md files, then run \`lorepanic push\` to sync them back.
- \`characters/<type>/\`: PCs, NPCs, monsters, items and locations.
  ${counts.character} character(s). Structured stats live in the \`data\` field
  of the front-matter; the body is free-form notes. Read-only for now.
- \`sessions/<nn>-<name>/\`: play session records (${counts.session} session(s)),
  each with \`notes.md\` (AI-structured session notes) and \`transcript.md\`
  (full table transcript) when available. Read-only.

## Conventions

- Every synced file starts with front-matter; \`id\` ties it to the server
  entity. Never edit or remove the front-matter of an existing file.
- New notes you create only need a \`title\` heading or a filename; front-matter
  is added by the CLI after the first push.
- \`.lorepanic/state.json\` is sync bookkeeping. Do not edit it.
- A \`.remote.md\` file next to one of yours means the server version changed
  while you had local edits: merge manually, then delete the \`.remote.md\`.

## Working with this campaign

You are likely a coding agent asked to help prep or recap this campaign.
Useful moves:

- Cross-reference \`documents/\` when the GM asks about canon (locations,
  NPCs, plot points).
- Read the latest \`sessions/\` folder for "what happened last time".
- Write prep output into \`notes/\` so it syncs back to the LorePanic app
  and is searchable at the table.

## Syncing

- \`lorepanic pull\`: refresh this folder from the server.
- \`lorepanic push\`: send changed or new files in \`notes/\` to the server.
- \`lorepanic sync\`: both. After writing notes for the GM, offer to run it.

Common tasks are described in \`.claude/skills/\` (prep-session, recap, npc);
non-Claude agents can read those SKILL.md files as recipes too.
`;
}

export function generateClaudeMd(): string {
  return "@AGENTS.md\n";
}

interface SkillSpec {
  name: string;
  description: string;
  body: string;
}

export const WORKSPACE_SKILLS: SkillSpec[] = [
  {
    name: "prep-session",
    description:
      "Prepare the next game session from the latest session records, open threads, and campaign documents. Use when the GM asks to prep, plan, or outline the next session.",
    body: `# Prep the next session

1. Find the most recent \`sessions/<nn>-*/notes.md\`. Extract open threads,
   unresolved hooks, and the last scene.
2. Cross-reference \`documents/\` for what canonically comes next (locations,
   NPCs, planned encounters). Quote the source file for each element.
3. Read \`notes/\` for the GM's own plans; never contradict them, build on them.
4. Write the prep to \`notes/prep-session-<nn+1>.md\` with these sections:
   - **Recap hook**: two sentences to read aloud at the table.
   - **Likely scenes**: 3-5 scenes with location, NPCs, and what can happen.
   - **NPCs on stage**: name, voice note, what they want, what they know.
   - **Contingencies**: what if the players go off-script (at least 2).
   - **Loose ends**: threads deliberately left open.
5. Offer to run \`lorepanic push\` so the prep is searchable at the table.
`,
  },
  {
    name: "recap",
    description:
      "Write a player-facing recap of the last session. Use when the GM asks for a recap, summary, or 'previously on' text.",
    body: `# Write a session recap

1. Read the latest \`sessions/<nn>-*/notes.md\` (and \`transcript.md\` for
   flavor quotes if present).
2. Write a player-facing recap: dramatic, second person plural ("you"),
   under 200 words, no GM secrets (check \`documents/\` and \`notes/\` to know
   what the players have NOT discovered yet; when unsure, leave it out).
3. End with the cliffhanger or open decision the session stopped on.
4. Save it to \`notes/recap-session-<nn>.md\` and offer to run
   \`lorepanic push\`.
`,
  },
  {
    name: "npc",
    description:
      "Create a new NPC consistent with the campaign's canon and tone. Use when the GM asks for an NPC, villain, shopkeeper, or other character.",
    body: `# Create an NPC

1. Skim \`documents/\` and \`characters/\` for the campaign's tone, naming
   style, and factions, and to avoid duplicating an existing character.
2. Ask the GM (or infer from their request) the NPC's role: ally, obstacle,
   quest giver, red herring.
3. Write the NPC to \`notes/npc-<slug>.md\`:
   - **Name and role**, one-line physical tell, voice/mannerism note.
   - **What they want** (surface) and **what they actually want** (hidden).
   - **What they know** that the party needs.
   - **Relationships** to existing NPCs or factions (cite the source file).
   - **Stat guidance**: closest SRD stat block by name, adjusted CR if needed.
4. Offer to run \`lorepanic push\`.
`,
  },
];

export function skillFile(skill: SkillSpec): string {
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}`;
}

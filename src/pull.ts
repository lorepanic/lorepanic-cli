import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

import {
  ApiClient,
  type CampaignSummary,
  type CharacterResponse,
  type Manifest,
  type ManifestEntity,
  type NoteResponse,
} from "./api.js";
import { requireCredentials } from "./config.js";
import {
  type EntityState,
  type WorkspaceState,
  findWorkspaceRoot,
  loadState,
  safeResolve,
  saveState,
  sha256,
} from "./state.js";
import {
  WORKSPACE_SKILLS,
  frontMatter,
  generateAgentsMd,
  generateClaudeMd,
  sessionDirName,
  skillFile,
  slug,
} from "./workspace.js";

export interface PullOptions {
  campaign?: string;
  dir?: string;
}

interface PullStats {
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  conflicts: number;
  skipped: string[];
}

export async function pull(opts: PullOptions): Promise<void> {
  const creds = requireCredentials();
  const api = new ApiClient(creds.apiUrl, creds.token);
  const cwd = process.cwd();

  // Resolve campaign + workspace root.
  let root = opts.dir ? join(cwd, opts.dir) : (findWorkspaceRoot(cwd) ?? cwd);
  let campaignId: string | null = null;
  const existing = loadState(root);
  if (existing && !opts.campaign) {
    campaignId = existing.campaignId;
  } else {
    const campaigns = await api.get<CampaignSummary[]>("/api/sync/campaigns");
    if (campaigns.length === 0) {
      console.error("No campaigns found for your account.");
      process.exit(1);
    }
    const chosen = await chooseCampaign(campaigns, opts.campaign);
    campaignId = chosen.id;
    if (!existing && !opts.dir) root = join(cwd, slug(chosen.name));
  }

  const manifest = await api.get<Manifest>(`/api/sync/campaigns/${campaignId}/manifest`);
  console.log(`Pulling "${manifest.campaign.name}" into ${root}`);

  const state: WorkspaceState = loadState(root) ?? {
    schemaVersion: 1,
    apiUrl: creds.apiUrl,
    campaignId: manifest.campaign.id,
    campaignName: manifest.campaign.name,
    lastPulledAt: "",
    entities: {},
  };
  if (state.campaignId !== manifest.campaign.id) {
    console.error(
      `This folder tracks a different campaign (${state.campaignName}). Use --dir to pull elsewhere.`,
    );
    process.exit(1);
  }

  const stats: PullStats = {
    added: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    conflicts: 0,
    skipped: [],
  };
  const reservedPaths = new Set<string>();
  const newEntities: Record<string, EntityState> = {};

  // Prior paths win: every tracked file keeps its path across pulls (even
  // when titles collide or manifest order shifts), and no entity may claim
  // a path another tracked file still occupies.
  for (const entity of Object.values(state.entities)) {
    for (const file of Object.values(entity.files)) reservedPaths.add(file.path);
  }

  // Note and character bodies come from their list endpoints, fetched once.
  let notesById: Map<string, NoteResponse> | null = null;
  let charactersById: Map<string, CharacterResponse> | null = null;
  const fetchNotes = async () => {
    notesById ??= new Map(
      (await api.get<NoteResponse[]>(`/api/notes/campaigns/${campaignId}`)).map((n) => [n.id, n]),
    );
    return notesById;
  };
  const fetchCharacters = async () => {
    charactersById ??= new Map(
      (await api.get<CharacterResponse[]>(`/api/characters/campaigns/${campaignId}`)).map((c) => [
        c.id,
        c,
      ]),
    );
    return charactersById;
  };

  const reserve = (path: string, id: string): string => {
    if (!reservedPaths.has(path)) {
      reservedPaths.add(path);
      return path;
    }
    const suffixed = path.replace(/\.md$/, `-${id.slice(0, 8)}.md`);
    reservedPaths.add(suffixed);
    return suffixed;
  };

  for (const entity of manifest.entities) {
    const prev = state.entities[entity.id];

    if (entity.type === "document" && entity.materializable === false) {
      stats.skipped.push(`${entity.title} (${entity.excluded_reason ?? "unavailable"})`);
      continue;
    }

    // Keep the path a part already lives at; only new parts get a computed
    // (collision-suffixed) one.
    const pathFor = (part: string, computed: string): string => {
      const prevPath = prev?.files[part]?.path;
      if (prevPath && safeResolve(root, prevPath)) return prevPath;
      return reserve(computed, entity.id);
    };

    const parts: Record<string, { path: string; fetch: () => Promise<string | null> }> = {};

    if (entity.type === "document") {
      const dir = `documents/${slug(entity.category ?? "other")}`;
      parts["content"] = {
        path: pathFor("content", `${dir}/${slug(entity.title)}.md`),
        fetch: async () => {
          const body = await api.getText(entity.content_url as string);
          return (
            frontMatter({
              id: entity.id,
              type: "document",
              title: entity.title,
              category: entity.category ?? null,
              updated_at: entity.updated_at,
              read_only: true,
            }) + body
          );
        },
      };
    } else if (entity.type === "note") {
      parts["content"] = {
        path: pathFor("content", `notes/${slug(entity.title)}.md`),
        fetch: async () => {
          const note = (await fetchNotes()).get(entity.id);
          if (!note) return null;
          return (
            frontMatter({
              id: entity.id,
              type: "note",
              title: note.title ?? "Untitled",
              note_type: note.note_type,
              session_id: note.session_id,
              updated_at: note.updated_at,
            }) + (note.content ?? "")
          );
        },
      };
    } else if (entity.type === "character") {
      const dir = `characters/${slug(entity.character_type ?? "other")}`;
      parts["content"] = {
        path: pathFor("content", `${dir}/${slug(entity.title)}.md`),
        fetch: async () => {
          const character = (await fetchCharacters()).get(entity.id);
          if (!character) return null;
          return (
            frontMatter({
              id: entity.id,
              type: "character",
              name: character.name,
              character_type: character.character_type,
              data: character.data,
              updated_at: character.updated_at,
              read_only: true,
            }) + (character.notes ?? "")
          );
        },
      };
    } else if (entity.type === "session") {
      const dir = `sessions/${sessionDirName(entity)}`;
      const meta = {
        id: entity.id,
        type: "session",
        title: entity.title,
        session_number: entity.session_number,
        played_at: entity.played_at,
        updated_at: entity.updated_at,
        read_only: true,
      };
      if (entity.has_notes) {
        parts["notes"] = {
          path: pathFor("notes", `${dir}/notes.md`),
          fetch: async () =>
            frontMatter(meta) + (await api.getText(`/api/sync/sessions/${entity.id}/notes.md`)),
        };
      }
      if (entity.has_transcript) {
        parts["transcript"] = {
          path: pathFor("transcript", `${dir}/transcript.md`),
          fetch: async () =>
            frontMatter(meta) +
            (await api.getText(`/api/sync/sessions/${entity.id}/transcript.md`)),
        };
      }
      if (Object.keys(parts).length === 0) continue;
    }

    const entityState: EntityState = { type: entity.type, updated_at: entity.updated_at, files: {} };
    const serverChanged = !prev || prev.updated_at !== entity.updated_at;

    for (const [part, spec] of Object.entries(parts)) {
      const prevFile = prev?.files[part];
      const pathChanged = prevFile && prevFile.path !== spec.path;
      const target = join(root, spec.path);

      // Local-edit detection on the previously synced path.
      let localEdit = false;
      if (prevFile) {
        const prevAbs = safeResolve(root, prevFile.path);
        if (prevAbs && existsSync(prevAbs) && sha256(readFileSync(prevAbs, "utf-8")) !== prevFile.hash) {
          localEdit = true;
        }
      }

      if (!serverChanged && prevFile && !pathChanged && existsSync(target)) {
        // Nothing to do; keep existing state (even if locally edited: push
        // or a future server change will deal with it).
        entityState.files[part] = prevFile;
        stats.unchanged += 1;
        continue;
      }

      let content = await spec.fetch();
      if (content === null) continue;
      if (!content.endsWith("\n")) content += "\n";

      if (localEdit && prevFile) {
        const remotePath = spec.path.replace(/\.md$/, ".remote.md");
        mkdirSync(dirname(join(root, remotePath)), { recursive: true });
        writeFileSync(join(root, remotePath), content);
        console.log(`  ! ${prevFile.path} has local edits; server version saved as ${remotePath}`);
        entityState.files[part] = prevFile;
        // Keep the pre-conflict timestamp: a push must still see the server
        // as "moved on" and refuse without --force.
        if (prev) entityState.updated_at = prev.updated_at;
        stats.conflicts += 1;
        continue;
      }

      if (pathChanged && prevFile) {
        const prevAbs = safeResolve(root, prevFile.path);
        if (prevAbs && existsSync(prevAbs)) unlinkSync(prevAbs);
      }

      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      entityState.files[part] = { path: spec.path, hash: sha256(content) };
      console.log(`  ${prev ? "~" : "+"} ${spec.path}`);
      if (prev) stats.updated += 1;
      else stats.added += 1;
    }

    newEntities[entity.id] = entityState;
  }

  // Entities that disappeared server-side.
  for (const [id, prev] of Object.entries(state.entities)) {
    if (newEntities[id] || id.startsWith("_")) continue;
    for (const file of Object.values(prev.files)) {
      const abs = safeResolve(root, file.path);
      if (!abs) {
        console.log(`  ! state entry for ${file.path} points outside the workspace; ignored`);
        continue;
      }
      if (!existsSync(abs)) continue;
      if (sha256(readFileSync(abs, "utf-8")) === file.hash) {
        unlinkSync(abs);
        console.log(`  - ${file.path}`);
        stats.removed += 1;
      } else {
        console.log(`  ! ${file.path} was deleted on the server but has local edits; kept`);
        stats.conflicts += 1;
      }
    }
  }

  // Generated agent docs, conflict-protected like everything else.
  const metaFiles: Array<[string, string, string]> = [
    ["_agents_md", "AGENTS.md", generateAgentsMd(manifest)],
    ["_claude_md", "CLAUDE.md", generateClaudeMd()],
    ...WORKSPACE_SKILLS.map(
      (s): [string, string, string] => [
        `_skill_${s.name}`,
        `.claude/skills/${s.name}/SKILL.md`,
        skillFile(s),
      ],
    ),
  ];
  for (const [key, relPath, content] of metaFiles) {
    const prev = state.entities[key]?.files["content"];
    const abs = join(root, relPath);
    const localEdit =
      prev && existsSync(abs) && sha256(readFileSync(abs, "utf-8")) !== prev.hash;
    if (localEdit) {
      newEntities[key] = state.entities[key];
      continue;
    }
    if (!existsSync(abs) || sha256(readFileSync(abs, "utf-8")) !== sha256(content)) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    newEntities[key] = {
      type: "meta",
      updated_at: "",
      files: { content: { path: relPath, hash: sha256(content) } },
    };
  }

  state.entities = newEntities;
  state.campaignName = manifest.campaign.name;
  state.lastPulledAt = manifest.generated_at;
  saveState(root, state);

  const summary = [
    `${stats.added} added`,
    `${stats.updated} updated`,
    `${stats.unchanged} unchanged`,
    stats.removed > 0 ? `${stats.removed} removed` : null,
    stats.conflicts > 0 ? `${stats.conflicts} conflict(s)` : null,
  ]
    .filter(Boolean)
    .join(", ");
  console.log(`Done: ${summary}.`);
  if (stats.skipped.length > 0) {
    console.log(`Skipped (not exportable): ${stats.skipped.join("; ")}`);
  }
}

async function chooseCampaign(
  campaigns: CampaignSummary[],
  wanted?: string,
): Promise<CampaignSummary> {
  if (wanted) {
    const match = campaigns.find(
      (c) => c.id === wanted || c.name.toLowerCase() === wanted.toLowerCase(),
    );
    if (!match) {
      console.error(`No campaign named "${wanted}". Available:`);
      for (const c of campaigns) console.error(`  - ${c.name} (${c.id})`);
      process.exit(1);
    }
    return match;
  }
  if (campaigns.length === 1) return campaigns[0];
  if (!process.stdin.isTTY) {
    console.error("Multiple campaigns; pass --campaign <name or id>.");
    process.exit(1);
  }
  console.log("Your campaigns:");
  campaigns.forEach((c, i) => console.log(`  ${i + 1}. ${c.name} [${c.system}]`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Pull which one? ");
  rl.close();
  const index = Number.parseInt(answer, 10) - 1;
  if (Number.isNaN(index) || index < 0 || index >= campaigns.length) {
    console.error("Invalid choice.");
    process.exit(1);
  }
  return campaigns[index];
}

export async function listCampaigns(): Promise<void> {
  const creds = requireCredentials();
  const api = new ApiClient(creds.apiUrl, creds.token);
  const campaigns = await api.get<CampaignSummary[]>("/api/sync/campaigns");
  if (campaigns.length === 0) {
    console.log("No campaigns yet. Create one at " + creds.apiUrl);
    return;
  }
  for (const c of campaigns) {
    console.log(`${c.name} [${c.system}]  ${c.id}`);
  }
}

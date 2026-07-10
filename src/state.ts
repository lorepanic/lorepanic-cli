import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export interface EntityFileState {
  path: string; // workspace-relative
  hash: string; // sha256 of the file as written by the CLI
}

export interface EntityState {
  type: string;
  updated_at: string;
  files: Record<string, EntityFileState>; // part -> file ("content" | "notes" | "transcript")
}

export interface WorkspaceState {
  schemaVersion: number;
  apiUrl: string;
  campaignId: string;
  campaignName: string;
  lastPulledAt: string;
  entities: Record<string, EntityState>;
}

export const STATE_DIR = ".lorepanic";
const STATE_FILE = "state.json";

export function statePath(root: string): string {
  return join(root, STATE_DIR, STATE_FILE);
}

export function loadState(root: string): WorkspaceState | null {
  const path = statePath(root);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as WorkspaceState;
  } catch {
    return null;
  }
}

export function saveState(root: string, state: WorkspaceState): void {
  mkdirSync(join(root, STATE_DIR), { recursive: true });
  writeFileSync(statePath(root), JSON.stringify(state, null, 2) + "\n");
}

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/** Find the workspace root: cwd if it contains .lorepanic/state.json, else null. */
export function findWorkspaceRoot(cwd: string): string | null {
  return existsSync(statePath(cwd)) ? cwd : null;
}

/**
 * Resolve a state-file-provided relative path, refusing anything that
 * escapes the workspace root. State files are plain JSON an agent (or a bug)
 * can rewrite; a traversal path must never reach unlink or write.
 */
export function safeResolve(root: string, rel: string): string | null {
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, rel);
  return abs.startsWith(rootAbs + sep) ? abs : null;
}

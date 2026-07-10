export class ApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    message?: string,
  ) {
    super(message ?? `API error ${status}: ${body.slice(0, 300)}`);
  }
}

export class ApiClient {
  constructor(
    private baseUrl: string,
    private token?: string,
  ) {}

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(body !== undefined),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error(`Could not reach ${this.baseUrl}: ${(e as Error).message}`);
    }
    if (!res.ok) throw new ApiError(res.status, await res.text());
    return res;
  }

  async get<T>(path: string): Promise<T> {
    return (await this.request("GET", path)).json() as Promise<T>;
  }

  async getText(path: string): Promise<string> {
    return (await this.request("GET", path)).text();
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return (await this.request("POST", path, body)).json() as Promise<T>;
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return (await this.request("PUT", path, body)).json() as Promise<T>;
  }

  async delete(path: string): Promise<void> {
    await this.request("DELETE", path);
  }
}

// --- API response shapes (mirror backend/app/schemas) ---

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_url: string;
  verification_url_complete: string;
  expires_at: string;
  interval: number;
}

export interface DevicePoll {
  status: "pending" | "connected" | "expired" | "denied";
  token: string | null;
  token_expires_at: string | null;
  scopes: string[] | null;
  user: { id: string; email: string | null; display_name: string | null } | null;
  interval: number | null;
}

export interface CampaignSummary {
  id: string;
  name: string;
  system: string;
  updated_at: string;
}

export interface ManifestEntity {
  type: "document" | "note" | "character" | "session";
  id: string;
  title: string;
  updated_at: string;
  category?: string | null;
  materializable?: boolean | null;
  excluded_reason?: string | null;
  size_bytes?: number | null;
  content_url?: string | null;
  note_type?: string | null;
  session_id?: string | null;
  character_type?: string | null;
  session_number?: number | null;
  session_status?: string | null;
  played_at?: string | null;
  has_transcript?: boolean | null;
  has_notes?: boolean | null;
  has_summary?: boolean | null;
}

export interface Manifest {
  schema_version: number;
  generated_at: string;
  campaign: {
    id: string;
    name: string;
    description: string | null;
    system: string;
    updated_at: string;
  };
  entities: ManifestEntity[];
}

export interface NoteResponse {
  id: string;
  campaign_id: string;
  session_id: string | null;
  title: string | null;
  content: string | null;
  note_type: string;
  created_at: string;
  updated_at: string;
}

export interface CharacterResponse {
  id: string;
  campaign_id: string;
  name: string;
  character_type: string | null;
  data: Record<string, unknown>;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

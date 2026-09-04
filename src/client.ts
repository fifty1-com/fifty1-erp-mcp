/**
 * HTTP client for the fifty1 ERP API.
 *
 * Everything the ERP can answer with is turned into either a value or an
 * ErpError carrying a message meant for the user. The distinction that matters:
 * a 422 is a business rule the ERP enforced (invalid status transition, phase
 * change on a non-lead project) and its German message is the answer — it gets
 * passed through verbatim rather than rewritten.
 */

export class ErpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ErpError";
  }
}

export interface ErpClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class ErpClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ErpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get<T = unknown>(path: string, query: Record<string, unknown> = {}): Promise<T> {
    return this.request<T>("GET", path + buildQuery(query));
  }

  post<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "AbortError"
        ? `Zeitüberschreitung nach ${this.timeoutMs / 1000}s`
        : String(error);
      throw new ErpError(`ERP nicht erreichbar (${reason})`, 0);
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    const payload = text ? safeParse(text) : null;

    if (!response.ok) {
      throw toErpError(response.status, payload, text);
    }

    return payload as T;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 500) };
  }
}

function toErpError(status: number, payload: unknown, rawText: string): ErpError {
  const body = (payload ?? {}) as { error?: string; message?: string; details?: unknown };
  const erpMessage = body.error ?? body.message ?? rawText.slice(0, 300);

  switch (status) {
    case 401:
      return new ErpError(
        "ERP-Authentifizierung fehlgeschlagen. FIFTY1_API_TOKEN prüfen (gültig? nicht widerrufen?).",
        status,
      );
    case 403:
      // The ERP names the exact permission slug — surfacing it tells the
      // operator precisely which scope the token is missing.
      return new ErpError(
        `${erpMessage}. Der verwendete API-Token hat diese Berechtigung nicht — im ERP unter Einstellungen → API Tokens ergänzen.`,
        status,
      );
    case 404:
      return new ErpError(
        `${erpMessage}. ID mit dem passenden list_*/get_*-Tool prüfen.`,
        status,
      );
    case 422:
      // A business rule of the ERP. Its German wording is the answer.
      return new ErpError(erpMessage, status, body.details);
    case 400:
      return new ErpError(erpMessage, status, body.details);
    case 405:
      return new ErpError(`${erpMessage} (falsche HTTP-Methode)`, status);
    default:
      if (status >= 500) {
        return new ErpError(
          "ERP-Server-Fehler. Bitte später erneut versuchen; bei anhaltendem Fehler die ERP-Logs prüfen.",
          status,
        );
      }
      return new ErpError(erpMessage || `Unerwartete Antwort (HTTP ${status})`, status);
  }
}

function buildQuery(query: Record<string, unknown>): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    params.append(key, String(value));
  }

  const queryString = params.toString();
  return queryString ? `?${queryString}` : "";
}

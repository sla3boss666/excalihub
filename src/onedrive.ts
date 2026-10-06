// Accès au OneDrive personnel de l'utilisateur (tourne dans le service worker).
// Connexion Microsoft (OAuth 2.0 + PKCE via chrome.identity), puis API OneDrive
// (api.onedrive.com) sur le dossier choisi. Ni mot de passe ni secret stockés :
// seulement les jetons d'accès, dans le stockage de l'extension.

const AUTH = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
const API = "https://api.onedrive.com/v1.0";
// Jeton accepté par l'API OneDrive *et* par le sélecteur OneDrive web
const SCOPES = "OneDrive.ReadWrite offline_access";
const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024; // au-delà : envoi par morceaux
// Pas de requête sans fin : une réponse qui n'arrive pas libère la file d'attente
const REQUEST_TIMEOUT_MS = 60_000;

export const CONFIG_KEY = "excalihub_od_config";
const TOKENS_KEY = "excalihub_od_tokens";

export interface OneDriveFolder {
  driveId: string;
  id: string;
  name: string;
}

interface Config {
  clientId?: string;
  folder?: OneDriveFolder;
}

interface Tokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

// Erreur transmise au content script : `code` sert à choisir l'état affiché
export class OneDriveError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

async function getConfig(): Promise<Config> {
  return ((await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY] as Config) ?? {};
}

async function setConfig(patch: Partial<Config>): Promise<void> {
  await chrome.storage.local.set({ [CONFIG_KEY]: { ...(await getConfig()), ...patch } });
}

async function getTokens(): Promise<Tokens | null> {
  return ((await chrome.storage.local.get(TOKENS_KEY))[TOKENS_KEY] as Tokens) ?? null;
}

const setTokens = (tokens: Tokens) => chrome.storage.local.set({ [TOKENS_KEY]: tokens });

// ── Connexion Microsoft ───────────────────────────────────────────────
function base64url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const randomString = (bytes: number) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));

async function requireClientId(): Promise<string> {
  const { clientId } = await getConfig();
  if (!clientId) throw new OneDriveError("not-configured", "Missing Microsoft application ID.");
  return clientId;
}

async function redeem(clientId: string, body: Record<string, string>): Promise<Tokens> {
  const res = await fetch(`${AUTH}/token`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPES, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new OneDriveError("signed-out", data.error_description ?? data.error ?? `Sign-in refused (HTTP ${res.status})`);
  }
  const tokens: Tokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? body.refresh_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  await setTokens(tokens);
  return tokens;
}

// interactive = false : reconnexion silencieuse grâce à la session Microsoft
// déjà ouverte dans le navigateur (aucune fenêtre si elle est valide).
async function authorize(interactive: boolean): Promise<Tokens> {
  const clientId = await requireClientId();
  const verifier = randomString(48);
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const state = randomString(16);
  const redirectUri = chrome.identity.getRedirectURL();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  if (!interactive) params.set("prompt", "none");

  let responseUrl: string | undefined;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({
      url: `${AUTH}/authorize?${params}`,
      interactive,
      ...(interactive ? {} : { timeoutMsForNonInteractive: 15000 }),
    });
  } catch (err) {
    throw new OneDriveError(
      "signed-out",
      interactive ? `Sign-in interrupted: ${(err as Error).message}` : "Please sign in to OneDrive again.",
    );
  }

  const answer = new URL(responseUrl ?? "about:blank").searchParams;
  if (answer.get("error")) {
    throw new OneDriveError("signed-out", answer.get("error_description") ?? answer.get("error")!);
  }
  if (answer.get("state") !== state || !answer.get("code")) {
    throw new OneDriveError("signed-out", "Invalid Microsoft sign-in response.");
  }
  return redeem(clientId, {
    grant_type: "authorization_code",
    code: answer.get("code")!,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
}

let refreshing: Promise<string> | null = null;

export async function getAccessToken(): Promise<string> {
  const clientId = await requireClientId();
  const tokens = await getTokens();
  if (!tokens) throw new OneDriveError("signed-out", "Not signed in to OneDrive.");
  if (tokens.expiresAt - 60_000 > Date.now()) return tokens.accessToken;

  refreshing ??= (async () => {
    try {
      if (!navigator.onLine) throw offline();
      if (tokens.refreshToken) {
        try {
          return (await redeem(clientId, { grant_type: "refresh_token", refresh_token: tokens.refreshToken }))
            .accessToken;
        } catch (err) {
          if (!(err instanceof OneDriveError)) throw offline(); // réseau, pas un refus
          // Jeton de rafraîchissement expiré (24 h pour ce type d'application)
        }
      }
      try {
        return (await authorize(false)).accessToken;
      } catch (err) {
        // Reconnexion silencieuse refusée : il faudra se reconnecter (sinon on
        // réessaierait sans fin avec un jeton invalide)
        if (navigator.onLine) await chrome.storage.local.remove(TOKENS_KEY);
        throw navigator.onLine ? err : offline();
      }
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

function offline(): OneDriveError {
  return new OneDriveError("network", "No internet connection: retrying automatically.");
}

// ── API OneDrive ──────────────────────────────────────────────────────
async function api(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const token = await getAccessToken();
  let res: Response;
  try {
    res = await fetch(path.startsWith("https://") ? path : `${API}${path}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
    });
  } catch {
    throw offline();
  }
  if (res.status === 401) {
    const tokens = await getTokens();
    if (retry) {
      // Jeton refusé : on force son renouvellement une fois
      if (tokens) await setTokens({ ...tokens, expiresAt: 0 });
      return api(path, init, false);
    }
    await chrome.storage.local.remove(TOKENS_KEY); // toujours refusé : reconnexion nécessaire
  }
  return res;
}

async function httpError(res: Response): Promise<OneDriveError> {
  let message = `OneDrive: HTTP error ${res.status}`;
  try {
    const data = await res.json();
    message = data?.error?.message ?? message;
  } catch {
    // Corps vide ou non JSON
  }
  if (res.status === 401 || res.status === 403) return new OneDriveError("signed-out", message);
  if (res.status === 404) return new OneDriveError("NotFoundError", message);
  return new OneDriveError(`http-${res.status}`, message);
}

async function apiJson(path: string, init?: RequestInit): Promise<any> {
  const res = await api(path, init);
  if (!res.ok) throw await httpError(res);
  return res.status === 204 ? null : res.json();
}

const enc = encodeURIComponent;

async function requireFolder(): Promise<OneDriveFolder> {
  const { folder } = await getConfig();
  if (!folder) throw new OneDriveError("no-folder", "No OneDrive folder selected.");
  return folder;
}

const itemPath = (f: OneDriveFolder) => `/drives/${enc(f.driveId)}/items/${enc(f.id)}`;
const childPath = (f: OneDriveFolder, name: string) => `${itemPath(f)}:/${enc(name)}:`;

export interface RemoteEntry {
  name: string;
  lastModified: number;
  ref: string; // id OneDrive du fichier
}

export async function listFiles(): Promise<RemoteEntry[]> {
  const folder = await requireFolder();
  const entries: RemoteEntry[] = [];
  let url = `${itemPath(folder)}/children?$select=id,name,lastModifiedDateTime,file&$top=500`;
  while (url) {
    const data = await apiJson(url);
    for (const item of data.value ?? []) {
      if (item.file) entries.push({ name: item.name, lastModified: Date.parse(item.lastModifiedDateTime), ref: item.id });
    }
    url = data["@odata.nextLink"] ?? "";
  }
  return entries;
}

export async function readFile(id: string): Promise<string> {
  const folder = await requireFolder();
  // Redirige vers une adresse de téléchargement pré-authentifiée
  const res = await api(`/drives/${enc(folder.driveId)}/items/${enc(id)}/content`);
  if (!res.ok) throw await httpError(res);
  return res.text();
}

// Date de modification du fichier écrit, telle que la liste du dossier la donnera
const lastModifiedOf = (item: any): number | null =>
  item?.lastModifiedDateTime ? Date.parse(item.lastModifiedDateTime) : null;

export async function writeFile(name: string, content: string): Promise<number | null> {
  const folder = await requireFolder();
  const body = new TextEncoder().encode(content);
  if (body.length <= SIMPLE_UPLOAD_MAX) {
    const item = await apiJson(`${childPath(folder, name)}/content`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body,
    });
    return lastModifiedOf(item);
  }

  // Gros fichier (images) : session d'envoi, morceaux multiples de 320 Kio
  const session = await apiJson(`${childPath(folder, name)}/createUploadSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      item: { "@microsoft.graph.conflictBehavior": "replace", "@name.conflictBehavior": "replace" },
    }),
  });
  const chunk = 320 * 1024 * 16;
  let item: any = null;
  for (let start = 0; start < body.length; start += chunk) {
    const end = Math.min(start + chunk, body.length);
    const res = await fetch(session.uploadUrl, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      method: "PUT",
      headers: { "Content-Range": `bytes ${start}-${end - 1}/${body.length}` },
      body: body.slice(start, end),
    });
    if (!res.ok) throw await httpError(res);
    // Dernier morceau (200 ou 201) : la réponse décrit le fichier terminé
    if (res.status !== 202) item = await res.json().catch(() => null);
  }
  return lastModifiedOf(item);
}

export async function removeFile(name: string): Promise<void> {
  const folder = await requireFolder();
  const res = await api(childPath(folder, name), { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw await httpError(res);
}

// ── Choix du dossier ──────────────────────────────────────────────────
export async function setFolder(folder: OneDriveFolder): Promise<void> {
  let name = folder.name;
  if (!name) {
    const info = await apiJson(`/drives/${enc(folder.driveId)}/items/${enc(folder.id)}?$select=name`);
    name = info.name;
  }
  await setConfig({ folder: { ...folder, name } });
}

// Navigateur de dossiers intégré (secours si le sélecteur Microsoft ne s'ouvre pas)
export async function listFolders(parentId: string | null) {
  const drive = await apiJson("/drive?$select=id");
  const base = parentId ? `/drives/${enc(drive.id)}/items/${enc(parentId)}` : `/drives/${enc(drive.id)}/root`;
  const info = await apiJson(`${base}?$select=id,name,parentReference`);
  const folders: { id: string; name: string }[] = [];
  let url = `${base}/children?$select=id,name,folder&$top=500`;
  while (url) {
    const data = await apiJson(url);
    for (const item of data.value ?? []) if (item.folder) folders.push({ id: item.id, name: item.name });
    url = data["@odata.nextLink"] ?? "";
  }
  folders.sort((a, b) => a.name.localeCompare(b.name, "fr"));
  return {
    driveId: drive.id as string,
    current: { id: info.id as string, name: parentId ? (info.name as string) : "OneDrive" },
    parentId: parentId ? ((info.parentReference?.id as string | undefined) ?? null) : null,
    folders,
  };
}

export async function createFolder(parentId: string | null, name: string) {
  const drive = await apiJson("/drive?$select=id");
  const base = parentId ? `/drives/${enc(drive.id)}/items/${enc(parentId)}` : `/drives/${enc(drive.id)}/root`;
  const item = await apiJson(`${base}/children`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "rename" }),
  });
  return { id: item.id as string, name: item.name as string };
}

// ── État et actions déclenchées depuis le panneau ─────────────────────
export async function status() {
  const config = await getConfig();
  const tokens = await getTokens();
  return {
    clientId: config.clientId ?? null,
    signedIn: !!tokens,
    folder: config.folder ?? null,
    redirectUri: chrome.identity.getRedirectURL(),
  };
}

export async function setClientId(clientId: string): Promise<void> {
  const current = await getConfig();
  if (current.clientId !== clientId) await chrome.storage.local.remove(TOKENS_KEY); // autre application
  await setConfig({ clientId });
}

export async function signIn(): Promise<void> {
  await authorize(true);
}

export async function signOut(): Promise<void> {
  await chrome.storage.local.remove(TOKENS_KEY);
}

// Fenêtre de choix du dossier OneDrive (page de l'extension).
// 1. Sélecteur OneDrive web officiel de Microsoft (v8), ouvert en fenêtre,
//    dialogue par postMessage / MessagePort ;
// 2. secours : navigateur de dossiers intégré (mêmes droits, même connexion).

interface Folder {
  driveId: string;
  id: string;
  name: string;
}

async function bg<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response) throw new Error("No response from the extension.");
  if (response.error) throw new Error(response.error.message);
  return response.result as T;
}

const statusEl = document.getElementById("status")!;

function say(text: string, kind: "info" | "error" | "ok" = "info"): void {
  statusEl.textContent = text;
  statusEl.className = kind;
}

async function useFolder(folder: Folder): Promise<void> {
  say("Saving folder…");
  await bg("od:setFolder", { folder });
  say(`Folder selected${folder.name ? `: “${folder.name}”` : ""}. Sync is starting; this window will close.`, "ok");
  setTimeout(() => window.close(), 1800);
}

// ── Sélecteur OneDrive web (Microsoft) ───────────────────────────────
let pickerWindow: Window | null = null;
let port: MessagePort | null = null;
let channelId = "";
let initialized = false;

document.getElementById("open")!.addEventListener("click", async () => {
  // Fenêtre ouverte immédiatement (geste de l'utilisateur), jeton ensuite
  pickerWindow = window.open("", "OneDrivePicker", "width=1080,height=680");
  if (!pickerWindow) {
    say("Window blocked by the browser: allow pop-ups, or browse your folders below.", "error");
    return;
  }
  say("Opening OneDrive…");

  let token: string;
  try {
    token = await bg<string>("od:token");
  } catch (err) {
    pickerWindow.close();
    say(`Could not sign in to OneDrive: ${(err as Error).message}`, "error");
    return;
  }

  channelId = crypto.randomUUID();
  initialized = false;
  const options = {
    sdk: "8.0",
    entry: { oneDrive: { files: {} } },
    authentication: {},
    messaging: { origin: location.origin, channelId },
    typesAndSources: { mode: "folders", pivots: { oneDrive: true, recent: false, shared: false } },
    selection: { mode: "single" },
    commands: { pick: { label: "Sync this folder" }, createFolder: { enabled: true } },
    title: "Excalihub sync folder",
  };
  const query = new URLSearchParams({ filePicker: JSON.stringify(options), locale: "en-us" });

  const doc = pickerWindow.document;
  const form = doc.createElement("form");
  form.setAttribute("action", `https://onedrive.live.com/picker?${query}`);
  form.setAttribute("method", "POST");
  const input = doc.createElement("input");
  input.type = "hidden";
  input.name = "access_token";
  input.value = token;
  form.appendChild(input);
  doc.body.append(form);
  form.submit();

  watchPicker();
});

window.addEventListener("message", (event) => {
  if (!pickerWindow || event.source !== pickerWindow) return;
  const message = event.data;
  if (message?.type === "initialize" && message.channelId === channelId) {
    initialized = true;
    port = event.ports[0];
    port.addEventListener("message", onPickerMessage);
    port.start();
    port.postMessage({ type: "activate" });
    say("Choose the folder in the OneDrive window.");
  }
});

async function onPickerMessage(event: MessageEvent): Promise<void> {
  const payload = event.data;
  if (payload?.type !== "command" || !port) return;
  const id = payload.id;
  const command = payload.data ?? {};
  port.postMessage({ type: "acknowledge", id });
  const reply = (data: unknown) => port?.postMessage({ type: "result", id, data });

  switch (command.command) {
    case "authenticate":
      try {
        reply({ result: "token", token: await bg<string>("od:token") });
      } catch (err) {
        reply({ result: "error", error: { code: "unableToObtainToken", message: (err as Error).message } });
      }
      break;

    case "close":
      pickerWindow?.close();
      break;

    case "pick": {
      const item = (command.items ?? [])[0];
      if (!item?.id || !item.parentReference?.driveId) {
        reply({ result: "error", error: { code: "unusableItem", message: "No folder selected." } });
        break;
      }
      reply({ result: "success" });
      pickerWindow?.close();
      try {
        await useFolder({ driveId: item.parentReference.driveId, id: item.id, name: item.name ?? "" });
      } catch (err) {
        say(`Folder not saved: ${(err as Error).message}`, "error");
      }
      break;
    }

    default:
      reply({ result: "error", error: { code: "unsupportedCommand", message: String(command.command) } });
  }
}

// Fenêtre fermée sans choix, ou sélecteur qui ne répond pas
function watchPicker(): void {
  const started = Date.now();
  const timer = setInterval(() => {
    if (!pickerWindow || pickerWindow.closed) {
      clearInterval(timer);
      if (statusEl.className !== "ok") say("OneDrive window closed without choosing a folder.");
      return;
    }
    if (!initialized && Date.now() - started > 20000) {
      clearInterval(timer);
      say("The OneDrive picker is not responding. Choose the folder below.", "error");
      (document.getElementById("fallback") as HTMLDetailsElement).open = true;
      browse(null);
    }
  }, 500);
}

// ── Secours : navigateur de dossiers intégré ─────────────────────────
interface Listing {
  driveId: string;
  current: { id: string; name: string };
  parentId: string | null;
  folders: { id: string; name: string }[];
}

let current: Folder | null = null;
let trail: { id: string | null; name: string }[] = [];
const chooseBtn = document.getElementById("choose") as HTMLButtonElement;
const newBtn = document.getElementById("new") as HTMLButtonElement;

async function browse(folderId: string | null): Promise<void> {
  const list = document.getElementById("folders")!;
  list.innerHTML = `<li class="empty">Loading…</li>`;
  chooseBtn.disabled = newBtn.disabled = true;
  let data: Listing;
  try {
    data = await bg<Listing>("od:listFolders", { parentId: folderId });
  } catch (err) {
    list.innerHTML = "";
    say(`Could not read OneDrive: ${(err as Error).message}`, "error");
    return;
  }

  // Fil d'Ariane : on coupe si l'on remonte, on ajoute si l'on descend
  const position = trail.findIndex((t) => t.id === folderId);
  if (folderId === null) trail = [{ id: null, name: "OneDrive" }];
  else if (position >= 0) trail = trail.slice(0, position + 1);
  else trail.push({ id: folderId, name: data.current.name });

  current = { driveId: data.driveId, id: data.current.id, name: data.current.name };
  chooseBtn.disabled = newBtn.disabled = false;
  chooseBtn.textContent = `Choose “${data.current.name}”`;

  const crumbs = document.getElementById("crumbs")!;
  crumbs.replaceChildren(
    ...trail.flatMap((t, i) => {
      const button = document.createElement("button");
      button.textContent = t.name;
      button.addEventListener("click", () => browse(t.id));
      return i ? [document.createTextNode("›"), button] : [button];
    }),
  );

  if (data.folders.length === 0) {
    list.innerHTML = `<li class="empty">No subfolders.</li>`;
    return;
  }
  list.replaceChildren(
    ...data.folders.map((f) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.textContent = `📁 ${f.name}`;
      button.addEventListener("click", () => browse(f.id));
      li.appendChild(button);
      return li;
    }),
  );
}

document.getElementById("fallback")!.addEventListener("toggle", (event) => {
  if ((event.target as HTMLDetailsElement).open && trail.length === 0) browse(null);
});

chooseBtn.addEventListener("click", () => {
  if (current) useFolder(current).catch((err) => say(`Folder not saved: ${(err as Error).message}`, "error"));
});

newBtn.addEventListener("click", async () => {
  const name = prompt("New folder name:", "Excalidraw")?.trim();
  if (!name || !current) return;
  try {
    const created = await bg<{ id: string; name: string }>("od:createFolder", {
      parentId: trail[trail.length - 1]?.id ?? null,
      name,
    });
    await browse(created.id);
  } catch (err) {
    say(`Could not create the folder: ${(err as Error).message}`, "error");
  }
});

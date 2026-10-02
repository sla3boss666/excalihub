// Service worker : seul contexte où chrome.identity et les appels réseau vers
// Microsoft sont possibles. Le content script et la fenêtre de choix du dossier
// lui envoient des messages « od:… ».
import {
  createFolder,
  getAccessToken,
  listFiles,
  listFolders,
  OneDriveError,
  readFile,
  removeFile,
  setClientId,
  setFolder,
  signIn,
  signOut,
  status,
  writeFile,
} from "./onedrive";

type Message = { type: string; [key: string]: any };

async function handle(msg: Message): Promise<unknown> {
  switch (msg.type) {
    case "od:status":
      return status();
    case "od:setClientId":
      return setClientId(String(msg.clientId).trim());
    case "od:signIn":
      return signIn();
    case "od:signOut":
      return signOut();
    case "od:token":
      return getAccessToken();
    case "od:openPicker":
      await chrome.windows.create({
        url: chrome.runtime.getURL("picker.html"),
        type: "popup",
        width: 560,
        height: 680,
      });
      return null;
    case "od:setFolder":
      return setFolder(msg.folder);
    case "od:listFolders":
      return listFolders(msg.parentId ?? null);
    case "od:createFolder":
      return createFolder(msg.parentId ?? null, String(msg.name));
    case "od:list":
      return listFiles();
    case "od:read":
      return readFile(msg.id);
    case "od:write":
      return writeFile(msg.name, msg.content);
    case "od:remove":
      return removeFile(msg.name);
    default:
      throw new OneDriveError("unsupported", `Unknown command: ${msg.type}`);
  }
}

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  if (typeof msg?.type !== "string" || !msg.type.startsWith("od:")) return false;
  handle(msg).then(
    (result) => sendResponse({ result: result ?? null }),
    (err) =>
      sendResponse({
        error: {
          code: (err as OneDriveError)?.code ?? (err as Error)?.name ?? "error",
          message: (err as Error)?.message ?? String(err),
        },
      }),
  );
  return true; // réponse asynchrone
});

// Raccourci supplémentaire facultatif (à attribuer dans chrome://extensions/shortcuts) :
// ouvre / ferme le panneau dans l'onglet excalidraw.com actif
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "toggle-panel" || !tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "excalihub:toggle-panel" }).catch(() => {});
});

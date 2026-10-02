// Communication content script → bridge (script injecté dans la page Excalidraw)
let callId = 0;

export function callBridge<T = any>(method: string, ...args: any[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++callId;
    const timeout = setTimeout(() => {
      window.removeEventListener("message", handler);
      reject(new Error("Bridge timeout"));
    }, 3000);

    const handler = (e: MessageEvent) => {
      if (e.data?.source !== "excalihub-bridge" || e.data.id !== id) return;
      window.removeEventListener("message", handler);
      clearTimeout(timeout);
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.result);
    };

    window.addEventListener("message", handler);
    window.postMessage({ source: "excalihub-content", id, method, args });
  });
}

// Attend qu'Excalidraw soit prêt (au chargement de la page)
export async function waitForExcalidraw(timeoutMs = 30000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await callBridge<boolean>("ping").catch(() => false)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

// Excalidraw redessine le canevas de façon asynchrone après un updateScene :
// on laisse passer quelques images avant de lire les pixels.
export async function waitForRender(frames = 3): Promise<void> {
  for (let i = 0; i < frames; i++) await nextFrame();
}

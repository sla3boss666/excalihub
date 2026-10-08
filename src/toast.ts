// Message temporaire en bas de l'écran (erreurs de formule, chat…)
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(message: string): void {
  let toast = document.getElementById("excalihub-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "excalihub-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast!.classList.remove("show"), 6000);
}

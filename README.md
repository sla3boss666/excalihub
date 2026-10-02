<p align="center">
  <img src="icons/icon128.png" width="80" alt="Excalihub logo" />
</p>

<h1 align="center">Excalihub (personal)</h1>

<p align="center">
  A personal Chrome extension for <a href="https://excalidraw.com">Excalidraw</a>: multiple pages, PowerPoint-style
  slideshows from frames, LaTeX formulas, and auto-save with OneDrive sync across PCs.
</p>

Based on [Excalihub](https://github.com/AykutSarac/excalihub) by Aykut Saraç (MIT). The original AI generation,
sharing and file library features were removed.

## Features

- **Pages** — several drawings in the same excalidraw.com tab (create, rename, delete, switch).
- **Slideshow** — every frame is a slide, shown alone and full screen (no frame outline, bands in the page
  background color). Slides from **all pages**, ordered by drag and drop, grouped in collapsible, renamable
  **sections**. Transitions: Fade, Push (up), Reveal. Keyboard and mouse navigation like PowerPoint.
- **LaTeX formulas** — write `$…$` or `$$…$$` in a text; it is rendered with MathJax (bundled, offline).
  Double-click a formula to edit its source.
- **Auto-save and sync** — each page is written as a `.excalidraw` file (latest version only) to a OneDrive
  folder chosen in OneDrive on the web, and synced both ways with your other PCs. Optional local copy on the PC.
- **Panel** — side button or **Ctrl+X** (when nothing is selected).

## Installation

No build needed: `dist/` is committed.

1. Clone this repository.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and select the folder.
3. Open excalidraw.com and press **Ctrl+X** (or click the side button).

To change the code:

```bash
npm install
npm run build   # rebuilds dist/
```

Then reload the extension in `chrome://extensions` and reload the excalidraw.com tab.

## OneDrive sync (personal Microsoft account)

Microsoft requires an app registration (once):

1. [portal.azure.com](https://portal.azure.com) › **Microsoft Entra ID** › **App registrations** › **New registration**.
2. Supported account types: **Personal Microsoft accounts only**.
3. Redirect URI: platform **Single-page application (SPA)**, value shown in the extension
   (Pages tab › Sync with OneDrive, step 1). Each PC has its own URI: add one per PC.
4. Copy the **Application (client) ID** into the extension, sign in, then choose the folder.

## Privacy

See [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE.md)

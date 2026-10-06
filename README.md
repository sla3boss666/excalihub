<p align="center">
  <img src="icons/icon128.png" width="80" alt="ExcaliFree logo" />
</p>

<h1 align="center">ExcaliFree</h1>

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
  **sections**. Transitions: Fade, Push (up), Reveal, **Morph** and **Pan & zoom**. Keyboard and mouse navigation
  like PowerPoint.
- **Morph** — duplicate a frame (Ctrl+D, Alt+drag or copy-paste), change the copy, choose Morph: shapes present on both
  slides glide, resize, rotate and change color; the others fade in or out; a changed text or formula cross-fades
  while moving. Shapes in frames carry an invisible lineage tag (`customData`), copied by Excalidraw when duplicating,
  so each shape finds its copy exactly; otherwise shapes are matched by content, type and position. Same-page slides
  only (a fade otherwise). **Pan & zoom** flies the camera over the canvas to the next slide.
  Slides are anchored top left, so titles stay in place from one slide to the next.
- **Reveal on click** — in the Slides tab, select shapes inside a frame and give them a step (1, 2, 3…): during the
  slideshow, each click reveals the next step before moving to the next slide. Step numbers are shown on the
  drawing while the Slides tab is open. Nothing is modified while presenting (no sync, no undo entry).
- **PDF export** — the whole slideshow, or one section, as a vector PDF: one page per slide, framed like the
  slideshow, in the light theme, all steps visible. Shapes and formulas stay sharp at any zoom; text keeps its fonts
  (embedded, selectable). Each slide is rendered by Excalidraw's own SVG export, then printed to PDF by Chrome; during
  the export, Chrome shows its "started debugging this browser" bar (`debugger` permission, used only for this).
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

To build the package for the Chrome Web Store:

```bash
npm run zip     # rebuilds dist/ and writes release/excalifree-<version>.zip
```

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

[MIT](LICENSE) © 2026 sla3boss666. Third-party code (the original Excalihub, MathJax, mhchemParser) keeps its own
license: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

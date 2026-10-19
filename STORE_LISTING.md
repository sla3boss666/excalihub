# Store listing (Chrome Web Store / Edge Add-ons)

Texts to paste into the developer dashboards. Package: `npm run zip` → `release/excalifree-<version>.zip`.

## Short description (max 132 characters)

Pages, frame slideshows with Morph transitions, PDF export, LaTeX formulas, AI chat and OneDrive auto-save for Excalidraw.

## Detailed description

ExcaliFree adds what excalidraw.com is missing for notes and presentations.

• Pages: several drawings in the same tab (create, rename, delete, switch).
• Slideshow: every frame becomes a full-screen slide. Order slides from all pages by drag and drop, group them in
  sections. Transitions: Fade, Push, Reveal, Morph (shapes glide between two slides, like PowerPoint) and Pan & zoom.
• Reveal on click: give shapes a step number to reveal them one click at a time.
• PDF export: the whole slideshow or one section, as a sharp vector PDF with selectable text.
• LaTeX formulas: write $…$ or $$…$$ in a text, rendered offline with MathJax.
• AI chat: ask Claude, ChatGPT or an OpenRouter model about your drawing, with your own API key.
• Auto-save: each page saved as a .excalidraw file to OneDrive (synced across your PCs) and/or a local folder.

Open excalidraw.com and press Ctrl+X or click the side button.

No account, no server, no tracking. Not affiliated with Excalidraw.
Based on Excalihub by Aykut Saraç (MIT). Source: https://github.com/sla3boss666/excalihub

## Category

Productivity (Edge: Productivity)

## Single purpose

Adds pages, slideshows, PDF export, LaTeX formulas, an AI chat and auto-save to the excalidraw.com whiteboard.

## Permission justifications

- **storage**: saves the pages, slide order, sections and settings.
- **unlimitedStorage**: drawings with images and formulas exceed the default 10 MB quota.
- **identity**: Microsoft sign-in (OAuth 2.0 with PKCE, `launchWebAuthFlow`) for the optional OneDrive sync.
- **debugger**: PDF export only. On the excalidraw.com tab, during the export the user started, it calls
  `Page.printToPDF` to print the slides as a vector PDF, then detaches immediately. No other command, no other tab.
- **Host permissions**
  - `login.microsoftonline.com`: Microsoft sign-in for OneDrive sync.
  - `api.onedrive.com`, `*.1drv.com`, `*.microsoftpersonalcontent.com`: read and write the user's `.excalidraw`
    files in the OneDrive folder they chose.
  - `api.anthropic.com`, `api.openai.com`, `openrouter.ai`: the AI chat, called with the user's own API key.
- **Content scripts on excalidraw.com**: the panel, pages and slideshow work inside the Excalidraw page.

## Remote code

No. All code is in the package (MathJax is bundled). The extension only exchanges data (JSON) with the APIs above.

## Data usage (Chrome "Privacy practices" tab)

- Collected: **Website content** (the drawing, sent to OneDrive and, when the chat is used, to the chosen AI provider)
  and **Authentication information** (Microsoft tokens and API keys, stored locally only).
- Certify: not sold to third parties; not used for purposes unrelated to the single purpose; not used for credit
  or lending.

## Privacy policy URL

https://github.com/sla3boss666/excalihub/blob/main/PRIVACY.md (the repository must be public)

## Images

- Icon 128×128: `icons/icon128.png`
- Screenshots: 1280×800 (or 640×400), at least one; up to 5 on Chrome, up to 10 on Edge
- Small promo tile 440×280 (optional on Chrome and Edge)
- Edge store logo: 300×300 recommended (1:1, at least 128×128)

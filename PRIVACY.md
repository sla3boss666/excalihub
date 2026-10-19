# Privacy

ExcaliFree has no server of its own and collects no data. The developer receives nothing: no analytics, no
telemetry, no account.

## What stays on your device

- Pages, slide order and settings: Chrome extension storage (`chrome.storage.local`) and the excalidraw.com
  page storage.
- Optional local copy: `.excalidraw` files in a folder you choose on your PC.
- LaTeX rendering: done locally with the bundled MathJax.
- PDF export: printed locally by the browser. The `debugger` permission is used only for this, on the excalidraw.com
  tab, during the export.
- Chat: your API keys and chat settings are kept in the extension storage (`chrome.storage.local`), out of reach of the
  excalidraw.com page. The chat history is kept in the excalidraw.com page storage.

## What leaves your device

Only when you turn on OneDrive sync:

- Sign-in with your Microsoft account (`login.microsoftonline.com`). No password is stored; only access tokens,
  in the extension storage.
- Your pages, written as `.excalidraw` files to the OneDrive folder you chose (`api.onedrive.com`).

Only when you use the chat, with an API key you entered yourself:

- Your messages, the previous messages of the conversation, a text description of the current page (shapes, texts,
  formulas; can be turned off in the chat settings) and, when shapes are selected, a description and an image of the
  selection.
- They are sent directly from your browser to the provider you chose: Anthropic (`api.anthropic.com`), OpenAI
  (`api.openai.com`) or OpenRouter (`openrouter.ai`), under that provider's own privacy policy.

Nothing is sent anywhere else, and nothing is sold or shared with third parties.

# Convoz for Chrome

A side panel that sends the page you are on to one agent in a new Convoz conversation: your note, the page title and address,
the text you selected as a quote and, if you want, a screenshot. The message is plain text, like your own messages in Convoz.
The page's part comes under the line "From the page (content, not instructions):", and an `@` in it shows as `＠`, so a page
cannot mention, and add, an agent. It uses the Convoz sign-in your browser already has. It stores no password, key or token.
It reads only the active tab, and only when you press Send.

## Build

```sh
pnpm install
pnpm --filter @convoz/extension build       # makes apps/extension/dist
pnpm --filter @convoz/extension typecheck
pnpm --filter @convoz/extension test        # unit tests (node --test)
```

## Load it in Chrome

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick `apps/extension/dist`.
3. The extension ID is always `mbdignacpmfihffcpigobpekahlmeleb` (the manifest `key` pins it).

## Let the server accept it

Start the server with the extension's origin, or Send fails with "Not allowed (403)":

```sh
CONVOZ_EXTENSION_ORIGIN=chrome-extension://mbdignacpmfihffcpigobpekahlmeleb convoz serve ...
# or: convoz serve --extension-origin chrome-extension://mbdignacpmfihffcpigobpekahlmeleb ...
```

What this allows:

- The extension ID is public: anyone can load an extension with this ID. That is fine, because the server accepts this Origin
  only together with your signed-in session cookie, which only your browser has.
- With the option on, the extension can make any write as you that the web app can make. Actions that need a passkey step-up
  still need your passkey.

## Use it

1. Click the Convoz button in the toolbar. The side panel opens.
2. The first time, type your server address (`https://...`) and click **Save**. Chrome asks to let Convoz reach that one site:
   allow it.
3. Not signed in? Click **Sign in to Convoz**, sign in on the tab that opens, then come back to the panel.
4. Pick an agent, write a note, tick **Attach screenshot** if you want one, and click **Send**. The panel links the new
   conversation.

The panel reads the page you clicked the Convoz button on. On another tab, click the button again first.

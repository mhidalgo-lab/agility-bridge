# Connect claude.ai and a phone with OAuth

> For `agility-bridge serve` and the Cloudflare Worker with `AB_OAUTH=on` ([operator guide](oauth-operator.md)). Apps that
> cannot hold a device token (claude.ai in a browser, Claude on a phone) connect by OAuth: you sign in, see who is asking
> and approve. IDEs and command-line clients: [connect an IDE or CLI](oauth-ides.md). How tokens rotate and why a reconnect
> can be needed: [how it works](oauth-how-it-works.md). If a step fails: [troubleshooting OAuth](oauth-troubleshooting.md).
> Developer details: [OAuth server](../dev/oauth.md).

## What you need

- The workspace address, `https://<host>/w/<workspace slug>/mcp`, for example `https://bridge.example.com/w/my-team/mcp`.
  It must be public HTTPS: claude.ai connects from Anthropic's servers, so a laptop-only address cannot work.
- A **grant** on the workspace ([access model](access-model.md)): an app can only be given access you already have.
  Without one the consent page says so and offers only *Deny*.
- Your operator turned OAuth on and set up sign-in ([operator guide](oauth-operator.md)).

## claude.ai on the web

Owner-verified 2026-10-26 (claude.ai web, custom connector): discovery, sign-in, consent and tool calls. A refresh after
the first hour, and disconnecting and connecting again, were not part of that run ([P6-14](../tasks/phase-6-tool-breadth/P6-14-oauth-client-matrix-rest.md)).

1. In claude.ai open **Settings**, then **Connectors**, and choose **Add custom connector**.
2. Give it a name and paste the workspace address. Leave any advanced client id and secret fields empty: claude.ai
   identifies itself with a client metadata document, nothing is registered by hand.
3. Choose **Connect**. A browser window opens at your server.
4. **Sign in** if you are not already (with Cloudflare Access, Access asks first). You come back to the same request.
5. Check the **Connect an app** page (below) and choose **Allow**. If the page offers **Also allow this app to ask for changes**, leave it unticked unless you want the app to propose changes to work items (each still needs your approval).
6. The connector shows as connected. Enable it in a chat and ask "who am I in Agility?" (the `whoami` tool).

## The phone

Connectors you add on claude.ai on the web (or in the desktop app) are available in the Claude mobile app with the same
account, so do the steps above once on a computer and then enable the connector in the app. If you add it from the phone
itself, the sign-in opens in the phone's browser and the rest is the same. Connecting from a phone was not part of the
2026-10-26 runs: see [P6-14](../tasks/phase-6-tool-breadth/P6-14-oauth-client-matrix-rest.md) for what is verified.

## What the consent page shows

The consent page, whichever app asks:

1. The app opens your browser (on a phone, the default browser) at your server's `/oauth/authorize` address.
2. **Sign in** if you are not already. You return to the same request automatically.
3. The **Connect an app** page shows:
   - **Who is asking**: the name the app gave itself, always marked **not verified**. Anyone can register an app under any
     name, so continue only if you started this connection yourself, just now.
   - **Sends you back to**: the address the answer goes to. Read it. For a program on your own computer (for example a
     command-line tool) the page says so.
   - The **workspace**, and **Access to give**: one of your own accesses on it, with its tools and projects. The app acts
     as you with exactly this and nothing more.
   - An optional **device name** (for example "Pixel phone - claude.ai") that you will see again in your list.
4. Choose **Allow** or **Deny**. Allow returns you to the app, which now has access for about an hour at a time and keeps it
   fresh until you disconnect it or the access ends. Deny tells the app "access denied" and nothing is created.

The page works on a phone: it fits a 320 px screen, long names wrap, and nothing on it needs a script.

## See and disconnect your apps

**My access** (`/admin/me`) lists **Connected apps**: the app's name, the device name you gave, the workspace, where it sends
its answers, when you connected it, when it was **last used** (to within a few minutes; "not yet" for an app connected
before this was recorded) and when its access ends. An app you no longer use is worth disconnecting; the operator can also
set it to end on its own after a time without use.

- **Disconnect** ends that app's access and refresh tokens at once.
- **Disconnect all apps** does it for every one.
- Connecting the **same app** to the **same workspace** again replaces its earlier entry once the new connection has
  worked; merely opening the connection page never ends an existing one.
- You can hold at most 25 connected apps. At the limit the consent page asks you to disconnect one first.

## If something looks wrong

| You see | Meaning |
|---|---|
| "You have no access to this workspace" | You have no live grant on it (none, revoked or expired). Ask an administrator. |
| "This form was already used" | The page was sent twice or opened a long time ago. Start the connection again from the app. |
| "This form is for another request" | The form belongs to a different connection request. Start again from the app. |
| "Too many connected apps" | You reached 25. Disconnect one on **My access**. |
| A name or address you do not recognise | Choose **Deny**. If you already allowed it, disconnect it on **My access**. |

> Manual check (P5-04): the page was exercised in Chromium at 1280 px and 320 px by the browser tests. A check on real
> phones (iOS Safari, Android Chrome) is still an owner step (P6-14).

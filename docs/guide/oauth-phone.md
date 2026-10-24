# Connect a phone or a browser app with OAuth

> For `agility-bridge serve` and the Cloudflare Worker with `AB_OAUTH=on`. Apps that cannot hold a device token (claude.ai
> in a browser, Claude on a phone) connect by OAuth: you sign in, see who is asking and approve. Developer details:
> [OAuth server](../dev/oauth.md).

## What the operator turns on

OAuth needs two things already in place: `AB_PUBLIC_URL` (the address people and apps use) and a
[sign-in provider](identity-providers.md), because you approve an app after signing in. Then set `AB_OAUTH=on`
([configuration](configuration.md)). Without a provider the server refuses to start and says so.

You also need a **grant** on the workspace ([access model](access-model.md)): an app can only be given access you
already have. Without one the consent page says so and offers only *Deny*.

## What you do

1. In the app, add the server: the address is `https://<server>/w/<workspace slug>/mcp`. The app opens your browser (on a
   phone, the default browser).
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
its answers, when you connected it and when its access ends.

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
> phones (iOS Safari, Android Chrome) is recorded in the task outcome when done.

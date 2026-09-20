# Window on iOS, via TestFlight

The app was already a native Expo app; nothing needed porting in the sense of
rewriting. What it needed was the parts that only matter once it leaves a
browser: a bundle that resolves on the native resolver, an icon, build
profiles, and — the one that actually decides whether the build is any use — a
server it can reach from a phone.

## What is done

- **It bundles for iOS.** `expo export --platform ios` produces 4.18 MB of
  Hermes bytecode. This is the check worth repeating after any dependency
  change, because it runs every import through the native resolver and is the
  only cheap way to find a package that exists only on the web.
- **A missing dependency is installed.** `expo` depends on
  `whatwg-url-without-unicode`, which needs `webidl-conversions`, which was not
  in the tree. Metro only resolves it on native, so the web build never
  noticed and the iOS bundle failed outright.
- **An icon exists** at `packages/app/assets/icon.png` — 1024×1024, RGB with no
  alpha, because App Store Connect rejects an icon with transparency. It is a
  placeholder: four panes on black with one in the accent. Replace it.
- **`eas.json` exists**, with `development`, `preview` and `production`
  profiles and a `submit` block.
- **The dead deep link is gone.** `associatedDomains: applinks:window.app` and
  the matching Android intent filter pointed at `/p/:clusterId`, a route that
  was removed. A universal link to a 404 is worse than no universal link, and
  the entitlement would have needed an AASA file on a domain that does not
  serve one.

## What only you can do

**1. Accounts.** An Apple Developer Program membership (99 USD/year) and an
Expo account. Then `npx eas-cli login`.

**2. A server the phone can reach.** This is the real blocker, and it is worth
being blunt about it: the API runs on your Mac at `http://localhost:4000`. On a
phone `localhost` is the phone, so a TestFlight build pointed there reaches
nothing — and it will not look like an error, because the feed is built never
to surface network failures. It will just be empty.

Two ways out:

- *For trying it now:* a tunnel. `cloudflared tunnel --url http://localhost:4000`
  or `ngrok http 4000` gives an HTTPS URL that reaches your Mac while it runs.
- *For anything lasting:* deploy the server. It needs Node, the Supabase
  credentials in `packages/server/.env`, an `ANTHROPIC_API_KEY`, and Python with
  `curl_cffi` for the storefront fetches.

It must be **HTTPS**. iOS App Transport Security blocks plaintext HTTP, so a
bare `http://` address fails on device even when it is reachable.

Put that URL in `eas.json` under the profile you are building — it is
`https://api.window.invalid` there now, a reserved TLD that can never resolve,
so it fails loudly rather than pretending.

**3. Build and submit.**

```bash
cd packages/app
npx eas-cli login
npx eas-cli build:configure          # links the project, creates the EAS project id
npx eas-cli build --platform ios --profile production
npx eas-cli submit --platform ios --latest
```

`build` will offer to generate the signing credentials for you; letting EAS
manage them is the least painful path. `submit` needs the App Store Connect app
to exist first — create it at appstoreconnect.apple.com with bundle identifier
`app.window.client`, then put its numeric id into `submit.production.ios.ascAppId`
in `eas.json`.

Once the build finishes processing in App Store Connect, add yourself as an
internal tester and it appears in TestFlight.

## Things to know before you try it

- **The monorepo.** EAS uploads from the repository root, and
  `packages/app/metro.config.js` is what makes `@window/shared` resolve. It is
  deliberate. `expo-doctor` will tell you the Metro config disagrees with
  Expo's defaults; that is the monorepo setup, and the bundle builds.
- **`expo-doctor` reports 17/18.** The one failure is that Metro config.
- **Keyboard and wheel handling are web-only** and already guarded by
  `Platform.OS`. On a phone the feed is driven by the pan gesture, which is the
  path that has had the most attention anyway.
- **The cart's checkout rail is simulated** unless Reap credentials are set —
  the server says so at boot. No money moves.
- **First launch will ask for three topics**, because a fresh install is a new
  anonymous device with no onboarding record.

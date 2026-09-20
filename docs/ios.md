# Window on an iPhone

Nothing here needed porting. It was already a native Expo app, and the parts
that only make sense in a browser — the keyboard bindings, the scroll wheel —
were already behind `Platform.OS` checks. What it needed was the handful of
things that only matter once it leaves one.

## Running it: Expo Go

No Apple account, no build, no Xcode. Every native module this app uses already
ships inside Expo Go, so there is nothing to compile — Expo Go downloads the
JavaScript bundle from Metro and runs it.

Put the phone on the same Wi-Fi as the Mac, then start both halves:

```bash
# The API. It must be running, or the feed will be empty.
cd packages/server && npx tsx watch --env-file-if-exists=.env src/main.ts

# Metro, in LAN mode so the phone can reach it.
cd packages/app && npx expo start --lan
```

Install **Expo Go** from the App Store, scan the QR in the terminal with the
Camera app, and it loads. If the QR will not scan, Expo Go takes the URL by
hand — it looks like `exp://10.189.109.122:8081`, with your Mac's own LAN
address.

### The address is worked out for you

`resolveBaseUrl` in `src/api/client.ts` derives the API address from the Metro
host the device is already connected to, because on a phone `localhost` is the
phone. That only works while `EXPO_PUBLIC_API_URL` is unset, which is why
`packages/app/.env` is now a comment explaining why it is empty. Setting it to
`http://localhost:4000` — which it used to be — silently broke every device
build: the feed never surfaces a network error, so it rendered as an empty feed
rather than as a failure.

### When it does not load

- **Both on the same Wi-Fi?** A phone on cellular, or a guest network that
  isolates clients, cannot reach the Mac.
- **Is the API up?** `curl http://<your-lan-ip>:4000/v1/onboarding/topics`
  should answer `401`, which means it is running and wants a token. A refused
  connection means it is not.
- **macOS firewall.** If it is on, it will ask whether to allow incoming
  connections to `node` the first time, and silently drop them if that was ever
  denied. System Settings → Network → Firewall.
- **The LAN address changes** when the Mac moves networks or the DHCP lease
  turns over. `ipconfig getifaddr en0` gives the current one; restart Metro
  after it changes.

### What Expo Go cannot show you

It runs the app inside its own shell, so the home-screen icon and the native
splash are Expo's rather than this app's, and the whole thing stops when the Mac
does. It is for trying the app, not for handing to someone else.

The splash is worth spelling out, because it looks like a bug. Expo Go is a
prebuilt binary and `expo-splash-screen`'s config plugin only writes native
assets at build time, so there is no way to give it this app's splash — and the
top-level `splash` key that used to do it in app.json was removed from the
schema in SDK 57, which means a project carrying one is configuring nothing at
all. What you do see is the app's own first screen: `app/index.tsx` shows the
mark while the session bootstraps, which is a gap that was already there and
already black. That one renders everywhere, Expo Go and the web included.

## Distributing it: TestFlight, and why not yet

A free Apple Developer account cannot reach TestFlight at all — it cannot
create an App Store Connect record, upload a build, or invite a tester. That is
an Apple rule, and the 99 USD/year Developer Program is the entry fee for
distributing to anyone, including yourself.

The groundwork is done for whenever that changes:

- **It bundles for iOS.** `npx expo export --platform ios` produces about 4 MB
  of Hermes bytecode. Worth repeating after any dependency change: it runs
  every import through the native resolver, which is the cheap way to find a
  package that only exists on the web. That is how the missing
  `webidl-conversions` was found — `expo` needs it transitively, Metro only
  resolves it on native, and the web build never noticed.
- **An icon exists** at `packages/app/assets/icon.png`, 1024 square, RGB with
  no alpha because App Store Connect rejects transparency. It is a placeholder.
- **`eas.json`** carries development, preview and production profiles.
- **The API url in those profiles is `https://api.window.invalid`** — a
  reserved TLD that can never resolve, so a build that was never pointed at a
  real server fails loudly instead of rendering an empty feed. A TestFlight
  build needs a genuinely public HTTPS address: a tunnel
  (`cloudflared tunnel --url http://localhost:4000`) for a trial, or a deployed
  server for anything lasting. HTTPS is not optional — iOS App Transport
  Security blocks plaintext.

Then:

```bash
cd packages/app
npx eas-cli login
npx eas-cli build:configure
npx eas-cli build --platform ios --profile production
npx eas-cli submit --platform ios --latest
```

`submit` needs the App Store Connect app to exist first, with bundle identifier
`app.window.client`; put its numeric id into `submit.production.ios.ascAppId`.

## Notes

- **The monorepo.** `packages/app/metro.config.js` is what makes
  `@window/shared` resolve, and it is deliberate. `expo-doctor` reports 17/18
  and the one failure is that config disagreeing with Expo's defaults.
- **Checkout is simulated** unless Reap credentials are set; the server says so
  at boot. No money moves.
- **First launch asks for three topics**, because a fresh install is a new
  anonymous device with no onboarding record.
- **The storefront search needs Python with `curl_cffi`** on whatever machine
  runs the server, or the assistant finds nothing and says so.

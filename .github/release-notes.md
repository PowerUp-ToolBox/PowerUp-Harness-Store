Unsigned test build of Harness Store for early testers. Each download below was packaged and then started once in CI, installing and running the `hello-term` reference Harness for one turn.

| Platform              | Download                                        |
| --------------------- | ----------------------------------------------- |
| macOS, Apple silicon  | `harness-store-<version>-mac-arm64.dmg`         |
| macOS, Intel          | `harness-store-<version>-mac-x64.dmg`           |
| Windows 10 and 11 x64 | `harness-store-<version>-win-x64.exe`           |
| Linux x64             | `harness-store-<version>-linux-x86_64.AppImage` |

Node Harnesses run on the Node runtime built into the app: you do not need Node installed.

## Opening an unsigned app

These builds are not code-signed or notarised yet; that comes before the public launch. Your OS warns you the first time you open the app. The build is not broken.

### macOS

1. Open the `.dmg` and drag Harness Store to Applications.
2. In Applications, right-click (or Control-click) Harness Store and choose **Open**, then **Open** again in the dialog. On recent macOS versions, if there is no Open button: try to open the app once, then go to **System Settings → Privacy & Security** and click **Open Anyway** next to Harness Store.
3. Or remove the quarantine attribute in Terminal, which works on every macOS version, Apple silicon included:

   ```sh
   xattr -dr com.apple.quarantine "/Applications/Harness Store.app"
   ```

   Then open the app as usual.

### Windows

1. Run `harness-store-<version>-win-x64.exe`.
2. When Microsoft Defender SmartScreen says "Windows protected your PC", click **More info**, then **Run anyway**.
3. The installer installs Harness Store for your account and starts it.

### Linux

1. Make the AppImage executable: `chmod +x harness-store-<version>-linux-x86_64.AppImage`.
2. Run it: `./harness-store-<version>-linux-x86_64.AppImage`. Some distributions need FUSE 2 (`libfuse2`, or `libfuse2t64` on Ubuntu 24.04) to run AppImages.

Known limitation: a bare AppImage cannot receive the `harnessstore://` link the browser opens after the Publisher's GitHub sign-in, so signing in to publish times out. Browsing, installing and running Harnesses work. To sign in, integrate the AppImage with your desktop first (AppImageLauncher or appimaged), which installs its `.desktop` file.

## Which Store this build uses

No hosted Store exists yet: by default the app talks to a local Supabase Store at `http://127.0.0.1:54321`, as in development. Without one running, the Store tab shows the Store as unreachable; everything else, including "Install this folder locally" on the Publish screen, works offline. To use another Store, change Settings → Advanced → Store URL. Running the local Store is described in `docs/guides/local-e2e-testing.md`.

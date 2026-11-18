# Independently buildable participant service

Each installation is independent: its operator owns the server/domain, Google OAuth client, users, projects and backups. It does not contact a central account service or depend on this developer's Mac after setup. GitHub distributes source; it does not store your private projects or run compilation. Invited collaborators use their own Google accounts on your instance; only the operator creates an OAuth client. Google handles identity, and your server controls project access. Opening the operator's URL selects that installation; accounts and invitations do not grant access to a different installation. Browser recovery belongs to that site's browser storage and does not automatically migrate to another domain.

The runtime in this directory is covered by its [AGPL-3.0 license](../LICENSE), including the hosting configuration/helper; the other bundled runtime and identity components retain their adjacent licenses and notices. The repository's root proprietary notice explicitly preserves these component licenses. Independent operators may run and modify these components under their licenses and must provide their corresponding modified AGPL source to network users. No relicensing of unrelated repository material is included.

## Configure your own instance

1. Obtain the source and build the image below. Use your own domain and HTTPS reverse proxy to the loopback port. The public hostname/TLS setup is specific to your server; never expose MongoDB, Redis or a Docker socket.
2. In your own [Google Auth Platform](https://console.cloud.google.com/auth/clients) project, create a **Web application** client with the exact redirect `https://YOUR_DOMAIN/oidc/login/callback`. Download its JSON privately. A desktop client is not suitable. Keep testing and public production clients separate.
3. From this repository root, generate a private configuration outside Git. The helper reads your JSON locally, creates independent random session/invitation secrets, validates the exact callback and never overwrites an existing file or prints credentials:

   ```sh
   node runtime/participant-compile/hosting/configure.mjs \
     https://YOUR_DOMAIN /private/path/google-client.json \
     "$HOME/.config/collaborative-latex/own-server.env"
   ```

4. Use the same private file for Compose interpolation and container configuration. Keep the project name stable: it identifies your persistent volumes. Run all later `exec`, `stop`, `start` and `up` commands with these same settings:

   ```sh
   LATEX_ENV_FILE="$HOME/.config/collaborative-latex/own-server.env" \
   docker compose --project-name own-latex \
     --env-file "$HOME/.config/collaborative-latex/own-server.env" \
     -f runtime/participant-compile/hosting/compose.yml up -d --build
   ```

5. Create the first administrator with the native CLI below using those same Compose arguments. Test your own Google login/logout/repeat login, owner/member invitations, outsider refusal, restart persistence and a restore into fresh isolated volumes before enabling public routing. Native local accounts remain available; nobody needs our demo passwords. Source export and the encrypted full backup procedure below support moving your installation.

This helper uses the project's existing Node build/configuration runtime and standard library; it adds no dependency or separate installed tool. Run it on your Linux server or Mac, where it creates a mode-0600 file; it refuses Windows because Windows ACL provisioning is not implemented. Windows participants can still use the browser app. Keep the generated file and downloaded JSON private, retain persistent keys during upgrades and store them in your encrypted backup. Never put Google client secrets in a browser bundle or offline download. The independent service is prepared locally; an actual public host/TLS/production callback and off-host restore are still unqualified.

This candidate builds directly from the pinned public CE+ image and verified BusyTeX1.4.1 resources. It does not require the Mac's local preamble/TeX images. The application and Rust metadata helper are AMD64; native TeX compilation is disabled at the shared compile entry point. All project pages use participant compilation automatically. Individual native logins, invitations, PDF/source navigation, live carets, recovery and the verified-identity OIDC fixes are included. Building the image does not activate an OIDC provider or mail service; each operator configures their own.

From the repository root, build with:

```sh
docker build --platform linux/amd64 -f runtime/participant-compile/hosting/Dockerfile -t latex-participant:local .
```

Builds download public compiler assets (about522MB compressed) and verify their digests before extraction. The browser's measured larger fixture transferred about661MiB of worker resources, with about152MiB allocated WASM linear memory; that is not total browser RAM or a WAN guarantee. Preserve all upstream notices and make the corresponding modified AGPL source available with any network deployment. The full TeX/font notices remain in the public data packages.

The adjacent Compose file binds the application to loopback; it does not configure a public domain or TLS. Use the private configuration generated above with the same `LATEX_ENV_FILE`, `--env-file` and project name on every command. The helper creates independent persistent session/invitation secrets; preserve them through upgrades. Choose an unused local port with the helper's optional fourth argument if its default is occupied. MongoDB and Redis have no host ports; no service mounts the Docker socket or a user's home directory. Named volumes persist across restarts. Do not run `down -v` on a real installation.

Create the first individual administrator with the native CLI:

```sh
LATEX_ENV_FILE="$HOME/.config/collaborative-latex/own-server.env" \
docker compose --project-name own-latex \
  --env-file "$HOME/.config/collaborative-latex/own-server.env" \
  -f runtime/participant-compile/hosting/compose.yml \
  exec -w /overleaf/services/web app \
  node modules/server-ce-scripts/scripts/create-user.mjs --admin --email=YOUR_EMAIL
```

The command prints a private activation link. Open it directly and keep it out of shared logs. Create each additional user with the same command without `--admin`, then use the native Share invitation and accept it from that user's own login. Verify public registration restrictions before exposure. Do not share an administrator password. Public origins must use HTTPS; hosted settings enforce secure cookies automatically. SMTP/reset delivery, actual domain/HTTPS, reverse-proxy trust and provider account setup must be configured and checked for the selected host; they are not silently provided by this template. Keep secrets and all durable data in encrypted backups following [the cold restore procedure](../BACKUP.md).

Google login is required before the first publication. Create a **Web application** client in [Google Auth Platform](https://console.cloud.google.com/auth/clients), register the exact `OVERLEAF_SITE_URL` plus `/oidc/login/callback`, and put its ID/secret only in the private configuration generated above. A loopback trial does not qualify the eventual public callback. The template requests only OpenID identity, email and profile. Google owns authentication; project roles and invitations stay in this app. Preserve subject/verified-email checks, test first login, repeat login, explicit local-account linking and local logout, and confirm an uninvited Google user cannot open another user's private project. Real Google tests require the account-owned client and interactive consent; synthetic identity tests do not pass that gate. See the [existing identity integration](../../../integrations/ce-plus-oidc/README.md) and [Google's setup requirements](https://developers.google.com/identity/openid-connect/openid-connect).

Local Google first login, protected-page refusal after logout and repeat login were user-confirmed on 16 November 2026; the persisted provider mapping stayed unique. The public deployment remains pending. Use a separate production Google project/client with public HTTPS-only callbacks when preparing a broadly shared production service, following [Google's OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies). Keep the local client for testing. Confirm Audience/Branding settings for that production project; the basic-identity scope exception to testing allowlists is documented in [Google's app-state overview](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview).

The free-host candidate remains unaccepted: Oracle's larger Always Free machines are ARM, while this app is AMD64. Local Rosetta tests do not qualify Linux ARM/QEMU. Provider signup/card requirements, capacity, idle reclamation, network quotas, HTTPS and real off-host backup need an actual host check. There is no independently hosted URL or public release yet, and this template never authorizes a paid upgrade.

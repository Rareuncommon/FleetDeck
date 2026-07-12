# FleetDeck Deployment Runbook

FleetDeck runs as a plain Docker image, deployed on TrueNAS SCALE as a Custom App. This runbook covers the app setup, a safe first bring-up, the one manual iPXE migration step, and rollback.

---

## 1. TrueNAS SCALE Custom App setup

In the TrueNAS SCALE UI: **Apps > Discover Apps > Custom App** (labeled "Launch Docker Image" on some builds — menu labels may vary slightly by TrueNAS SCALE version).

**Image**

- Repository/tag: your built image, e.g. `fleetdeck:latest` (push it to a registry the box can reach, or load it locally).

**Port mapping**

- Container port `8080` → a host port on the LAN, e.g. `8080`.
- FleetDeck serves the UI, API, live-update WebSocket (`/ws`), and `/boot/*` all on this one port.
- Because `/boot/*` is unauthenticated (firmware can't log in), keep this on the LAN only.

**Boot-file serving — the ipxeboot container is retired**

FleetDeck now serves the entire boot chain itself, replacing the separate nginx+dnsmasq `ipxeboot` container:

- **HTTP**: `wimboot` and the WinPE media are served (with Range support — wimboot fetches ranged) at `/boot/files/*`, backed by `<BOOTFILES_DIR>/http/`. `winpe.ipxe` is **generated** at `/boot/files/winpe.ipxe` from what's actually on disk — including real filename case, which kills the `bcd` vs `BCD` class of bug — so there is no hand-edited script to drift.
- **TFTP**: an in-process, read-only TFTP server hands out `snponly.efi` from `<BOOTFILES_DIR>/tftp/` on udp/69. This requires **host networking** (the deployment already uses it) and root in the container; if the bind fails, FleetDeck logs a warning and keeps running, and `TFTP_ENABLED=0` opts out entirely if you prefer an external TFTP server.
- Because one process writes and serves these files on its own volume, the recurring 403s from copied-in files lacking `o+r` on the old container are structurally gone.

**Migration**: stop and remove the old `ipxeboot` container after copying `snponly.efi` into `<BOOTFILES_DIR>/tftp/` and any staged media into `<BOOTFILES_DIR>/http/media/`. Your DHCP/UniFi network-boot settings don't change as long as FleetDeck runs on the same host IP the DHCP boot server already points at (filename stays `snponly.efi`). The **Setup tab** shows presence/size of every required file and a live "first boot request seen" indicator that confirms the DHCP settings actually work.

**Frontend and live updates**

- The web UI is plain static files (`index.html`, `app.css`, `app.js`) — there is **no build step**, so deployment is unchanged: build the image, run it. Nothing to compile.
- The dashboard receives live updates over a WebSocket at `/ws` on the same port, authenticated with the same session cookie as the API. If you put a reverse proxy in front of FleetDeck, it must pass WebSocket upgrades through for `/ws` (e.g. nginx `proxy_set_header Upgrade/Connection`); if it doesn't, nothing breaks — the UI automatically falls back to its 10-second polling.

**Environment variables**

Set these in the app's environment config:

| Variable | Value |
|----------|-------|
| `TRUENAS_URL` | Websocket JSON-RPC endpoint, e.g. `wss://192.168.1.36:8444/websocket` (verify the port on your build). |
| `TRUENAS_API_KEY` | API key from **Settings > API Keys**. |
| `ADMIN_PASSWORD` | FleetDeck admin UI password. |
| `COOKIE_SECRET` | Random secret for signing session cookies. |
| `HTTP_PORT` | `8080` (match the container port above). |
| `DRY_RUN` | `1` for first bring-up (see step 2). |
| `DB_PATH` | `/data/fleetdeck.sqlite3`. |
| `IQN_PREFIX` | `iqn.2005-10.org.freenas.ctl`. |
| `GOLDEN_ZVOL` | e.g. `Main_pool/iscsi/win-golden`. |
| `CLIENT_ZVOL_ROOT` | e.g. `Main_pool/iscsi`. |
| `POOL_NAME` | Pool name for capacity alerting, e.g. `Main_pool`. Defaults to `CLIENT_ZVOL_ROOT`'s first segment. |
| `BOOTFILES_DIR` | Boot-chain file storage (wimboot, WinPE media, snponly.efi). Defaults to `<dir of DB_PATH>/bootfiles`, i.e. on the same persistent `/data` volume. |
| `TFTP_ENABLED` | `1` (default) = FleetDeck serves TFTP itself for `snponly.efi`. Set `0` to keep an external TFTP server. |
| `TFTP_PORT` | TFTP port, default `69`. Port 69 requires host networking + root in the container. |

A few more tunables (`wol_enabled`, `wol_broadcast`, `pool_alert_threshold_pct`, `safety_snapshot_retention_days`, `nightly_reset_cron`, `winpe_chain_url`, `golden_build_default_minutes`) live in the in-app Settings panel, not as env vars — they take effect immediately without a restart. See "Rebuilding the golden image (Golden Build Mode)" below for the last two.

**Wake-on-LAN and container networking**

If you enable `wol_enabled`, be aware the default bridge networking used by the Custom App (and docker-compose) blocks WoL's limited broadcast to `255.255.255.255` — the packet never leaves the bridge and machines silently don't wake. Either:

- run the container with **host networking**, which sends the broadcast straight out the host's NIC (the reliable option), or
- keep bridge networking and set the `wol_broadcast` setting (in-app Settings tab) to your LAN's **directed broadcast** address, e.g. `192.168.1.255`. Some routers/switches drop directed broadcasts — if machines still don't wake, switch to host networking.

**Volume / storage**

- Add a **host-path volume** mounting a persistent dataset to `/data` in the container.
- This is where the SQLite file (`DB_PATH`) lives. Without it, all client/event state is lost on every app restart or upgrade.

**One-time golden target for client creation**

FleetDeck creates each new client's iSCSI target by copying the portal/initiator group configuration from an existing, working target — preferably the golden zvol's target (e.g. `win-golden`), else any target that has portal groups. Portal groups are what publish a target on a portal; the right portal/initiator ids are site-specific, so FleetDeck copies rather than guesses. Before creating the first client, make sure at least one working target exists in the TrueNAS UI (**Shares > iSCSI > Targets**) bound to the portal your fleet boots from. If none exists, client creation fails up front with nothing created.

**One-time dataset for the safety-snapshot feature**

Every reset/rebase/retire quarantine-clones the client's pre-wipe zvol into `<CLIENT_ZVOL_ROOT>/_safety/...` before destroying it, as a brief undo window. ZFS clone does not create intermediate datasets, so create the parent once before first use:

```
zfs create Main_pool/iscsi/_safety
```

If this dataset doesn't exist, the safety-snapshot step fails closed (logged as `client.safety_snapshot.failed`) and the wipe proceeds anyway — you lose the undo window silently rather than being blocked. Create it during initial setup so it's protected from the start.

---

## 2. First bring-up procedure

Bring FleetDeck up in read-only mode before it's allowed to touch anything, then drive the whole TrueNAS-side setup from the **Setup tab** instead of clicking through the TrueNAS UI:

The Setup tab's wizard checks and (with one confirmation each) creates: the client + `_safety` datasets, the golden zvol (sparse, 64K blocks, size prompt), iSCSI service enable+start, the portal (0.0.0.0:3260), an allow-all initiator group, the `win-golden` target **with portal groups** (an ungrouped target is unreachable — the wizard flags that exact misconfiguration), the device extent, and the LUN 0 mapping. Every step is idempotent and re-runnable: what already exists is reported, not re-created. With `DRY_RUN=1` each Create button shows the exact would-be RPC payloads and executes nothing — so you can walk the entire wizard in dry-run first and read precisely what it plans to do. Steps this TrueNAS build can't do over the API render as instructions for the TrueNAS UI, never as buttons that error. The manual steps (DHCP network boot, compiling `snponly.efi`) appear as checklist items with exact values prefilled — including a generated docker build command for `snponly.efi` with this instance's chain URL embedded, an upload button for a prebuilt binary, and a live "first boot request seen" indicator that proves the DHCP step worked. A re-runnable **Diagnostics** panel self-tests the whole chain: TrueNAS connection, golden zvol/target-groups, every boot file, a ranged HTTP self-fetch, and a real TFTP self-read.

1. Start the app with **`DRY_RUN=1`**.
2. Open the dashboard and log in with `ADMIN_PASSWORD`.
3. Confirm FleetDeck's introspection worked: it should show your real `win-golden` snapshots (`@gold-vN`) and any existing iSCSI targets, read-only. Nothing should be created or changed.
4. Check **Settings > Test connection** as a quick, on-demand way to re-verify connectivity at any point without restarting the app.
5. Try the **Reconcile** tab: it lists any existing TrueNAS iSCSI targets FleetDeck doesn't know about yet (useful if you have machines provisioned by hand before adopting FleetDeck) and any FleetDeck client rows whose TrueNAS target has disappeared. Both actions here (import, remove stale row) are non-destructive to TrueNAS — safe to explore even before arming `DRY_RUN=0`.
6. Watch the events log — with `DRY_RUN=1`, actions you trigger appear as logged-but-skipped mutations. This is your proof that the TrueNAS connection and permissions are correct.
7. Once introspection looks right, set **`DRY_RUN=0`** and restart the app to arm real mutations.

Do not set `DRY_RUN=0` until step 3 is confirmed. A bad `TRUENAS_URL`, key, or zvol path is harmless in dry-run and destructive once armed.

---

## 3. The iPXE migration (one manual step)

This is the most important part of the cutover. FleetDeck replaces the nginx server at `192.168.1.246` that currently serves `/boot/<mac-hexhyp>.ipxe`. The network boot chain runs an iPXE script **embedded inside `snponly.efi`**, and that embedded script hardcodes the chain URL. To move the fleet to FleetDeck you rebuild `snponly.efi` with a new chain URL.

### a. Edit the embedded iPXE script

Locate the iPXE source's embedded script — typically a text file (often named `embed.ipxe` or similar) passed to iPXE's build via `EMBED=`. Find the line that chains to the current boot server:

```
chain http://192.168.1.246/boot/${net0/mac:hexhyp}.ipxe
```

Change the host:port to point at your FleetDeck deployment. Since the Custom App runs on the TrueNAS box, that's usually the TrueNAS host itself:

```
chain http://192.168.1.36:8080/boot/${net0/mac:hexhyp}.ipxe
```

Adjust the IP and port to match your actual FleetDeck deployment (`HTTP_PORT` / the host port you mapped).

### b. Rebuild `snponly.efi`

From a checkout of the iPXE source with a build toolchain installed, rebuild the binary with your edited embed script:

```
make bin-x86_64-efi/snponly.efi EMBED=/path/to/embed.ipxe
```

Notes:

- This is a one-time rebuild on a build host, not a FleetDeck runtime concern. FleetDeck never builds or serves the `.efi`.
- Point `EMBED=` at the absolute path of the script you edited in step (a).
- Use the target that matches your firmware (`bin-x86_64-efi/snponly.efi` for x86-64 UEFI).

### c. Redeploy the rebuilt `snponly.efi`

Copy the rebuilt `snponly.efi` back to wherever TFTP currently serves it from.

- **TFTP does not move.** FleetDeck does not serve TFTP in v1 — the TFTP server stays exactly where it is. Only the HTTP chain URL embedded in the binary changes.

### d. Test with ONE client before rolling to the fleet

1. PXE-boot a single test machine.
2. Confirm it hits FleetDeck: check FleetDeck's events log for a `boot.serve` entry for that MAC.
3. Confirm the client still sanboots correctly into Windows.

Only after one client is validated end-to-end should you consider the migration good for the rest of the fleet.

---

## 4. Rollback

- Keep the old nginx boot server (`192.168.1.246`) running **read-only** until the migration is validated across the whole fleet.
- Reverting is simply re-flashing the **old** `snponly.efi` (the one that chains to `192.168.1.246`). Keep a copy of it before you overwrite anything.
- Because the old server is untouched and still serving, rollback is just swapping the binary back — no data migration, no TrueNAS changes.

---

## 5. Rebuilding the golden image (Golden Build Mode)

Golden Build Mode is FleetDeck's replacement for the old manual process of hand-dropping a static per-MAC `.ipxe` override file into the separate `ipxeboot` container's `http/boot/` directory every time you needed to service the golden image. FleetDeck now serves that boot script dynamically, gated by an audited, time-limited, one-at-a-time session.

**What it does — and why it's dangerous.** Arming a MAC makes FleetDeck serve it a boot script that `sanhook`s it **directly onto the live `win-golden` zvol** (no clone) and chains into WinPE. Anything that machine writes lands permanently on the golden image that *every* future client is cloned from. This is fundamentally different from **Adopt**, which clones golden into a new per-client zvol and joins the managed fleet. The two are deliberately separate actions in the UI (Adopt is teal; "Boot into Golden Build Mode" is amber with an explicit confirmation modal).

**Settings (in-app Settings tab, not env vars):**

| Setting | Purpose |
|---------|---------|
| `winpe_chain_url` | URL of the WinPE chain script. FleetDeck now generates and serves one itself — point this at `http://<fleetdeck-host>:<port>/boot/files/winpe.ipxe` (an external URL still works if you host WinPE elsewhere). **Must be set** before Golden Build Mode can be armed — arming returns a clear error if it's empty. |
| `golden_build_default_minutes` | Default session duration when the arm request doesn't specify one (default `240`). |

**The served script** (for the armed MAC only):

```
#!ipxe
set keep-san 1
sanhook --drive 0x80 iscsi:<TRUENAS_HOST>::::<IQN_PREFIX>:<golden target>
chain <winpe_chain_url>
```

`<golden target>` is the last path segment of `GOLDEN_ZVOL` (e.g. `win-golden`); host and IQN prefix come from config/settings, same as normal client boot scripts.

**Session phases.** A session starts in the `install` phase (armed MAC gets `sanhook` + chain into WinPE for imaging). After the deploy script finishes — image applied, `bcdboot` run — switch the session to `boot_installed` from the Golden-tab banner: the machine's next PXE boot gets a plain `sanboot` of the golden target and runs the freshly installed OS for OOBE/drivers/sysprep. This replaces the manual static-file override the old flow needed the moment the install finished. The banner shows the current phase, and switching back to `install` re-serves WinPE (e.g. to redo a failed apply).

**The generated deploy script.** `GET /boot/files/deploy.cmd` (also snapshotted into the SMB share at arm time) collapses the entire WinPE command marathon into one commented script: diskpart (GPT, 300 MB ESP → S:, MSR, NTFS → W:) with the target disk chosen by **typed number + typed confirmation** against a size hint from the real golden zvol — never a blind `select disk 0`; `dism /Get-WimInfo` then apply with `/SWMFile:` automatically when split `.swm` media was detected (Windows Setup silently cannot install from split images) and `/ScratchDir:W:\` always (the WinPE RAM-disk scratch caused real failures); `bcdboot W:\Windows /s S: /f UEFI`; offline `SYSTEM`-hive edits setting `Start=0` on `MSiSCSI`, `iScsiPrt`, and every NIC service from the `nic_boot_services` setting (only keys that exist — missing ones warn, they're not created) — the fix for post-install `INACCESSIBLE_BOOT_DEVICE`; and installation of the disk-offline safety script (`/boot/files/fleetdeck-safety.ps1` → `W:\FleetDeck\`) registered via a **RunOnce → schtasks** entry rather than offline TaskCache writes (offline task registration means hand-crafting undocumented registry blobs; RunOnce is deterministic across builds). `golden_image_index` (setting) pre-bakes the dism index; blank prompts in WinPE.

**Fetching the script in WinPE:** SMB is the guaranteed transport (`net use M: \\<truenas-host>\fleetdeck-bootfiles && M:\deploy.cmd`) — PowerShell is an optional WinPE component (`WinPE-PowerShell`), present on most retail Setup media but not promised, so where it exists `powershell -c "iwr http://<fleetdeck-host>/boot/files/deploy.cmd -OutFile X:\d.cmd" && X:\d.cmd` is the one-liner alternative.

**Flow** (mirrored as a tick-off checklist in the Golden-tab banner, persisted per session):

1. In Settings, set `winpe_chain_url` (normally FleetDeck's own `/boot/files/winpe.ipxe`).
2. On the Dashboard, in **Discovered clients**, click **Boot into Golden Build Mode** on the target machine's MAC and confirm the modal. (Arming performs no TrueNAS mutation — it only changes what FleetDeck serves next. It is intentionally **not** gated by `DRY_RUN`; see the note below.)
3. PXE-boot that machine. It sanhooks onto `win-golden` and boots WinPE.
4. In WinPE, fetch and run the deploy script (commands above).
5. Switch the session phase to `boot_installed`, reboot the machine, complete OOBE/drivers/software.
6. Sysprep exactly `C:\Windows\System32\Sysprep\sysprep.exe /generalize /oobe /shutdown` (no `/mode:vm`), shut down.
7. Click **End session** in the banner (or let it auto-expire). Then promote a new `gold-vN` from the Golden tab as usual.

**Guardrails:**

- **One session at a time.** Two machines `sanhook`-ing the same LUN concurrently can corrupt the golden filesystem, so FleetDeck refuses to arm a second machine while one is active, and additionally refuses to arm if TrueNAS already reports a live iSCSI session on the golden target.
- **Auto-expiry** closes the session after its duration so a forgotten session doesn't leave golden writable indefinitely. **Note:** expiry (and manual End) only stop the script from being served on a *future* PXE attempt — neither can forcibly disconnect a machine that is already connected. Reboot the machine or disconnect it in TrueNAS to end a live connection.
- **`DRY_RUN` does not protect golden here.** `DRY_RUN=1` gates FleetDeck-initiated TrueNAS mutations (clone/create/delete); it does not gate boot-script serving, and Golden Build Mode is a serving change. An armed machine can therefore write to golden even under `DRY_RUN=1`. The real safety mechanisms are the single-session invariant, the golden-target session check, and the confirmation modal — not `DRY_RUN`.

**Fallback.** The old manual method (a static per-MAC `.ipxe` file dropped into the `ipxeboot` server's `http/boot/`) still works if you ever need it, but it is no longer the documented primary path.

---

## 6. Guest-fleet features

**Safety-script heartbeat contract.** The golden image's disk-offline scheduled task should, at startup, POST to FleetDeck (unauthenticated — the machine has no credentials at boot):

```
POST http://<fleetdeck-host>:<port>/boot/<mac-with-dashes-or-colons>/heartbeat
Content-Type: application/json

{"safety_script_ran": true}
```

e.g. from the safety `.ps1`: `Invoke-RestMethod -Method Post -Uri "http://192.168.1.36:8080/boot/$((Get-NetAdapter | Select -First 1).MacAddress)/heartbeat" -Body '{"safety_script_ran":true}' -ContentType 'application/json'`. FleetDeck stamps `last_heartbeat_at`; a booted client whose heartbeat hasn't arrived since its last boot gets a **"no heartbeat"** warning badge (the safety script may not have run). The generated `fleetdeck-safety.ps1` is a good place to add this call when you extend it.

**Guest idle timeout.** `guest_idle_timeout_minutes` (Settings; 0 = disabled) reclaims machines whose session has been active longer than the limit, via a forced reset. **Limitation, stated plainly:** TrueNAS exposes no per-session idle/last-activity metric, so this enforces total session *duration*, not true idleness. Each session is reset at most once (the iSCSI session can outlive the reset until the machine reboots).

**Public status page.** `GET /status` is intentionally unauthenticated and strictly minimal: machine display names + available/in-use, plus the `guest_motd` banner (Settings). No MACs, zvols, or other detail — it's the walk-up "which machine is free" board. This and `/boot/*` are the only unauthenticated data-bearing routes.

**Kick.** The TrueNAS API cannot terminate a specific iSCSI session (there is no such RPC in v25.10), so the drawer's "Kick" is labeled and implemented as a **forced reset**: the disk is wiped and re-cloned under the live session; the machine keeps running from cache until it reboots.

**QR stickers.** Each client's detail drawer offers a print-friendly QR (generated server-side with the pure-JS `qrcode` package) linking to the static `/troubleshoot.html` guest help page.

---

## 7. Fleet operations

**Tags & per-tag maintenance.** Clients carry comma-separated `tags` (edited in the detail drawer); the dashboard shows filter chips, and the Settings tab has **maintenance windows** — per-tag cron schedules with a `reset` or `wake` action, run by the scheduler alongside the global nightly cron (blank tag = whole fleet; scheduled resets always force). **Wake all** and CSV/JSON **exports** (client table, Audit tab) are also on those tabs; exports generate client-side from already-loaded data.

**Webhooks.** Set `webhook_url` and `webhook_events` (comma-separated: `pool_warning`, `reset_failed`, `nightly_summary`). FleetDeck POSTs a generic `{event, ts, ...data}` JSON body — not Discord/Slack-specific, so it works with either via their incoming-webhook adapters. To send a formatted Discord/Slack embed, point `webhook_url` at a small relay that reshapes this payload.

**Monitoring.** `GET /healthz` (unauthenticated, `{ok, truenas, dryRun}`) for uptime checks; `GET /metrics` (unauthenticated, Prometheus text) exposes `fleetdeck_clients_total`, `_clients_booted`, `_truenas_connected`, `_dry_run`, `_pool_used_percent` — counts and state only, no identities. The dashboard's pool-used tile shows a sparkline from the `pool_history` series the pool monitor records every 5 minutes.

**Update check.** FleetDeck checks the latest GitHub release tag once a day and shows an "update available" badge in Settings. No auto-update — updates stay manual.

**Multiple admins.** The Settings tab manages named local accounts (scrypt-hashed). While the `admins` table is empty, the `ADMIN_PASSWORD` env var logs in as `admin` (existing deployments are untouched); once any named account exists, only those accounts work, the login form's username field is required, and the last account can't be deleted (lockout guard). `session_timeout_minutes` (default 720) sets the cookie lifetime, replacing the old hardcoded 12h.

**Backup / restore.** Settings → **Download backup** streams a consistent `VACUUM INTO` copy of the SQLite state (not the live file). **Restore** validates the upload is a compatible FleetDeck database, then replaces every table on the live connection inside one transaction (so no restart is needed); it requires typing `RESTORE FLEETDECK` to confirm. Boot files are not part of the backup.

**API-key rotation.** TrueNAS doesn't expose API-key creation dates, so set `api_key_created_at` (e.g. `2026-07-01`) when you create/rotate the key; Settings shows a banner once it exceeds `api_key_max_age_days` (default 180).

**Build provenance.** `GIT_COMMIT` and `BUILD_DATE` (Docker build args, baked to env) show in Settings and `/api/system/info`.

---

## 8. Reliability & observability

- **Live audit tail**: the Audit tab streams new events over the WebSocket with severity coloring (failures red, warnings amber), plus server-side filters (action prefix, date range) so large histories filter on the server, not the browser.
- **Connection health**: a dot in the sidebar (visible on every tab) shows the TrueNAS connection — green connected, amber *reconnecting* with the attempt count and a live "retry in Ns" countdown (so a recovering box reads as recovering, not broken), red down.
- **Per-client last error**: a ⚠ icon on each dashboard row surfaces that client's most recent failed audit event on hover, instead of it being buried in the Audit tab.
- **Self-test**: Settings → *Run self-test* re-runs the same checks as the Setup-tab Diagnostics (TrueNAS connectivity, golden zvol/target groups, `_safety`, boot files, ranged HTTP self-fetch, TFTP self-read).
- **Config warnings**: Settings surfaces recommended-but-unset configuration (no webhook, API-key age tracking off, WoL broadcast mismatch, DRY_RUN armed) instead of leaving it to the console at boot.
- **DRY_RUN banner**: a persistent, high-contrast banner rides above every tab whenever `DRY_RUN=1`.
- **What's new**: `CHANGELOG.md` is parsed into a Settings panel with a per-admin unread indicator (last-seen version stored on the account, so it follows the operator across machines rather than relying on browser storage).

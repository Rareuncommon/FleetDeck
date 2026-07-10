# FleetDeck

FleetDeck is a single-container web app that manages a diskless Windows gaming fleet booting over iSCSI from TrueNAS SCALE. It replaces the manual workflow of hand-editing per-client iPXE scripts and clicking through the TrueNAS UI to clone, snapshot, and retire zvols. One dashboard drives the whole fleet: create a client, reset it to golden, rebase it onto a new golden version, retire it, or promote a new golden image — each as a single action, with every TrueNAS mutation recorded in an events log.

## Features

- **Dashboard** — live view of every client, its zvol clone, iSCSI target, and last boot; updates are pushed over a WebSocket (`/ws`, same session auth) with automatic fallback to polling. Sortable/searchable client table with pagination, bulk actions (reset/retire/rebase/nightly), a per-client detail drawer with audit history and snapshot lineage, and a Cmd/Ctrl+K command palette.
- **One-click client lifecycle** — create, reset, rebase, retire, and promote-golden, each a single action against TrueNAS.
- **Bulk reset + nightly cron** — reset the whole fleet at once, or on a schedule (`node-cron`) for a clean image every morning.
- **iPXE script serving** — serves per-client boot scripts at `/boot/<mac-hexhyp>.ipxe`, with an unknown-MAC discovery/adopt flow so new machines show up in the dashboard ready to be provisioned.
- **Golden Build Mode** — arm a machine to boot directly into the live golden image (`sanhook`, not a clone) to service it in place, replacing hand-editing override files on the `ipxeboot` container. Deliberately distinct from Adopt: one session at a time, time-limited with auto-expiry, refuses if TrueNAS already has a session on the golden target, audited throughout. Sessions have two phases — `install` (WinPE imaging) and `boot_installed` (sanboot the installed OS) — with a guided, persisted checklist and a **generated `deploy.cmd`** that automates the whole WinPE marathon: confirmed diskpart, split-WIM-aware `dism` apply, `bcdboot`, the offline-registry `INACCESSIBLE_BOOT_DEVICE` fixes, and safety-script install. See [docs/DEPLOY.md](docs/DEPLOY.md).
- **Integrated boot-chain serving** — FleetDeck serves everything the boot chain needs itself: TFTP for `snponly.efi` (in-process, read-only), HTTP with Range support for `wimboot`/WinPE media at `/boot/files/*`, and a **generated** `winpe.ipxe` that always references the real on-disk media filenames (case included). The separate nginx+dnsmasq container is retired.
- **First-run Setup Wizard** — the Setup tab checks and (idempotently, with per-step confirmation and full DRY_RUN payload preview) creates the whole TrueNAS side: datasets, the golden zvol (sparse, 64K blocks), iSCSI service, portal, allow-all initiator group, and the golden target/extent/LUN-0 mapping with real portal groups. Manual steps (DHCP network boot, compiling `snponly.efi`) render as honest checklists with exact values, a generated build command, and a live "first boot request seen" detector. A re-runnable Diagnostics panel self-tests the whole chain, including a real TFTP read and a ranged HTTP self-fetch.
- **DRY_RUN safety** — introspect TrueNAS read-only before letting FleetDeck mutate anything.
- **Auto safety-snapshot** — every reset/rebase/retire quarantine-clones the client's pre-wipe zvol before touching it, giving a brief undo window (purged automatically after a retention period).
- **Wake-on-LAN** — optionally sends a magic packet after a successful reset/rebase, so a nightly wipe leaves the machine booted and ready by morning (opt-in; requires WoL enabled on each client's NIC/firmware).
- **Pool capacity alerting** — polls the TrueNAS pool's used/available space and logs a warning once usage crosses a configurable threshold.
- **Reconciliation** — scan for TrueNAS iSCSI targets FleetDeck doesn't know about (import them as clients) and FleetDeck clients whose TrueNAS target has vanished (remove the stale row).
- **Bulk CSV import** — onboard many machines at once instead of one at a time.
- **On-demand connection test** — check TrueNAS connectivity from Settings without restarting the app.

## Data model

SQLite (`better-sqlite3`), five tables:

| Table | Holds |
|-------|-------|
| `clients` | Provisioned machines: MAC, hostname, clone zvol, iSCSI target, golden version, state. |
| `settings` | Key/value app config (e.g. current golden version, cron schedule). |
| `events` | Append-only audit log of every action and TrueNAS mutation. |
| `discovered` | Unknown MACs seen at `/boot/*`, awaiting adopt. |
| `safety_snapshots` | Quarantine clones made before destructive ops, purged after a retention window. |

## Running it

### Docker (recommended)

```bash
cp .env.example .env      # fill in secrets and TrueNAS details
docker compose up --build
```

Then open `http://<host>:8080`.

### Local dev

```bash
npm install
cp .env.example .env      # keep DRY_RUN=1 for safe, read-only introspection
npm start
```

With `DRY_RUN=1`, FleetDeck talks to TrueNAS read-only and logs — but never executes — mutations. Ideal for developing against a real box without touching it.

## Environment variables

Set as env vars in the TrueNAS Custom App, or via `.env` for local/compose. See `.env.example` for the authoritative list.

| Variable | Purpose | Default / Example |
|----------|---------|-------------------|
| `TRUENAS_URL` | TrueNAS websocket JSON-RPC endpoint (port varies by build). | `wss://192.168.1.36:8444/websocket` |
| `TRUENAS_API_KEY` | TrueNAS API key (Settings > API Keys). Secret. | `REPLACE_ME` |
| `ADMIN_PASSWORD` | FleetDeck admin UI password (single admin account). Secret. | `REPLACE_ME` |
| `COOKIE_SECRET` | Secret used to sign session cookies. Secret. | `REPLACE_ME` |
| `HTTP_PORT` | Port the HTTP server (UI + API + `/boot/*`) listens on. | `8080` |
| `HTTP_BIND` | Bind address. Keep on the LAN — `/boot/*` is unauthenticated. | `0.0.0.0` |
| `DRY_RUN` | `1` = log TrueNAS mutations without executing them. | `1` |
| `DB_PATH` | Path to the SQLite state file (mount a volume over its dir). | `/data/fleetdeck.sqlite3` |
| `IQN_PREFIX` | Base IQN for iSCSI targets. | `iqn.2005-10.org.freenas.ctl` |
| `GOLDEN_ZVOL` | Zvol path for the golden (sysprepped) image; snapshots `@gold-vN`. | `Main_pool/iscsi/win-golden` |
| `CLIENT_ZVOL_ROOT` | Root dataset path where per-client clone zvols live. | `Main_pool/iscsi` |
| `POOL_NAME` | Pool name for capacity alerting. Defaults to `CLIENT_ZVOL_ROOT`'s first path segment. | `Main_pool` |

A few more tunables live in the in-app Settings panel rather than as env vars (`wol_enabled`, `wol_broadcast`, `pool_alert_threshold_pct`, `safety_snapshot_retention_days`, `nightly_reset_cron`) since they're safe to change at runtime without a restart.

### Wake-on-LAN networking

WoL magic packets are UDP broadcasts, and the container's network mode decides whether they can reach the LAN at all. With the default bridge networking (docker-compose and the TrueNAS Custom App both use it), a limited broadcast to `255.255.255.255` never leaves the bridge — WoL silently does nothing. Two options:

- **Host networking** on the container — the limited broadcast goes straight out the host's NIC. This is the reliable option.
- **Bridge networking + `wol_broadcast`** — set the `wol_broadcast` setting (Settings tab) to your LAN's directed broadcast address, e.g. `192.168.1.255`, which the bridge can route out. Note that some routers/switches drop directed broadcasts; if WoL still doesn't wake machines, use host networking instead.

### Golden-target prerequisite for client creation

New clients copy their iSCSI portal/initiator group configuration from an existing, working target — preferably the target for the golden zvol (e.g. `win-golden`), else any target that has portal groups. Those groups are what publish a target on a portal; without them a target is invisible to initiators, and the correct portal/initiator ids are site-specific, so FleetDeck refuses to guess. Before creating your first client, create at least one working target (the golden target) in the TrueNAS UI with the portal group your fleet boots from. If none exists, client creation fails with a descriptive error before anything is created.

### Safety-snapshot prerequisite

The auto safety-snapshot feature clones each pre-wipe zvol into `<CLIENT_ZVOL_ROOT>/_safety/...` before destroying it. ZFS clone does not create intermediate datasets, so the `_safety` dataset must exist under your client zvol root *before* the first reset/rebase/retire, e.g.:

```
zfs create Main_pool/iscsi/_safety
```

If it's missing, quarantining silently fails closed (logged as `client.safety_snapshot.failed` in the audit log) and the wipe proceeds with no undo window — not blocked, just unprotected. Create it once during initial setup.

### The DRY_RUN safety flag

`DRY_RUN=1` is the seatbelt for first bring-up. FleetDeck still reads TrueNAS — you'll see your real golden snapshots and existing targets in the dashboard — but any action that would clone, snapshot, delete, or reconfigure a zvol/target is written to the events log and skipped. Confirm introspection looks right, then set `DRY_RUN=0` to arm mutations.

## Non-goals for v1

- No TFTP server (TFTP stays where it is today).
- No WinPE / wimboot hosting.
- No DHCP.
- No multi-server support (single TrueNAS box).
- No user roles (single admin account).

## Deployment

See [docs/DEPLOY.md](docs/DEPLOY.md) for the TrueNAS SCALE Custom App setup and the one-time iPXE `snponly.efi` migration that points the boot chain at FleetDeck.

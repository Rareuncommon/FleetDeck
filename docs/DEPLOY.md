# FleetDeck Deployment Runbook

FleetDeck runs as a plain Docker image, deployed on TrueNAS SCALE as a Custom App. This runbook covers the app setup, a safe first bring-up, the one manual iPXE migration step, and rollback.

---

## 1. TrueNAS SCALE Custom App setup

In the TrueNAS SCALE UI: **Apps > Discover Apps > Custom App** (labeled "Launch Docker Image" on some builds — menu labels may vary slightly by TrueNAS SCALE version).

**Image**

- Repository/tag: your built image, e.g. `fleetdeck:latest` (push it to a registry the box can reach, or load it locally).

**Port mapping**

- Container port `8080` → a host port on the LAN, e.g. `8080`.
- FleetDeck serves the UI, API, and `/boot/*` all on this one port.
- Because `/boot/*` is unauthenticated (firmware can't log in), keep this on the LAN only.

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

A few more tunables (`wol_enabled`, `wol_broadcast`, `pool_alert_threshold_pct`, `safety_snapshot_retention_days`, `nightly_reset_cron`) live in the in-app Settings panel, not as env vars — they take effect immediately without a restart.

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

Bring FleetDeck up in read-only mode before it's allowed to touch anything.

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

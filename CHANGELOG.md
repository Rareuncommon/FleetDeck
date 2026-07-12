# Changelog

## v2 — Integrated setup, golden provisioning & fleet ops

- **Integrated boot chain**: FleetDeck now serves TFTP (`snponly.efi`) and HTTP boot files itself with a generated `winpe.ipxe` — the separate ipxeboot container is retired.
- **First-run Setup Wizard**: idempotent, DRY_RUN-aware creation of datasets, the golden zvol, iSCSI service, portal, initiator group, and the golden target/extent/LUN mapping, plus a re-runnable Diagnostics panel.
- **Golden Build Mode** with `install`/`boot_installed` phases, a generated `deploy.cmd` that automates the whole WinPE imaging marathon, and a guided checklist.
- **Guest/kiosk**: session history, idle-timeout reclaim, a safety-script heartbeat with a warning badge, GPU tagging, honest "kick", per-client QR stickers, and a public read-only `/status` page.
- **Fleet ops**: client tags + filter chips, per-tag maintenance windows, wake-all, generic webhooks, `/healthz` + `/metrics`, CSV/JSON export, a pool-usage sparkline, backup/restore, multiple admin accounts, and a configurable session timeout.
- **Reliability**: live-tailing Audit tab, a sidebar connection-health indicator with reconnect state, server-side audit filters, per-row last-error, a one-button self-test, startup config warnings, a persistent DRY_RUN banner, and build provenance.

## v1 — Initial release

- Diskless Windows fleet manager for TrueNAS SCALE iSCSI boot: create/reset/rebase/retire clients, promote golden images, nightly reset cron, iPXE serving with unknown-MAC discovery, DRY_RUN safety, auto safety-snapshots, pool alerting, reconciliation, and bulk CSV import.

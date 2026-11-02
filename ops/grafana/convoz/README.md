# Convoz Grafana resources

Grafana resources as code for Convoz. Nothing here is pushed yet.

Files:
- `folder.yaml`: folder "Convoz" (uid `convoz`)
- `dashboard.yaml`: dashboard `convoz-overview`, one panel (p50/p95 latency by route)
- `alert-now-p50.yaml`: alert `convoz-api-now-p50` (`/api/now` p50 over 150 ms for 5m)
- `alert-failed-sends.yaml`: alert `convoz-failed-sends` (any failed send in 5m)

Both alerts sit in rule group `convoz` (label `grafana.com/group`), interval 1m, label `team=convoz`.

## Before you push

1. The alerts use the placeholder `${PROM_DS_UID}`. Replace it with the uid of the Prometheus
   (Mimir) data source. Find it: `gcx datasources list`. Example:
   `PROM_DS_UID=<uid> envsubst '${PROM_DS_UID}' < alert-now-p50.yaml > /tmp/out/alert-now-p50.yaml`
   (do the same for the other alert, push from the output folder).
2. Contact point `cloud-tech` is a placeholder name. Confirm it in the alert PLAN. Never route to Drew.
3. The dashboard has a data source picker, so it needs no uid.

## Push

    gcx resources validate -p ops/grafana/convoz
    gcx resources push -p ops/grafana/convoz --dry-run
    gcx resources push -p ops/grafana/convoz

Folder is pushed first. Re-run push to update.

## Delete by uid

    gcx resources delete alertrules/convoz-api-now-p50
    gcx resources delete alertrules/convoz-failed-sends
    gcx resources delete dashboards/convoz-overview
    gcx resources delete folders/convoz

Delete the folder last (it must be empty).

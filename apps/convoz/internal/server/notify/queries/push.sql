-- name: SubscriptionByEndpoint :one
SELECT id, device_id, identity_id FROM push_subscriptions WHERE endpoint = sqlc.arg(endpoint);

-- name: InsertSubscription :one
INSERT INTO push_subscriptions (device_id, identity_id, endpoint, p256dh, auth, messages, created_at)
VALUES (sqlc.arg(device_id), sqlc.arg(identity_id), sqlc.arg(endpoint), sqlc.arg(p256dh), sqlc.arg(auth), sqlc.arg(messages), sqlc.arg(now))
RETURNING id;

-- name: ReviveSubscription :exec
-- The same endpoint subscribes again (the browser kept it): it belongs to the caller's device, with fresh keys and a clean record.
UPDATE push_subscriptions SET device_id = sqlc.arg(device_id), identity_id = sqlc.arg(identity_id), p256dh = sqlc.arg(p256dh), auth = sqlc.arg(auth), messages = sqlc.arg(messages),
  created_at = sqlc.arg(now), last_success_at = NULL, consecutive_failures = 0, disabled_at = NULL, disabled_reason = NULL
WHERE id = sqlc.arg(id);

-- name: DisableDeviceSubscriptions :exec
-- A device has one live subscription: the others of the device end here. keep is the one to leave alone (0 for none).
UPDATE push_subscriptions SET disabled_at = sqlc.arg(now), disabled_reason = sqlc.arg(reason)
WHERE device_id = sqlc.arg(device_id) AND disabled_at IS NULL AND id != sqlc.arg(keep);

-- name: DisableSubscription :exec
UPDATE push_subscriptions SET disabled_at = sqlc.arg(now), disabled_reason = sqlc.arg(reason) WHERE id = sqlc.arg(id) AND disabled_at IS NULL;

-- name: ListSubscriptions :many
SELECT id, device_id, endpoint, created_at, last_success_at, disabled_at, disabled_reason FROM push_subscriptions
WHERE identity_id = sqlc.arg(identity_id) ORDER BY id DESC;

-- name: LiveSubscriptions :many
SELECT id, device_id, endpoint, p256dh, auth, messages FROM push_subscriptions WHERE identity_id = sqlc.arg(identity_id) AND disabled_at IS NULL ORDER BY id;

-- name: LiveSubscriptionOfDevice :one
SELECT id, device_id, endpoint, p256dh, auth FROM push_subscriptions WHERE device_id = sqlc.arg(device_id) AND disabled_at IS NULL;

-- name: SubscriptionSucceeded :exec
UPDATE push_subscriptions SET last_success_at = sqlc.arg(now), consecutive_failures = 0 WHERE id = sqlc.arg(id);

-- name: SubscriptionFailed :one
UPDATE push_subscriptions SET consecutive_failures = consecutive_failures + 1 WHERE id = sqlc.arg(id) RETURNING consecutive_failures;

-- name: InsertDelivery :exec
INSERT OR IGNORE INTO push_deliveries (notification_id, subscription_id, attempt, status, next_attempt_at, created_at, updated_at)
VALUES (sqlc.arg(notification_id), sqlc.arg(subscription_id), 1, 'queued', sqlc.arg(now), sqlc.arg(now), sqlc.arg(now));

-- name: DueDeliveries :many
SELECT d.id, d.attempt, s.id AS subscription_id, s.device_id, s.endpoint, s.p256dh, s.auth,
       n.id AS notification_id, n.identity_id, n.reason, n.source_seq, n.conversation_id, n.message_id, n.topic, n.urgent, n.created_at AS notified_at
FROM push_deliveries d
JOIN push_subscriptions s ON s.id = d.subscription_id
JOIN notifications n ON n.id = d.notification_id
WHERE d.status IN ('queued', 'retry') AND d.next_attempt_at <= sqlc.arg(now)
ORDER BY d.id LIMIT sqlc.arg(max_rows);

-- name: FinishDelivery :exec
UPDATE push_deliveries SET status = sqlc.arg(status), attempt = sqlc.arg(attempt), http_status = sqlc.narg(http_status), next_attempt_at = sqlc.narg(next_attempt_at), updated_at = sqlc.arg(now)
WHERE id = sqlc.arg(id);

-- name: DropPendingDeliveries :exec
DELETE FROM push_deliveries WHERE notification_id = sqlc.arg(notification_id) AND status IN ('queued', 'retry');

-- name: DropSubscriptionDeliveries :exec
DELETE FROM push_deliveries WHERE subscription_id = sqlc.arg(subscription_id) AND status IN ('queued', 'retry');

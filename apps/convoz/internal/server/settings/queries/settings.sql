-- name: WorkspaceValues :many
SELECT key, value_json FROM workspace_settings;

-- name: UserValues :many
SELECT key, value_json FROM user_settings WHERE identity_id = sqlc.arg(identity_id);

-- name: SetWorkspaceValue :exec
INSERT INTO workspace_settings (key, value_json, schema_version, updated_by, updated_at)
VALUES (sqlc.arg(key), sqlc.arg(value_json), 1, sqlc.arg(updated_by), sqlc.arg(now))
ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, schema_version = excluded.schema_version,
  updated_by = excluded.updated_by, updated_at = excluded.updated_at;

-- name: SetUserValue :exec
INSERT INTO user_settings (identity_id, key, value_json, schema_version, updated_at)
VALUES (sqlc.arg(identity_id), sqlc.arg(key), sqlc.arg(value_json), 1, sqlc.arg(now))
ON CONFLICT (identity_id, key) DO UPDATE SET value_json = excluded.value_json, schema_version = excluded.schema_version,
  updated_at = excluded.updated_at;

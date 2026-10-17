-- name: SessionLabelAndMachine :one
-- Which session and machine wrote something, for the message details the owner opens.
SELECT s.label, m.name AS machine_name FROM sessions s JOIN machines m ON m.id = s.machine_id WHERE s.id = sqlc.arg(id);

-- A retry of "start an upload" must not leave an orphan row: the client names the request (client_id), and a second start with the same
-- id from the same identity gets the first upload back. NULL for an upload of a client that sends none (the browser, an older CLI).
-- owner: upload
ALTER TABLE uploads ADD COLUMN client_id TEXT;
CREATE UNIQUE INDEX uploads_client_id ON uploads(uploader_id, client_id) WHERE client_id IS NOT NULL;

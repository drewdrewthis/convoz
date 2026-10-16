-- The tailnet node that a device-flow request came from, as `tailscale whois` named it when the request was made
-- (NULL when whois could not name it). Shown on the Now card next to the source address.
ALTER TABLE machine_requests ADD COLUMN source_node TEXT CHECK (source_node IS NULL OR length(source_node) <= 255);

-- The node a machine was approved from (the tailnet node name, or the address when Tailscale could not name it). A later request
-- of the same name joins the machine and shares its key only when it comes from this node. NULL for a machine whose request is gone:
-- such a machine matches a node named like itself.
ALTER TABLE machines ADD COLUMN source_node TEXT CHECK (source_node IS NULL OR length(source_node) <= 255);
UPDATE machines SET source_node = (
  SELECT COALESCE(r.source_node, NULLIF(r.source, 'unknown')) FROM machine_requests r WHERE r.machine_id = machines.id ORDER BY r.id LIMIT 1
);

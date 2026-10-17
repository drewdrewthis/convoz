package db

import "context"

// CheckpointTruncate copies the write-ahead log into the data file and empties the log, so rows that were deleted
// (with secure_delete on) are gone from the log as well as from the file. It waits for readers; the busy timeout bounds it.
func (w *Writer) CheckpointTruncate(ctx context.Context) error {
	_, err := w.sql.ExecContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)")
	return err
}

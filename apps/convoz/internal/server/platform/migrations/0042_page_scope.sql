-- Scope bit 32 was "pickup" (removed: nothing claims conversations); it now means "page": read and screenshot the tab the owner
-- shares with a conversation (page-share.feature). Clear it from every machine and lease first, so an old grant never becomes the
-- new one. A row whose only scope is that bit keeps it, because the column needs at least one bit.
UPDATE machines SET scopes = scopes & ~32 WHERE scopes & 32 != 0 AND scopes != 32;
UPDATE sessions SET scopes = scopes & ~32 WHERE scopes & 32 != 0 AND scopes != 32;

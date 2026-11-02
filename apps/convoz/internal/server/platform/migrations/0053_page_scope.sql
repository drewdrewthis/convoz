-- Scope bit 32 was "pickup" (removed: nothing claims conversations); it now means "page": read and screenshot the tab the owner
-- shares with a conversation (page-share.feature). Clear it from every machine and lease first, so an old grant never becomes the
-- new one. The column needs at least one bit, so a row whose only scope was pickup (it could do nothing since pickup went) gets
-- read (1), the smallest named scope.
UPDATE machines SET scopes = CASE WHEN scopes = 32 THEN 1 ELSE scopes & ~32 END WHERE scopes & 32 != 0;
UPDATE sessions SET scopes = CASE WHEN scopes = 32 THEN 1 ELSE scopes & ~32 END WHERE scopes & 32 != 0;

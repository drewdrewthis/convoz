package platform

import "testing"

// Migrate applies only versions above the stored one, so a second file with a taken number never runs on a database
// that already has that number (0042_page_scope was skipped on prod this way).
func TestMigrationVersionsAreUnique(t *testing.T) {
	ms, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	seen := map[int]bool{}
	for _, m := range ms {
		if seen[m.version] {
			t.Errorf("two migration files have version %04d", m.version)
		}
		seen[m.version] = true
	}
}

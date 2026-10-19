package upload

import "testing"

func TestPublicIDNeverStartsWithADash(t *testing.T) {
	for i := 0; i < 20000; i++ {
		id, err := newPublicID()
		if err != nil || len(id) != 22 || id[0] == '-' {
			t.Fatalf("id %q, err %v", id, err)
		}
	}
}

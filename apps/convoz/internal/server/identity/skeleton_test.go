package identity

import "testing"

func TestSkeletonMakesLookalikesEqual(t *testing.T) {
	same := [][2]string{
		{"devtooI", "Devtool"}, // a capital i for an l
		{"Devtool", "dеvtool"}, // a Cyrillic е for an e
		{"Paypal", "Pаypal"},   // a Cyrillic а for an a
		{"R0bot", "robot"},     // a zero for an o
		{"Café", "Café"},      // composed and decomposed accents
	}
	for _, c := range same {
		if Skeleton(c[0]) != Skeleton(c[1]) {
			t.Errorf("%q and %q should look alike: %q vs %q", c[0], c[1], Skeleton(c[0]), Skeleton(c[1]))
		}
	}
	if Skeleton("Devtool") == Skeleton("Devtools") {
		t.Error("different names must stay different")
	}
}

func TestReservedHandlesAreRefusedBeforeAnythingIsRead(t *testing.T) {
	for h := range Reserved {
		if !ValidHandle(h) {
			t.Errorf("reserved word %q should be a valid handle shape, so only the reserved list refuses it", h)
		}
	}
}

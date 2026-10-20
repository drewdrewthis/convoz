package authz

import (
	"context"
	"testing"
)

type fakeReader struct {
	member  map[[2]int64]Member
	readAll map[int64]bool
}

func (f fakeReader) Membership(_ context.Context, conv, who int64) (Member, bool, error) {
	m, ok := f.member[[2]int64{conv, who}]
	return m, ok, nil
}

func (f fakeReader) ReadsAll(_ context.Context, _, who int64) (bool, error) {
	return f.readAll[who], nil
}

func TestCanRead(t *testing.T) {
	r := fakeReader{member: map[[2]int64]Member{{7, 5}: {Active: true}}, readAll: map[int64]bool{6: true}}
	agent := func(id int64) Principal { return Principal{SessionID: 1, IdentityID: id} }
	for name, tc := range map[string]struct {
		p               Principal
		conv            int64
		canSee, canRead bool
	}{
		"a participant reads and sees":        {agent(5), 7, true, true},
		"a read-all agent reads, never sees":  {agent(6), 7, false, true},
		"an agent without the right is out":   {agent(8), 7, false, false},
		"a person with no seat is not helped": {Principal{Authenticated: true, HumanID: 6, Role: "member"}, 7, false, false},
	} {
		if _, ok, _ := CanSee(context.Background(), r, tc.p, tc.conv); ok != tc.canSee {
			t.Errorf("%s: CanSee = %v", name, ok)
		}
		if _, ok, _ := CanRead(context.Background(), r, tc.p, tc.conv); ok != tc.canRead {
			t.Errorf("%s: CanRead = %v", name, ok)
		}
	}
}

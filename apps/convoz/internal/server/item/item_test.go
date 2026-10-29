package item_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/item"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

const (
	drew, devtool, docs = 1, 2, 3
	convA, convB        = 10, 11
)

var t0 = time.UnixMilli(1_000_000)

// rig is a database with the owner, two agents and two conversations; at(n) is the fake clock n minutes after t0.
func rig(t *testing.T) *pdb.Store {
	s := dbtest.Store(t)
	dbtest.Exec(t, s,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES
		 (1,'human','drew','Drew','drew','D',0,1),(2,'agent','devtool','D','devtool','D',0,1),(3,'agent','docs','D','docs','D',0,1)`,
		`INSERT INTO humans (identity_id, role, created_via) VALUES (1,'owner','bootstrap')`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (2,1),(3,1)`,
		`INSERT INTO conversations (id, created_by, created_at, last_activity_at) VALUES (10,1,1,1),(11,1,1,1)`,
	)
	return s
}

func at(n int) time.Time { return t0.Add(time.Duration(n) * time.Minute) }

// run is one transaction; the error is the caller's to check.
func run(t *testing.T, s *pdb.Store, fn func(ctx context.Context, d pdb.DBTX) error) error {
	t.Helper()
	return dbtest.TxErr(t, s, fn)
}

func must[T any](t *testing.T, v T, err error) T {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func start(t *testing.T, s *pdb.Store, n int, agent, conv int64, key string) item.Item {
	var it item.Item
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		it, err = item.Start(ctx, d, at(n), agent, conv, key, item.Fields{Title: "Step " + key})
		return err
	})
	return it
}

func block(t *testing.T, s *pdb.Store, n int, agent, conv int64, key, recommend string) item.Item {
	var it item.Item
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		it, err = item.Block(ctx, d, at(n), agent, conv, key, item.Fields{Title: "Decide " + key, Recommend: recommend})
		return err
	})
	return it
}

func get(t *testing.T, s *pdb.Store, agent, conv int64, key string) item.Item {
	var it item.Item
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		it, err = item.ByKey(ctx, d, agent, conv, key)
		return err
	})
	return it
}

func TestTheFirstItemOfAPlanIsNowAndTheNextOnesWait(t *testing.T) {
	s := rig(t)
	a, b, c := start(t, s, 0, devtool, convA, "a"), start(t, s, 1, devtool, convA, "b"), start(t, s, 2, devtool, convA, "c")
	if a.State != item.Started || b.State != item.Pending || c.State != item.Pending || !(a.Seq < b.Seq && b.Seq < c.Seq) {
		t.Fatalf("states %s %s %s, seq %d %d %d", a.State, b.State, c.State, a.Seq, b.Seq, c.Seq)
	}
	if other := start(t, s, 3, docs, convA, "a"); other.State != item.Started {
		t.Errorf("another agent in the same conversation has its own now, got %s", other.State)
	}
	if other := startIn(t, s, 3, devtool, convB, "a", "other"); other.State != item.Started {
		t.Errorf("the same agent in another plan has its own now, got %s", other.State)
	}
}

func TestStartingTheSameKeyAgainFindsTheSameRow(t *testing.T) {
	s := rig(t)
	a := start(t, s, 0, devtool, convA, "a")
	again := start(t, s, 1, devtool, convA, "a")
	if again.ID != a.ID || again.Version != a.Version || again.State != item.Started {
		t.Fatalf("retry: %+v after %+v", again, a)
	}
}

func TestTwoBlockingRequestsByOneAgentSecondIsPendingAndPromotedWhenTheFirstIsDone(t *testing.T) {
	s := rig(t)
	first, second := block(t, s, 0, devtool, convA, "x", "Merge it"), block(t, s, 1, devtool, convA, "y", "Ship it")
	if first.State != item.Blocking || second.State != item.Pending || !second.OwnerStep {
		t.Fatalf("first %s, second %s owner_step %v", first.State, second.State, second.OwnerStep)
	}
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := item.Accept(ctx, d, at(2), drew, first.ID, first.Version)
		return err
	})
	if got := get(t, s, devtool, convA, "y"); got.State != item.Blocking {
		t.Fatalf("the second is promoted to blocking when the first is done, got %s", got.State)
	}
	if ev := events(t, s, second.ID); ev[len(ev)-1].Event != "promote" || ev[len(ev)-1].ToState != item.Blocking {
		t.Errorf("promotion must emit its own event: %+v", ev)
	}
}

func events(t *testing.T, s *pdb.Store, id int64) []item.Event {
	var ev []item.Event
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		ev, err = item.Events(ctx, d, id)
		return err
	})
	return ev
}

func TestDoneStartedItemPromotesTheLowestPendingAsStarted(t *testing.T) {
	s := rig(t)
	start(t, s, 0, devtool, convA, "a")
	start(t, s, 1, devtool, convA, "b")
	start(t, s, 2, devtool, convA, "c")
	var done item.Item
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		done, err = item.MarkDone(ctx, d, at(3), devtool, convA, "a", "shipped")
		return err
	})
	if done.State != item.Done || get(t, s, devtool, convA, "b").State != item.Started || get(t, s, devtool, convA, "c").State != item.Pending {
		t.Fatal("done must promote b only")
	}
	if ev := events(t, s, get(t, s, devtool, convA, "b").ID); ev[len(ev)-1].Event != "promote" || ev[len(ev)-1].ToState != item.Started {
		t.Errorf("events of b: %+v", ev)
	}
}

func TestEveryLegalAndIllegalAgentMove(t *testing.T) {
	// Each case builds a world, makes one move and names the state it ends in, or the error (state and version stay).
	type move = func(ctx context.Context, d pdb.DBTX) (item.Item, error)
	f := item.Fields{Title: "T", Recommend: "Do it"}
	moves := map[string]move{
		"start": func(ctx context.Context, d pdb.DBTX) (item.Item, error) {
			return item.Start(ctx, d, at(9), devtool, convA, "k", f)
		},
		"block": func(ctx context.Context, d pdb.DBTX) (item.Item, error) {
			return item.Block(ctx, d, at(9), devtool, convA, "k", f)
		},
		"done": func(ctx context.Context, d pdb.DBTX) (item.Item, error) {
			return item.MarkDone(ctx, d, at(9), devtool, convA, "k", "")
		},
		"fyi": func(ctx context.Context, d pdb.DBTX) (item.Item, error) {
			return item.MarkFyi(ctx, d, at(9), devtool, convA, "k", "")
		},
		"drop": func(ctx context.Context, d pdb.DBTX) (item.Item, error) {
			return item.Drop(ctx, d, at(9), devtool, convA, "k")
		},
	}
	worlds := map[string]func(t *testing.T, s *pdb.Store){
		"started":  func(t *testing.T, s *pdb.Store) { start(t, s, 0, devtool, convA, "k") },
		"blocking": func(t *testing.T, s *pdb.Store) { block(t, s, 0, devtool, convA, "k", "Do it") },
		"pending": func(t *testing.T, s *pdb.Store) {
			start(t, s, 0, devtool, convA, "now")
			start(t, s, 1, devtool, convA, "k")
		},
		"done": func(t *testing.T, s *pdb.Store) {
			start(t, s, 0, devtool, convA, "k")
			dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
				_, err := item.MarkDone(ctx, d, at(1), devtool, convA, "k", "")
				return err
			})
		},
		"fyi": func(t *testing.T, s *pdb.Store) {
			block(t, s, 0, devtool, convA, "k", "Do it")
			dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
				_, err := item.MarkFyi(ctx, d, at(1), devtool, convA, "k", "")
				return err
			})
		},
		"dropped": func(t *testing.T, s *pdb.Store) {
			start(t, s, 0, devtool, convA, "k")
			dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
				_, err := item.Drop(ctx, d, at(1), devtool, convA, "k")
				return err
			})
		},
		"none": func(t *testing.T, s *pdb.Store) {},
	}
	conflict := "conflict"
	want := map[[2]string]string{ // world, move -> state after, or "conflict"
		{"none", "start"}: "started", {"none", "block"}: "blocking", {"none", "done"}: "notfound", {"none", "fyi"}: "notfound", {"none", "drop"}: "notfound",
		{"started", "start"}: "started", {"started", "block"}: "blocking", {"started", "done"}: "done", {"started", "fyi"}: conflict, {"started", "drop"}: "dropped",
		{"blocking", "start"}: conflict, {"blocking", "block"}: "blocking", {"blocking", "done"}: conflict, {"blocking", "fyi"}: "fyi", {"blocking", "drop"}: "dropped",
		{"pending", "start"}: "pending", {"pending", "block"}: "blocking", {"pending", "done"}: conflict, {"pending", "fyi"}: conflict, {"pending", "drop"}: "dropped",
		{"done", "start"}: conflict, {"done", "block"}: conflict, {"done", "done"}: "done", {"done", "fyi"}: conflict, {"done", "drop"}: conflict,
		{"fyi", "start"}: conflict, {"fyi", "block"}: conflict, {"fyi", "done"}: conflict, {"fyi", "fyi"}: "fyi", {"fyi", "drop"}: conflict,
		{"dropped", "start"}: conflict, {"dropped", "block"}: conflict, {"dropped", "done"}: conflict, {"dropped", "fyi"}: conflict, {"dropped", "drop"}: "dropped",
	}
	for w, setup := range worlds {
		for m, mv := range moves {
			t.Run(w+"/"+m, func(t *testing.T) {
				s := rig(t)
				setup(t, s)
				var before item.Item
				if w != "none" {
					before = get(t, s, devtool, convA, "k")
				}
				var got item.Item
				err := run(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
					got, err = mv(ctx, d)
					return err
				})
				switch exp := want[[2]string{w, m}]; exp {
				case conflict:
					if !errors.Is(err, item.ErrConflict) {
						t.Fatalf("want conflict, got %v", err)
					}
					if after := get(t, s, devtool, convA, "k"); after.Version != before.Version || after.State != before.State {
						t.Errorf("a refused move changes nothing: %+v -> %+v", before, after)
					}
				case "notfound":
					if !errors.Is(err, item.ErrNotFound) {
						t.Fatalf("want not found, got %v", err)
					}
				default:
					if err != nil || got.State != exp {
						t.Fatalf("want %s, got %s (%v)", exp, got.State, err)
					}
				}
			})
		}
	}
}

func TestDropOfTheNowItemPromotesTheNext(t *testing.T) {
	s := rig(t)
	start(t, s, 0, devtool, convA, "a")
	start(t, s, 1, devtool, convA, "b")
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := item.Drop(ctx, d, at(2), devtool, convA, "a")
		return err
	})
	if got := get(t, s, devtool, convA, "b"); got.State != item.Started {
		t.Fatalf("b is %s", got.State)
	}
}

func TestFyiOfTheBlockingItemPromotesTheNext(t *testing.T) {
	s := rig(t)
	block(t, s, 0, devtool, convA, "a", "Do it")
	start(t, s, 1, devtool, convA, "b")
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := item.MarkFyi(ctx, d, at(2), devtool, convA, "a", "I got round it")
		return err
	})
	if got := get(t, s, devtool, convA, "b"); got.State != item.Started {
		t.Fatalf("b is %s", got.State)
	}
}

func TestTheDatabaseRefusesASecondNow(t *testing.T) {
	s := rig(t)
	start(t, s, 0, devtool, convA, "a")
	err := run(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := d.ExecContext(ctx, `INSERT INTO feed_items (agent_id, conversation_id, work_key, seq, state, title, created_at, updated_at)
			VALUES (2, 10, 'z', 99, 'started', 'x', 1, 1)`)
		return err
	})
	if err == nil {
		t.Fatal("two items started at once must break the one_now index")
	}
}

func TestAnAgentEditBumpsTheVersionAndAStaleAcceptIs409(t *testing.T) {
	s := rig(t)
	first := block(t, s, 0, devtool, convA, "x", "Merge it")
	edited := block(t, s, 1, devtool, convA, "x", "Merge it") // block again, nothing changed
	retitled := must(t, edited, nil)
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		retitled, err = item.Block(ctx, d, at(2), devtool, convA, "x", item.Fields{Title: "New title", Recommend: "Squash it"})
		return err
	})
	if !(edited.Version > first.Version && retitled.Version > edited.Version) {
		t.Fatalf("versions %d %d %d", first.Version, edited.Version, retitled.Version)
	}
	err := run(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := item.Accept(ctx, d, at(3), drew, first.ID, first.Version)
		return err
	})
	if !errors.Is(err, item.ErrVersion) {
		t.Fatalf("accept of the old version: %v", err)
	}
	if got := get(t, s, devtool, convA, "x"); got.State != item.Blocking || got.Version != retitled.Version {
		t.Fatalf("a refused accept changes nothing: %+v", got)
	}
}

func TestAcceptNeedsTheVersionOnEveryItemKind(t *testing.T) {
	s := rig(t)
	x := block(t, s, 0, devtool, convA, "x", "Merge it")
	for _, v := range []int64{0, x.Version + 1} {
		err := run(t, s, func(ctx context.Context, d pdb.DBTX) error {
			_, err := item.Accept(ctx, d, at(1), drew, x.ID, v)
			return err
		})
		if !errors.Is(err, item.ErrVersion) {
			t.Errorf("version %d: %v", v, err)
		}
	}
}

func TestAcceptEndsTheBlockingItemAtOnce(t *testing.T) {
	s := rig(t)
	x := block(t, s, 0, devtool, convA, "x", "Merge it")
	var got item.Item
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		got, err = item.Accept(ctx, d, at(1), drew, x.ID, x.Version)
		return err
	})
	if got.State != item.Done || got.AckKind != "accept" || got.AckedAt == 0 {
		t.Fatalf("%+v", got)
	}
}

func TestABlockingItemWithoutARecommendationCannotBeAcceptedButTakesInfo(t *testing.T) {
	s := rig(t)
	x := block(t, s, 0, devtool, convA, "x", "")
	if x.State != item.Blocking || x.Recommendation != "" {
		t.Fatalf("%+v", x)
	}
	err := run(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := item.Accept(ctx, d, at(1), drew, x.ID, x.Version)
		return err
	})
	if !errors.Is(err, item.ErrNoRecommendation) {
		t.Fatalf("accept: %v", err)
	}
	var got item.Item
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		got, err = item.Answer(ctx, d, at(2), drew, x.ID, "Use the staging key", true)
		return err
	})
	if got.State != item.Done || got.AckKind != "answer" {
		t.Fatalf("an answer that resolves ends it: %+v", got)
	}
}

func TestInfoThatDoesNotResolveLeavesTheItemBlocking(t *testing.T) {
	s := rig(t)
	x := block(t, s, 0, devtool, convA, "x", "Merge it")
	var got item.Item
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		got, err = item.Answer(ctx, d, at(1), drew, x.ID, "Which branch?", false)
		return err
	})
	if got.State != item.Blocking || got.AckedAt != 0 {
		t.Fatalf("%+v", got)
	}
	if ev := events(t, s, x.ID); ev[len(ev)-1].Event != "info" || ev[len(ev)-1].Note != "Which branch?" {
		t.Errorf("%+v", ev)
	}
}

func TestGotItSetsAckedAtAndKeepsTheState(t *testing.T) {
	s := rig(t)
	x := block(t, s, 0, devtool, convA, "x", "Merge it")
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := item.MarkFyi(ctx, d, at(1), devtool, convA, "x", "Merged it myself")
		return err
	})
	var got item.Item
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		got, err = item.GotIt(ctx, d, at(2), drew, x.ID)
		return err
	})
	if got.State != item.Fyi || got.AckedAt != at(2).UnixMilli() || got.AckKind != "got_it" {
		t.Fatalf("%+v", got)
	}
	l := listAll(t, s)
	for _, it := range l.Open {
		if it.ID == x.ID {
			t.Error("an acknowledged fyi leaves the feed")
		}
	}
}

func TestGotItOnAFinishedItemIsAConflict(t *testing.T) {
	s := rig(t)
	x := start(t, s, 0, devtool, convA, "x")
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := item.MarkDone(ctx, d, at(1), devtool, convA, "x", "ok")
		return err
	})
	err := run(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := item.GotIt(ctx, d, at(2), drew, x.ID)
		return err
	})
	if !errors.Is(err, item.ErrConflict) {
		t.Fatal(err)
	}
}

func inFeed(t *testing.T, s *pdb.Store, id int64) bool {
	t.Helper()
	for _, it := range listAll(t, s).Open {
		if it.ID == id {
			return true
		}
	}
	return false
}

func ack(t *testing.T, s *pdb.Store, n int, id int64) item.Item {
	t.Helper()
	var got item.Item
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		got, err = item.GotIt(ctx, d, at(n), drew, id)
		return err
	})
	return got
}

func TestOkayOnAStartedItemHidesItAndALaterMoveBringsItBack(t *testing.T) {
	s := rig(t)
	x := start(t, s, 0, devtool, convA, "x")
	got := ack(t, s, 1, x.ID)
	if got.State != item.Started || got.AckedAt == 0 || inFeed(t, s, x.ID) {
		t.Fatalf("an acked started item stays started and leaves the feed: %+v", got)
	}
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := item.Block(ctx, d, at(2), devtool, convA, "x", item.Fields{Title: "Need you"})
		return err
	})
	if !inFeed(t, s, x.ID) || get(t, s, devtool, convA, "x").AckedAt != 0 {
		t.Fatal("block brings it back")
	}
	// An edit of the same key, done and promotion also bring an acked item back.
	ack(t, s, 3, x.ID)
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := item.MarkFyi(ctx, d, at(4), devtool, convA, "x", "got round it")
		return err
	})
	if !inFeed(t, s, x.ID) {
		t.Fatal("fyi brings an acked blocking item back")
	}
}

func TestOkayOnABlockingItemWithNoRecommendationHidesItAndItStaysBlocking(t *testing.T) {
	s := rig(t)
	x := block(t, s, 0, devtool, convA, "x", "")
	got := ack(t, s, 1, x.ID)
	if got.State != item.Blocking || inFeed(t, s, x.ID) {
		t.Fatalf("%+v", got)
	}
}

func TestAnEditBringsAnAckedStartedItemBack(t *testing.T) {
	s := rig(t)
	x := start(t, s, 0, devtool, convA, "x")
	ack(t, s, 1, x.ID)
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := item.Start(ctx, d, at(2), devtool, convA, "x", item.Fields{Title: "A new title"})
		return err
	})
	if !inFeed(t, s, x.ID) {
		t.Fatal("an edit brings it back")
	}
}

func TestSnoozeSetsAndClearsTheWakeTime(t *testing.T) {
	s := rig(t)
	x := block(t, s, 0, devtool, convA, "x", "Merge it")
	var got item.Item
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		got, err = item.Snooze(ctx, d, at(1), drew, x.ID, at(60).UnixMilli())
		return err
	})
	if got.SnoozedUntil != at(60).UnixMilli() || got.State != item.Blocking {
		t.Fatalf("%+v", got)
	}
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		got, err = item.Unsnooze(ctx, d, at(2), drew, x.ID)
		return err
	})
	if got.SnoozedUntil != 0 {
		t.Fatalf("%+v", got)
	}
	err := run(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := item.Snooze(ctx, d, at(3), drew, x.ID, at(0).UnixMilli())
		return err
	})
	if !errors.Is(err, item.ErrText) {
		t.Errorf("a wake time in the past: %v", err)
	}
}

func TestSayRecordsANoteAndLeavesStateAndVersion(t *testing.T) {
	s := rig(t)
	x := start(t, s, 0, devtool, convA, "x")
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := item.Say(ctx, d, at(1), devtool, convA, "x", "Half way")
		return err
	})
	if got := get(t, s, devtool, convA, "x"); got.State != item.Started || got.Version != x.Version {
		t.Fatalf("%+v", got)
	}
	if ev := events(t, s, x.ID); ev[len(ev)-1].Event != "say" || ev[len(ev)-1].Note != "Half way" {
		t.Errorf("%+v", ev)
	}
}

func TestAgentsOnlyReachTheirOwnRows(t *testing.T) {
	s := rig(t)
	start(t, s, 0, devtool, convA, "x")
	err := run(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := item.MarkDone(ctx, d, at(1), docs, convA, "x", "")
		return err
	})
	if !errors.Is(err, item.ErrNotFound) {
		t.Fatalf("docs finishing devtool's item: %v", err)
	}
	if got := get(t, s, devtool, convA, "x"); got.State != item.Started {
		t.Fatalf("%+v", got)
	}
}

func TestTextRules(t *testing.T) {
	s := rig(t)
	long := func(n int) string {
		b := make([]byte, n)
		for i := range b {
			b[i] = 'a'
		}
		return string(b)
	}
	for name, f := range map[string]item.Fields{
		"empty title":      {Title: " "},
		"title too long":   {Title: long(201)},
		"context too long": {Title: "T", Context: long(2001)},
		"markdown link":    {Title: "See [this](x)"},
		"a link":           {Title: "Look at https://example.com"},
		"bold":             {Title: "**Do** it"},
		"code":             {Title: "Run `ls`"},
		"recommend long":   {Title: "T", Recommend: long(501)},
		"recommend link":   {Title: "T", Recommend: "Open http://x.y"},
	} {
		err := run(t, s, func(ctx context.Context, d pdb.DBTX) error {
			_, err := item.Start(ctx, d, at(0), devtool, convA, "k", f)
			return err
		})
		if !errors.Is(err, item.ErrText) {
			t.Errorf("%s: %v", name, err)
		}
	}
	ok := item.Fields{Title: long(200), Context: long(2000), Recommend: long(500)}
	if err := run(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := item.Start(ctx, d, at(0), devtool, convA, "k", ok)
		return err
	}); err != nil {
		t.Errorf("limits are inclusive: %v", err)
	}
}

func TestMoreThanTenBlockingItemsAreAllowed(t *testing.T) {
	s := rig(t)
	for i := 0; i < 12; i++ {
		block(t, s, i, devtool, convA, "k"+string(rune('a'+i)), "Do it")
	}
}

func listAll(t *testing.T, s *pdb.Store) item.Feed {
	var f item.Feed
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
		f, err = item.List(ctx, d, 20)
		return err
	})
	return f
}

func TestTheFeedListsOpenStepsInPlanOrderAndTheLastDone(t *testing.T) {
	s := rig(t)
	start(t, s, 0, devtool, convA, "a")
	start(t, s, 1, devtool, convA, "b")
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		_, err := item.MarkDone(ctx, d, at(2), devtool, convA, "a", "")
		return err
	})
	f := listAll(t, s)
	if len(f.Open) != 1 || f.Open[0].Key != "b" || len(f.Done) != 1 || f.Done[0].Key != "a" {
		t.Fatalf("%+v", f)
	}
}

func TestAThreadRootIsKeptOnceAndAnOldItemHasNone(t *testing.T) {
	s := rig(t)
	dbtest.Exec(t, s, `INSERT INTO messages (id, conversation_id, author_id, kind, body, created_at) VALUES (100,10,2,'text','Step a',1),(101,10,2,'text','Other',1)`)
	it := start(t, s, 1, devtool, convA, "a")
	if it.ThreadRoot != 0 {
		t.Fatalf("a new row has no thread root until the caller posts one, got %d", it.ThreadRoot)
	}
	must(t, 0, run(t, s, func(ctx context.Context, d pdb.DBTX) error { return item.SetThreadRoot(ctx, d, it.ID, 100) }))
	must(t, 0, run(t, s, func(ctx context.Context, d pdb.DBTX) error { return item.SetThreadRoot(ctx, d, it.ID, 101) }))
	if got := get(t, s, devtool, convA, "a").ThreadRoot; got != 100 {
		t.Fatalf("the first root stays, got %d", got)
	}
}

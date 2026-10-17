package notify

import (
	"fmt"
	"time"
)

// QuietHours is the window the owner asked for: from Start to End (clock times "15:04" in Zone, over midnight when End is before Start).
type QuietHours struct {
	Start, End string
	Zone       string
}

// ParseClock reads "HH:MM" as minutes after midnight.
func ParseClock(s string) (int, error) {
	t, err := time.Parse("15:04", s)
	if err != nil || len(s) != 5 {
		return 0, fmt.Errorf("%q is not a time like 22:00", s)
	}
	return t.Hour()*60 + t.Minute(), nil
}

// Contains reports whether now is inside the window. A zone that cannot be loaded reads as UTC. An empty window (Start equals End) is never.
func (q QuietHours) Contains(now time.Time) bool {
	start, err1 := ParseClock(q.Start)
	end, err2 := ParseClock(q.End)
	if err1 != nil || err2 != nil || start == end {
		return false
	}
	loc, err := time.LoadLocation(q.Zone)
	if err != nil {
		loc = time.UTC
	}
	local := now.In(loc)
	at := local.Hour()*60 + local.Minute()
	if start < end {
		return at >= start && at < end
	}
	return at >= start || at < end
}

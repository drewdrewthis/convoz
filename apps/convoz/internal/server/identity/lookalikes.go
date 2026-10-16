package identity

import (
	"sort"
	"strings"
)

// punctuationTargets are the skeletons that make a character a dot, slash, colon, at sign or middle dot in disguise.
var punctuationTargets = map[string]bool{".": true, "/": true, ":": true, "@": true, "\u00b7": true} // the last one is the middle dot (·)

// handLookalikes are characters the pinned table misses or maps elsewhere.
const handLookalikes = "" +
	"\u119e" + // ᆞ Hangul Jungseong Arae-a, drawn as a middle dot; absent from the table
	"\u4e36" + // 丶 Han dot stroke, drawn as a dot; the table maps it to a backslash
	"\u3002" + // 。 ideographic full stop; the table maps it to a spacing ring
	"\uff61" // ｡ halfwidth ideographic full stop; same

// PunctuationLookalikes returns, sorted and without repeats, every character that can pass for a dot, slash, colon,
// at sign or middle dot inside a word: the table's sources for those targets plus handLookalikes. The chat page gets
// this set from the server so the table stays its only owner.
func PunctuationLookalikes() string {
	confusablesOnce.Do(loadConfusables)
	set := map[rune]bool{}
	for from, to := range confusables {
		if punctuationTargets[string(to)] {
			set[from] = true
		}
	}
	for _, r := range handLookalikes {
		set[r] = true
	}
	all := make([]rune, 0, len(set))
	for r := range set {
		all = append(all, r)
	}
	sort.Slice(all, func(i, j int) bool { return all[i] < all[j] })
	var b strings.Builder
	for _, r := range all {
		b.WriteRune(r)
	}
	return b.String()
}

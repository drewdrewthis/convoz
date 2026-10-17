package message_test

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
)

// The cases are shared with the web app (packages/contracts/fixtures/mentions): both sides must find the same handles.
func TestParseMentions_SharedCases(t *testing.T) {
	raw, err := os.ReadFile("../../../../../packages/contracts/fixtures/mentions/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name, Format, Body string
		Mentions           []string
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		got := message.ParseMentions(c.Body, c.Format)
		if len(got) == 0 && len(c.Mentions) == 0 {
			continue
		}
		if !reflect.DeepEqual(got, c.Mentions) {
			t.Errorf("%s: %q as %s mentions %v, want %v", c.Name, c.Body, c.Format, got, c.Mentions)
		}
	}
}

// The projection fixtures are shared with the web app too (AC-M1).
func TestProject_SharedFixtures(t *testing.T) {
	for _, file := range []string{"text", "variants"} {
		raw, err := os.ReadFile("../../../../../packages/contracts/fixtures/projection/" + file + ".json")
		if err != nil {
			t.Fatal(err)
		}
		var cases []struct {
			Name        string
			Message     message.Projectable
			Short, Long string
		}
		if err := json.Unmarshal(raw, &cases); err != nil {
			t.Fatal(err)
		}
		for _, c := range cases {
			if got := message.Project(c.Message, message.Short); got != c.Short {
				t.Errorf("%s: short is %q, want %q", c.Name, got, c.Short)
			}
			if got := message.Project(c.Message, message.Long); got != c.Long {
				t.Errorf("%s: long is %q, want %q", c.Name, got, c.Long)
			}
		}
	}
}

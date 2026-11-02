package httpapi

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
)

const (
	mentionGamma, mentionDelta = int64(903), int64(904) // "gamma" is outside the chat; "delta" is disabled
	mentionSessGamma           = int64(9003)
)

// newMentionRig is the wake rig (owner, alpha and beta in the chat) plus gamma, an enabled agent outside it with a live
// session, and delta, a disabled one.
func newMentionRig(t *testing.T) *wakeRig {
	t.Helper()
	r := newWakeRig(t)
	owner := strconv.FormatInt(r.ownerID(), 10)
	dbtest.Exec(t, r.s.Store,
		`INSERT INTO identities (id, kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at, disabled_at) VALUES
		   (903,'agent','gamma','Gamma','gamma','G',0,1,NULL),(904,'agent','delta','Delta','delta','D',0,1,1)`,
		`INSERT INTO agents (identity_id, created_by_human) VALUES (903,`+owner+`),(904,`+owner+`)`,
		`INSERT INTO sessions (id, identity_id, machine_id, token_hash, client_id, label, scopes, created_at, last_seen_at, expires_at) VALUES
		   (9003,903,1,randomblob(32),'client-cccc','c',127,1,1,9999999999999)`)
	return r
}

// postQuiet is post with the quiet flag of the call log.
func (r *wakeRig) postQuiet(t *testing.T, author, session int64, body string) {
	t.Helper()
	r.n++
	p := authz.Principal{Authenticated: true, SessionID: session, IdentityID: author, Role: "agent"}
	r.inTx(t, func(ctx context.Context, d pdb.DBTX) error {
		_, err := message.Post(ctx, d, triagePorts(p), platform.SystemClock{}.Now(), message.Draft{
			Conversation: r.conv, Author: author, Session: session, ClientID: "quiet-client-" + strconv.Itoa(r.n), Body: body, Quiet: true,
		})
		return err
	})
}

func (r *wakeRig) isParticipant(t *testing.T, who int64) bool {
	t.Helper()
	var in bool
	r.inTx(t, func(ctx context.Context, d pdb.DBTX) error {
		parts, err := conversation.Participants(ctx, d, r.conv)
		in = slices.ContainsFunc(parts, func(p conversation.Participant) bool { return p.IdentityID == who })
		return err
	})
	return in
}

// mentionLines is "by>identity" of each member.added line a mention wrote in the chat, oldest first.
func (r *wakeRig) mentionLines(t *testing.T) []string {
	t.Helper()
	rows, err := r.s.Store.Reader.SQL().Query(`SELECT json_extract(system_json,'$.by') || '>' || json_extract(system_json,'$.identity') FROM messages
		WHERE conversation_id = ? AND kind = 'system' AND json_extract(system_json,'$.t') = 'member.added' AND json_extract(system_json,'$.via') = 'mention' ORDER BY id`, r.conv)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		out = append(out, s)
	}
	return out
}

func line(by, who int64) string { return strconv.FormatInt(by, 10) + ">" + strconv.FormatInt(who, 10) }

// An agent's @mention brings an enabled agent into the chat, as a person's does, and the system line names who added whom
// (Drew, conv 379 msgs 6714 and 6722).
func TestAnAgentMentionBringsTheAgentIn(t *testing.T) {
	r := newMentionRig(t)
	_, wake := r.post(t, wakeA, wakeSessA, 0, "@gamma can you review?")
	if !r.isParticipant(t, mentionGamma) {
		t.Fatal("gamma is not in the chat after alpha mentioned it")
	}
	if got, want := r.mentionLines(t), []string{line(wakeA, mentionGamma)}; !slices.Equal(got, want) {
		t.Errorf("mention lines = %v, want %v (alpha added gamma)", got, want)
	}
	if got := r.reasonsOf(t, mentionGamma); !slices.Equal(got, []string{"mention:1"}) {
		t.Errorf("gamma's items = %v, want [mention:1]", got)
	}
	if !slices.Contains(wake, mentionGamma) {
		t.Errorf("Posted.Wake = %v, want gamma woken", wake)
	}
}

// A person's mention writes the same line: the owner added the agent.
func TestAPersonMentionNamesWhoAddedTheAgent(t *testing.T) {
	r := newMentionRig(t)
	r.post(t, r.ownerID(), wakeOwnerSession, 0, "@gamma join us")
	if got, want := r.mentionLines(t), []string{line(r.ownerID(), mentionGamma)}; !slices.Equal(got, want) {
		t.Errorf("mention lines = %v, want %v", got, want)
	}
}

// What an agent's mention never does: no add, no line.
func TestAnAgentMentionThatAddsNoOne(t *testing.T) {
	cases := []struct {
		name string
		act  func(t *testing.T, r *wakeRig)
		who  int64 // the identity that must stay out (0: only check that no line was written)
	}{
		{"a disabled agent", func(t *testing.T, r *wakeRig) { r.post(t, wakeA, wakeSessA, 0, "@delta are you there?") }, mentionDelta},
		{"a person's handle", func(t *testing.T, r *wakeRig) {
			r.post(t, wakeA, wakeSessA, 0, "@nobody-here and @"+r.c.human.Handle+" look")
		}, 0},
		{"a mention in a quote", func(t *testing.T, r *wakeRig) { r.post(t, wakeA, wakeSessA, 0, "> @gamma said this before") }, mentionGamma},
		{"a mention in inline code", func(t *testing.T, r *wakeRig) { r.post(t, wakeA, wakeSessA, 0, "`@gamma` is a handle") }, mentionGamma},
		{"a mention in a code block", func(t *testing.T, r *wakeRig) { r.post(t, wakeA, wakeSessA, 0, "```\n@gamma\n```") }, mentionGamma},
		{"a quiet message", func(t *testing.T, r *wakeRig) { r.postQuiet(t, wakeA, wakeSessA, "call log: @gamma joined the call") }, mentionGamma},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newMentionRig(t)
			tc.act(t, r)
			if tc.who != 0 && r.isParticipant(t, tc.who) {
				t.Errorf("identity %d was added", tc.who)
			}
			if got := r.mentionLines(t); len(got) != 0 {
				t.Errorf("mention lines = %v, want none", got)
			}
		})
	}
}

// Mentioning an agent already in the chat wakes it but writes no second line.
func TestAnAgentMentionOfAMemberWritesNoLine(t *testing.T) {
	r := newMentionRig(t)
	r.post(t, wakeA, wakeSessA, 0, "@beta can you check?")
	if got := r.mentionLines(t); len(got) != 0 {
		t.Errorf("mention lines = %v, want none (beta was already in)", got)
	}
	if got := r.reasonsOf(t, wakeB); !slices.Equal(got, []string{"mention:1"}) {
		t.Errorf("beta's items = %v, want [mention:1]", got)
	}
}

// An agent outside the chat cannot post there, so its mention adds no one.
func TestAnAgentOutsideTheChatAddsNoOne(t *testing.T) {
	r := newMentionRig(t)
	p := authz.Principal{Authenticated: true, SessionID: mentionSessGamma, IdentityID: mentionGamma, Role: "agent"}
	err := dbtest.TxErr(t, r.s.Store, func(ctx context.Context, d pdb.DBTX) error {
		_, err := message.Post(ctx, d, messagePorts(p), platform.SystemClock{}.Now(), message.Draft{
			Conversation: r.conv, Author: mentionGamma, Session: mentionSessGamma, ClientID: "outside-1", Body: "@alpha @beta hi",
		})
		return err
	})
	if !errors.Is(err, message.ErrDenied) {
		t.Fatalf("post from outside = %v, want ErrDenied", err)
	}
	if got := r.mentionLines(t); len(got) != 0 {
		t.Errorf("mention lines = %v, want none", got)
	}
}

// Two agents that mention each other do not run on by themselves: each message wakes the one agent it names, a mention of
// an agent already in the chat adds nothing, and the first message with no mention wakes no agent (the wake rule, PR 96).
func TestAnAgentMentionChainEndsByTheWakeRule(t *testing.T) {
	r := newMentionRig(t)
	if _, wake := r.post(t, wakeA, wakeSessA, 0, "@gamma can you review?"); !slices.Equal(agentsIn(wake), []int64{mentionGamma}) {
		t.Errorf("alpha's mention woke %v, want only gamma", wake)
	}
	if _, wake := r.post(t, mentionGamma, mentionSessGamma, 0, "@alpha looks good"); !slices.Equal(agentsIn(wake), []int64{wakeA}) {
		t.Errorf("gamma's answer woke %v, want only alpha", wake)
	}
	if _, wake := r.post(t, wakeA, wakeSessA, 0, "thanks, merged"); len(agentsIn(wake)) != 0 {
		t.Errorf("alpha's message with no mention woke %v, want no agent: the run ends", wake)
	}
	if got, want := r.mentionLines(t), []string{line(wakeA, mentionGamma)}; !slices.Equal(got, want) {
		t.Errorf("mention lines = %v, want only %v", got, want)
	}
}

// agentsIn keeps the agent ids of a wake list, sorted.
func agentsIn(wake []int64) []int64 {
	var out []int64
	for _, id := range wake {
		if id == wakeA || id == wakeB || id == mentionGamma || id == mentionDelta {
			out = append(out, id)
		}
	}
	slices.Sort(out)
	return out
}

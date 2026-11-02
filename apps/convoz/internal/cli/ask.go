package cli

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// repeated is a flag that may stand more than once; each use adds a value.
type repeated []string

func (r *repeated) String() string     { return strings.Join(*r, ", ") }
func (r *repeated) Set(v string) error { *r = append(*r, v); return nil }

// Ask runs `convoz ask --action A --risk R (--undo U | --one-way) --considered C [--considered C2 ...] --confidence N [--question Q]
// [--urgent] [--thread ROOT] [--client-id C] <conv>`: a permission request. The agent is confident in one action and asks the owner to
// accept its risk; the owner answers Go or Not this with a reason. A confidence under wire.MinConfidence is refused with exit 2 and
// wire.GetConfidentFirst on both streams. It prints the ask id. A lost answer is retried with the same client id, so the server opens the
// ask once. There is no command to answer an ask: a person answers it (design §8.1, C-3).
//
// `convoz ask --question Q --recommend L --why W --alt L --alt-why W [--alt ... --alt-why ...] --owners-call KIND --owners-call-why W <conv>`
// is the decision ask from before permission requests: a question with a recommendation and up to 4 alternatives, and why only the
// owner can decide it (else exit 2: decide it yourself). It still works, with a hint on stderr to use --action. It cannot be mixed with --action.
//
// `convoz ask --draft TEXT [--original TEXT] [--original-from LINE] [--urgent] [--thread ROOT] <conv> [QUESTION]` is the draft ask, for anything
// sent in the owner's name: the owner reads the original, edits the draft and taps Send or Don't send. It takes no options and no owner's
// call (the server sets "It goes out in your name."). The question is --question or the word after the conversation. The answer comes back
// as {"send": true|false, "text": "<final text>"}, with text only when send is true.
func Ask(args []string, io IO) int {
	usage := "usage: convoz ask --action A --risk R (--undo U | --one-way) --considered C [--considered C]... --confidence N [--question Q] [--urgent] [--thread ROOT] [--app FILE] [--client-id C] <conv>"
	f := newChatFlags("ask", io)
	question := f.fs.String("question", "", "the question (at most 500 characters): one plain sentence that tells the owner what to decide, with 3 or more words, no markdown and no status word first; a permission ask shows its action when not given")
	action := f.fs.String("action", "", "what you will do, naming the object (at most 100 characters): a permission request")
	risk := f.fs.String("risk", "", "with --action: what can go wrong (at most 140 characters)")
	undo := f.fs.String("undo", "", "with --action: how to undo it (at most 80 characters); or --one-way")
	oneWay := f.fs.Bool("one-way", false, "with --action: it cannot be undone")
	var considered repeated
	f.fs.Var(&considered, "considered", "with --action: another way you considered and why it is worse (1 to 3 times, at most 120 characters each)")
	confidence := f.fs.Int("confidence", 0, "with --action: how sure you are, 0 to 100, self-reported, not a check; under 80 is refused")
	recommend := f.fs.String("recommend", "", "decision ask (legacy): the option you recommend")
	why := f.fs.String("why", "", "decision ask (legacy): why you recommend it")
	var alts, altWhys repeated
	f.fs.Var(&alts, "alt", "decision ask (legacy): an alternative option (1 to 4 times)")
	f.fs.Var(&altWhys, "alt-why", "decision ask (legacy): why that alternative is on the table (once for each --alt, in order)")
	callKind := f.fs.String("owners-call", "", "decision ask (legacy): why only the owner can decide: one-way, taste, values or scope")
	callWhy := f.fs.String("owners-call-why", "", "decision ask (legacy): the reason it is the owner's call (1 to 280 characters)")
	urgent := f.fs.Bool("urgent", false, "the owner is waiting on it")
	thread := f.fs.Int64("thread", 0, "ask in the thread of this root message")
	draft := f.fs.String("draft", "", "a message to send in the owner's name: the owner edits it and taps Send or Don't send (at most 4000 characters)")
	original := f.fs.String("original", "", "with --draft: the message the draft answers (at most 2000 characters, cut with … when longer)")
	originalFrom := f.fs.String("original-from", "", "with --draft: who sent the original and where, like \"Alex · Slack DM\"")
	appOpt := newAppOpts(f, "a file holding an app (app.v1 JSON) to show with the question")
	update := f.fs.Int64("update", 0, "update this open ask of yours in place, after the owner's questions in its thread (no conversation needed)")
	answers := f.fs.String("answers", "", "with --update: a short summary of your answers to the owner's questions (at most 1000 characters; required once the owner replied)")
	clientID := f.fs.String("client-id", "", "the id that makes a retry safe; random when not given")
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) == 2 && pos[0] == "withdraw" {
		return askWithdraw(f, io, pos[1])
	}
	legacy := *recommend != "" || *why != "" || len(alts) > 0 || len(altWhys) > 0 || *callKind != "" || *callWhy != ""
	var perm *wire.AskPermission
	if *action != "" || *risk != "" || *undo != "" || *oneWay || len(considered) > 0 || *confidence != 0 {
		perm = &wire.AskPermission{Action: *action, Risk: *risk, Undo: *undo, OneWay: *oneWay, Considered: considered, Confidence: *confidence}
	}
	if perm != nil && legacy {
		return usageError(io, "--action makes a permission request: it takes no --recommend, --why, --alt, --alt-why, --owners-call or --owners-call-why")
	}
	if *update > 0 {
		if perm != nil && perm.Confidence != 0 {
			return usageError(io, "the confidence is fixed when the ask is made: leave --confidence out of --update")
		}
		return askUpdate(f, io, pos, *update, wire.AskUpdateRequest{Question: *question, OwnersCallReason: *callWhy, Answers: *answers, Permission: perm}, *recommend, *why, alts, altWhys)
	}
	if *answers != "" {
		return usageError(io, "--answers goes with --update")
	}
	isDraft := *draft != ""
	if len(pos) != 1 && !(isDraft && len(pos) == 2) {
		return usageError(io, usage)
	}
	conv, ok := convArg(io, pos[0])
	if !ok {
		return ExitUsage
	}
	if isDraft && len(pos) == 2 && *question == "" {
		*question = pos[1]
	}
	if !isDraft && (*original != "" || *originalFrom != "") {
		return usageError(io, "--original and --original-from go with --draft")
	}
	req := wire.AskRequest{ConversationID: conv, ThreadRootID: *thread, Question: *question, Urgent: *urgent}
	switch {
	case isDraft && perm != nil:
		return usageError(io, "an ask is a permission request (--action) or a draft (--draft), not both")
	case perm != nil:
		switch problem := perm.Problem(); problem {
		case "":
		case wire.GetConfidentFirst:
			return refuse(io, problem)
		default:
			return usageError(io, problem)
		}
		req.Permission = perm
	case isDraft:
		if legacy {
			return usageError(io, "a draft ask takes no options and no owner's call: the owner sends the draft or does not")
		}
		if strings.TrimSpace(*question) == "" {
			return usageError(io, "a draft ask needs a question, like \"Send this reply to Alex?\"")
		}
		req.Draft = &wire.AskDraft{Text: *draft, Original: wire.TruncateOriginal(*original), OriginalFrom: *originalFrom}
		if problem := req.Draft.Problem(); problem != "" {
			return usageError(io, problem)
		}
	default:
		req.OwnersCall = wire.OwnersCall{Kind: *callKind, Reason: *callWhy}
		if problem := req.OwnersCall.Problem(); problem != "" {
			return refuse(io, problem)
		}
		switch {
		case strings.TrimSpace(*question) == "" || strings.TrimSpace(*recommend) == "" || strings.TrimSpace(*why) == "":
			return usageError(io, "an ask needs --question, --recommend and --why")
		case len(alts) == 0 || len(alts) != len(altWhys):
			return usageError(io, "give each --alt its --alt-why (at least one alternative)")
		}
		req.Recommended = wire.AskOptionRequest{Label: *recommend, Why: *why}
		for i, label := range alts {
			req.Alternatives = append(req.Alternatives, wire.AskOptionRequest{Label: label, Why: altWhys[i]})
		}
	}
	if *clientID == "" {
		*clientID = "convoz-" + randomHex(8)
	}
	req.ClientID = *clientID
	var bundle string
	if appOpt.set() {
		raw, b, code := appOpt.check(io)
		if code != ExitOK {
			return code
		}
		req.App, bundle = raw, b
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	if appOpt.set() {
		var code int
		if req.App, code = appOpt.send(k, conv, req.App, bundle); code != ExitOK {
			return code
		}
	}
	var out wire.OneAsk
	if err := k.callRetry("POST", wire.RouteAsks, req, &out); err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(map[string]any{"id": out.Ask.ID, "conversation_id": out.Ask.ConversationID, "state": out.Ask.State})
	} else {
		fmt.Fprintln(k.io.Stdout, out.Ask.ID)
	}
	if req.Permission == nil && req.Draft == nil {
		fmt.Fprintln(k.io.Stderr, "hint: use --action ... for a permission ask")
	}
	return ExitOK
}

// askUpdate runs `convoz ask --update ID [--question Q] [--action A --risk R (--undo U | --one-way) --considered C ...]
// [--recommend L --why W --alt L --alt-why W ...] [--owners-call-why W] --answers TEXT`: the asker updates its open ask in place. The options,
// like the permission parts, are given as a whole or not at all.
func askUpdate(f *chatFlags, io IO, pos []string, id int64, req wire.AskUpdateRequest, recommend, why string, alts, altWhys repeated) int {
	if len(pos) != 0 {
		return usageError(io, "usage: convoz ask --update <ask id> [--question Q] [--action A --risk R (--undo U | --one-way) --considered C ...] [--recommend L --why W --alt L --alt-why W ...] [--owners-call-why W] --answers TEXT")
	}
	if recommend != "" || why != "" || len(alts) > 0 || len(altWhys) > 0 {
		if strings.TrimSpace(recommend) == "" || strings.TrimSpace(why) == "" || len(alts) == 0 || len(alts) != len(altWhys) {
			return usageError(io, "to change the options give --recommend, --why and each --alt with its --alt-why")
		}
		req.Recommended = &wire.AskOptionRequest{Label: recommend, Why: why}
		for i, label := range alts {
			req.Alternatives = append(req.Alternatives, wire.AskOptionRequest{Label: label, Why: altWhys[i]})
		}
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	var out wire.OneAsk
	if err := k.callRetry("PATCH", fmt.Sprintf("%s/%d", wire.RouteAsks, id), req, &out); err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(map[string]any{"id": out.Ask.ID, "conversation_id": out.Ask.ConversationID, "state": out.Ask.State, "revision": out.Ask.Revision, "changed": out.Ask.Changed})
	} else {
		fmt.Fprintln(k.io.Stdout, out.Ask.ID)
	}
	return ExitOK
}

// refuse tells the agent on stdout and on stderr, so a script that reads either one sees it, and exits with the usage code.
func refuse(io IO, msg string) int {
	fmt.Fprintln(io.Stdout, msg)
	return usageError(io, msg)
}

// askWithdraw runs `convoz ask withdraw <id>`: the asker takes back its open ask.
func askWithdraw(f *chatFlags, io IO, rawID string) int {
	id, err := strconv.ParseInt(rawID, 10, 64)
	if err != nil || id <= 0 {
		return usageError(io, rawID+" is not an ask id")
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	if err := k.callRetry("POST", fmt.Sprintf("%s/%d/withdraw", wire.RouteAsks, id), struct{}{}, nil); err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(map[string]any{"id": id, "withdrawn": true})
	}
	return ExitOK
}

package cli

func init() {
	Register(Command{Name: "join", Summary: "Ask to join a conversation you are not in.", Example: "convoz join --as code-review 41", Order: 60, Run: Join,
		Usage: "convoz join <conv>"})
	Register(Command{Name: "remove", Summary: "Take an agent out of a conversation (triage agents only).", Example: "convoz remove --as triage 41 @docs", Order: 63, Run: Remove,
		Usage: "convoz remove <conv> @agent"})
}

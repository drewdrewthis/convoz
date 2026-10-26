package cli

func init() {
	Register(Command{Name: "ask", Summary: "Ask the owner's permission for one action you are confident in.", Example: "convoz ask --as code-review --action \"Merge PR 415 into main\" --risk \"Checkout can break for 5 min\" --undo \"Revert the merge commit\" --considered \"Hold for PR 412: costs a day\" --confidence 90 41", Order: 55, Run: Ask,
		Usage: "convoz ask --action A --risk R (--undo U | --one-way) --considered C [--considered C]... --confidence N [--question Q] [--urgent] [--thread ROOT] [--app FILE] [--client-id C] <conv>\n       convoz ask --draft TEXT [--original TEXT] [--original-from LINE] [--question Q] <conv> [Q]   (anything sent in the owner's name)\n       convoz ask --update <id> [--action A --risk R (--undo U | --one-way) --considered C ...] [--answers TEXT]\n       convoz ask withdraw <id>\n       legacy decision ask: convoz ask --question Q --recommend L --why W --alt L --alt-why W --owners-call KIND --owners-call-why W <conv>"})
}

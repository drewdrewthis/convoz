package cli

func init() {
	Register(Command{Name: "pickup", Order: 63, Run: Pickup,
		Usage: "convoz pickup <conv>"})
}

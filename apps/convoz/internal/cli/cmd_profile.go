package cli

func init() {
	Register(Command{Name: "profile", Order: 33, Run: Profile,
		Usage: "convoz profile [--json]\n       convoz profile --set name=... description=... capabilities=a,b\n       convoz profile --set handle=NEW [--no-wait]"})
}

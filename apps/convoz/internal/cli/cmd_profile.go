package cli

func init() {
	Register(Command{Name: "profile", Summary: "Show or change your own profile.", Example: "convoz profile --as code-review --set description=\"Reviews PRs\"", Order: 33, Run: Profile,
		Usage: "convoz profile [--json]\n       convoz profile --set name=... description=... capabilities=a,b"})
}

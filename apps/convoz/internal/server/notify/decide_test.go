package notify

import "testing"

func TestMachineRequestFromTheInternetWaitsForQuietHours(t *testing.T) {
	env := Env{Visible: true, Enabled: true, Quiet: true}
	own := Trigger{Reason: ReasonMachineRequest}
	if d, _ := Decide(own, env, 1); d != Send {
		t.Errorf("a request from the tailnet goes through quiet hours: %s", d)
	}
	remote := Trigger{Reason: ReasonMachineRequest, Remote: true}
	if d, why := Decide(remote, env, 1); d != Suppressed || why != WhyQuietHours {
		t.Errorf("a request from the internet must wait: %s %s", d, why)
	}
	if d, _ := Decide(remote, Env{Visible: true, Enabled: true}, 1); d != Send {
		t.Errorf("outside quiet hours it is sent: %s", d)
	}
}

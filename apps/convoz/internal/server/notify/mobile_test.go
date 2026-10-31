package notify

import (
	"slices"
	"testing"
)

// Owner, conv 179 msg 14826: "Turn off toasts on mobile, they should go out as notifications." The news a toast showed (any new
// message, an agent asking to connect) is pushed instead; a plain message goes only to a phone, so a desktop with push on is unchanged.

func idsOf(list []live) []int64 {
	out := make([]int64, len(list))
	for i, l := range list {
		out[i] = l.ID
	}
	return out
}

func TestAPlainMessageIsPushedOnlyToDevicesThatTakeMessages(t *testing.T) {
	subs := []live{{ID: 1, Device: 10}, {ID: 2, Device: 20, Messages: true}}
	if got := idsOf(targetsOf(Trigger{Reason: ReasonMessage}, subs)); !slices.Equal(got, []int64{2}) {
		t.Errorf("a plain message goes to the phone only: %v", got)
	}
	if got := idsOf(targetsOf(Trigger{Reason: ReasonMention}, subs)); !slices.Equal(got, []int64{1, 2}) {
		t.Errorf("a mention goes to every device, as before: %v", got)
	}
	if got := idsOf(targetsOf(Trigger{Reason: ReasonSecurity, ExceptDevice: 20}, subs)); !slices.Equal(got, []int64{1}) {
		t.Errorf("the device that did it still gets no security push: %v", got)
	}
}

func TestAPlainMessageFollowsMuteQuietHoursAndFocus(t *testing.T) {
	m := Trigger{Reason: ReasonMessage}
	if d, why := Decide(m, Env{Visible: true, Enabled: true, Muted: true}, 1); d != Suppressed || why != WhyMuted {
		t.Errorf("muted: %s %s", d, why)
	}
	if d, why := Decide(m, Env{Visible: true, Enabled: true, Quiet: true}, 1); d != Suppressed || why != WhyQuietHours {
		t.Errorf("quiet hours: %s %s", d, why)
	}
	if d, why := Decide(m, Env{Visible: true, Enabled: true, Focused: true}, 1); d != Suppressed || why != WhyActiveHere {
		t.Errorf("open on a device: %s %s", d, why)
	}
	if d, why := Decide(m, Env{Visible: true, Enabled: true}, 0); d != Suppressed || why != WhyNoSubscription {
		t.Errorf("no phone takes messages: %s %s", d, why)
	}
}

// An identity request waits 24 hours for the owner, so unlike a machine request (10 minutes) it does not wake them in quiet hours.
func TestAnAgentAskingToConnectIsPushedToEveryDevice(t *testing.T) {
	r := Trigger{Reason: ReasonIdentityRequest}
	if got := idsOf(targetsOf(r, []live{{ID: 1, Device: 10}, {ID: 2, Device: 20, Messages: true}})); !slices.Equal(got, []int64{1, 2}) {
		t.Errorf("every device: %v", got)
	}
	if d, why := Decide(r, Env{Visible: true, Enabled: true}, 1); d != Send {
		t.Errorf("sent: %s %s", d, why)
	}
	if d, why := Decide(r, Env{Visible: true, Enabled: true, Quiet: true}, 1); d != Suppressed || why != WhyQuietHours {
		t.Errorf("it waits for the end of quiet hours: %s %s", d, why)
	}
	p := Compose(ReasonIdentityRequest, "t", Facts{Previews: PreviewNone, Machine: "drew-sweatshop", Text: "as @lw-scenarios", URL: URLNow}, 1)
	if p.Title != "drew-sweatshop wants to connect" || p.Body != "as @lw-scenarios" {
		t.Errorf("payload: %+v", p)
	}
}

// A plain message with no device that takes messages is not news anywhere: it is not recorded, so a desktop-only owner gets no log row
// per message and the log reads as before.
func TestAPlainMessageWithNoPhoneIsNotRecorded(t *testing.T) {
	if !unrecorded(Trigger{Reason: ReasonMessage}, nil) {
		t.Error("a plain message with no phone must not be recorded")
	}
	if unrecorded(Trigger{Reason: ReasonMessage}, []live{{ID: 2, Messages: true}}) {
		t.Error("with a phone it is decided and recorded")
	}
	if unrecorded(Trigger{Reason: ReasonMention}, nil) {
		t.Error("a mention with no device is still recorded (no_subscription)")
	}
}

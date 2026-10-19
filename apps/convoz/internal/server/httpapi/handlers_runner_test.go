package httpapi

import "testing"

const second = 1000

func TestRunnerHoldsAgentAgainstOtherSessions(t *testing.T) {
	var rs runnerSet
	v, _, leave := rs.admit(1, 10, true, "box-2", 0)
	if v != pollAllowed {
		t.Fatalf("runner: %v", v)
	}
	if v, who, _ := rs.admit(1, 20, false, "box-3", 5*second); v != pollRunnerHolds || who != "box-2" {
		t.Errorf("a watch of another session while the runner polls: %v %q", v, who)
	}
	if v, _, _ := rs.admit(1, 10, false, "box-2", 5*second); v != pollAllowed {
		t.Errorf("the runner's own session may watch: %v", v)
	}
	if v, _, _ := rs.admit(2, 20, false, "box-3", 5*second); v != pollAllowed {
		t.Errorf("another agent is free: %v", v)
	}
	leave(10 * second)
	if v, _, _ := rs.admit(1, 20, false, "box-3", 30*second); v != pollRunnerHolds {
		t.Errorf("still held 20 s after its last call: %v", v)
	}
	if v, _, _ := rs.admit(1, 20, false, "box-3", 41*second); v != pollAllowed {
		t.Errorf("free 30 s after its last call: %v", v)
	}
}

func TestAnyCallOfTheRunnerSessionKeepsTheLock(t *testing.T) {
	var rs runnerSet
	_, _, leave := rs.admit(1, 10, true, "box-2", 0)
	leave(1 * second)
	rs.touch(1, 10, 100*second)
	if v, _, _ := rs.admit(1, 20, false, "box-3", 120*second); v != pollRunnerHolds {
		t.Errorf("a command of the runner called 20 s ago: %v", v)
	}
	rs.touch(1, 99, 200*second) // another session's call changes nothing
	if v, _, _ := rs.admit(1, 20, false, "box-3", 131*second); v != pollAllowed {
		t.Errorf("free again: %v", v)
	}
}

func TestEndingTheRunnerSessionReleasesAtOnce(t *testing.T) {
	var rs runnerSet
	rs.admit(1, 10, true, "box-2", 0)
	rs.release(1, 99) // not the runner's session
	if v, _, _ := rs.admit(1, 20, false, "box-3", second); v != pollRunnerHolds {
		t.Fatalf("held: %v", v)
	}
	rs.release(1, 10)
	if v, _, _ := rs.admit(1, 20, false, "box-3", 2*second); v != pollAllowed {
		t.Errorf("released: %v", v)
	}
}

func TestRunnerIsRefusedWhileAWatchIsOpenOrJustWas(t *testing.T) {
	var rs runnerSet
	_, _, leave := rs.admit(1, 20, false, "box-3", 0)
	if v, _, _ := rs.admit(1, 10, true, "box-2", second); v != pollWatchOpen {
		t.Errorf("watch open: %v", v)
	}
	leave(10 * second)
	if v, _, _ := rs.admit(1, 10, true, "box-2", 30*second); v != pollWatchOpen {
		t.Errorf("a watch ended 20 s ago: %v", v)
	}
	if v, _, _ := rs.admit(1, 10, true, "box-2", 41*second); v != pollAllowed {
		t.Errorf("30 s after the watch: %v", v)
	}
}

func TestRunnerOfTheSameMachineTakesOverAfterARestart(t *testing.T) {
	var rs runnerSet
	rs.admit(1, 10, true, "box-2", 0)
	if v, _, _ := rs.admit(1, 11, true, "box-2", second); v != pollAllowed {
		t.Errorf("same machine, new session: %v", v)
	}
	if v, who, _ := rs.admit(1, 12, true, "box-3", 2*second); v != pollRunnerHolds || who != "box-2" {
		t.Errorf("another machine: %v %q", v, who)
	}
}

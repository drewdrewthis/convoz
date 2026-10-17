package httpapi

import "github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"

// authRoutes are the routes of passkeys, devices, recovery, step-ups, machines, the device flow and session leases. Only the work package that owns this module edits this file.
var authRoutes = []Route{
	{Method: "POST", Pattern: "/api/auth/bootstrap/check", Auth: authz.Pub, handle: (*Server).bootstrapCheck},
	{Method: "POST", Pattern: "/api/auth/bootstrap/options", Auth: authz.Pub, handle: (*Server).bootstrapOptions},
	{Method: "POST", Pattern: "/api/auth/bootstrap/verify", Auth: authz.Pub, handle: (*Server).bootstrapVerify},
	{Method: "POST", Pattern: "/api/auth/passkey/login/options", Auth: authz.Pub, handle: (*Server).loginOptions},
	{Method: "POST", Pattern: "/api/auth/passkey/login/verify", Auth: authz.Pub, handle: (*Server).loginVerify},
	{Method: "POST", Pattern: "/api/auth/recovery", Auth: authz.Pub, handle: (*Server).recovery},
	{Method: "POST", Pattern: "/api/auth/passkey/register/options", Auth: authz.HumanLimited, handle: (*Server).registerOptions},
	{Method: "POST", Pattern: "/api/auth/passkey/register/verify", Auth: authz.HumanLimited, StepUp: "passkey.add", handle: (*Server).registerVerify},
	{Method: "POST", Pattern: "/api/auth/step-up/options", Auth: authz.Human, RefuseLease: true, handle: (*Server).stepUpOptions},
	{Method: "POST", Pattern: "/api/auth/step-up/verify", Auth: authz.Human, handle: (*Server).stepUpVerify},
	{Method: "POST", Pattern: "/api/auth/logout", Auth: authz.HumanLimited, handle: (*Server).logout},
	{Method: "GET", Pattern: "/api/me/devices", Auth: authz.Human, handle: (*Server).devices},
	{Method: "DELETE", Pattern: "/api/me/devices/:id", Auth: authz.Human, handle: (*Server).deleteDevice},
	{Method: "GET", Pattern: "/api/me/passkeys", Auth: authz.Human, handle: (*Server).passkeys},
	{Method: "DELETE", Pattern: "/api/me/passkeys/:id", Auth: authz.Human, StepUp: "passkey.remove", handle: (*Server).deletePasskey},
	{Method: "GET", Pattern: "/api/me/recovery-codes", Auth: authz.Human, handle: (*Server).recoveryCount},
	{Method: "POST", Pattern: "/api/me/recovery-codes", Auth: authz.Human, StepUp: "recovery.regenerate", handle: (*Server).regenerateRecoveryCodes},
	// The machine login (device flow): no cookie and no credential, so no Origin check; the protocol limits the polls.
	{Method: "POST", Pattern: "/api/device/code", Auth: authz.Pub, NoCSRF: true, handle: (*Server).deviceCode},
	{Method: "POST", Pattern: "/api/device/token", Auth: authz.Pub, NoCSRF: true, NoLimit: true, handle: (*Server).deviceToken},
	{Method: "GET", Pattern: "/api/machines/requests", Auth: authz.Owner, handle: (*Server).machineRequests},
	{Method: "POST", Pattern: "/api/machines/requests/deny-all", Auth: authz.Owner, handle: (*Server).denyAllRequests},
	{Method: "POST", Pattern: "/api/machines/requests/:id/approve", Auth: authz.Owner, StepUp: "machine.approve", handle: (*Server).approveRequest},
	{Method: "POST", Pattern: "/api/machines/requests/:id/deny", Auth: authz.Owner, handle: (*Server).denyRequest},
	{Method: "GET", Pattern: "/api/machines", Auth: authz.Owner, handle: (*Server).machines},
	{Method: "PATCH", Pattern: "/api/machines/:id", Auth: authz.Owner, StepUp: "machine.allow", handle: (*Server).patchMachine},
	{Method: "POST", Pattern: "/api/machines/:id/reveal", Auth: authz.Owner, StepUp: "machine.reveal", handle: (*Server).revealKey},
	{Method: "POST", Pattern: "/api/machines/:id/regenerate", Auth: authz.Owner, StepUp: "machine.regenerate", handle: (*Server).regenerateKey},
	{Method: "POST", Pattern: "/api/machines/:id/revoke", Auth: authz.Owner, StepUp: "machine.revoke", handle: (*Server).revokeMachine},
	{Method: "POST", Pattern: "/api/sessions", Auth: authz.Machine, handle: (*Server).mintSession},
	{Method: "POST", Pattern: "/api/sessions/renew", Auth: authz.Lease, handle: (*Server).renewSession},
	{Method: "DELETE", Pattern: "/api/sessions/me", Auth: authz.Lease, handle: (*Server).endSession},
	{Method: "GET", Pattern: "/api/sessions", Auth: authz.Owner, handle: (*Server).sessions},
}

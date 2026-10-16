// Command testroutes prints the testhooks route list, one per line, for scripts/release_guard.py.
package main

import (
	"fmt"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/testroutes"
)

func main() {
	for _, r := range testroutes.All {
		fmt.Println(r)
	}
}

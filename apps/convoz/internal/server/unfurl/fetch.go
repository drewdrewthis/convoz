package unfurl

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

// The limits of one fetch. A page is read only as far as its head, so a huge or endless body costs a fixed amount.
const (
	maxBody      = 512 << 10
	fetchTimeout = 8 * time.Second
	maxRedirects = 3
	userAgent    = "Convoz-Unfurl/1"
)

// Resolver looks up the addresses of a host name. The system resolver in a release; a fixed table in the test build.
type Resolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

// Fetcher fetches one page for a preview card without ever reaching a private address (design: unfurl, SSRF). Every connection,
// the first and each redirect, goes through dial: it looks the host up once, refuses the whole host if any answer is not Public,
// and connects to the IP it checked, so a name cannot answer with one address to the check and another to the connection.
type Fetcher struct {
	resolver Resolver
	connect  func(ctx context.Context, ip netip.Addr, port string) (net.Conn, error)
	plainTLS bool // test build only: an https address is served over plain TCP by a fixture
}

// NewFetcher is the fetcher of this build. A release uses the system resolver and the network.
func NewFetcher() *Fetcher {
	f := &Fetcher{resolver: net.DefaultResolver, connect: func(ctx context.Context, ip netip.Addr, port string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "tcp", net.JoinHostPort(ip.String(), port))
	}}
	return withFixtures(f)
}

// Fetch makes the card of one address. An error that Permanent reports is final; any other may be tried again.
func (f *Fetcher) Fetch(ctx context.Context, raw string) (Card, error) {
	u, err := Clean(raw)
	if err != nil {
		return Card{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()
	if api, repo, number, kind, ok := githubItem(u); ok {
		data, _, err := f.get(ctx, api, "application/vnd.github+json")
		if err != nil {
			return Card{}, err
		}
		return parseGithub(u, repo, number, kind, data)
	}
	data, ctype, err := f.get(ctx, u, "text/html")
	if err != nil {
		return Card{}, err
	}
	if !strings.Contains(ctype, "html") {
		return Card{}, errNotPage
	}
	return parsePage(u, data), nil
}

var errNotPage = errors.New("unfurl: not a web page")

type statusError int

func (e statusError) Error() string { return fmt.Sprintf("unfurl: the site answered %d", int(e)) }

// Permanent says whether trying again cannot help: an address that is refused, a name that does not exist, a page that is not a
// page, or an answer of 4xx other than 429.
func Permanent(err error) bool {
	var dns *net.DNSError
	var status statusError
	switch {
	case errors.Is(err, ErrBlocked), errors.Is(err, errNotPage):
		return true
	case errors.As(err, &dns):
		return dns.IsNotFound
	case errors.As(err, &status):
		return status >= 400 && status < 500 && status != http.StatusTooManyRequests
	}
	return false
}

// get reads the head of one address, following at most maxRedirects redirects, each checked like the first request.
func (f *Fetcher) get(ctx context.Context, u *url.URL, accept string) (body []byte, ctype string, err error) {
	client := &http.Client{
		Transport: f.transport(),
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > maxRedirects {
				return errors.New("unfurl: too many redirects")
			}
			if _, err := Clean(req.URL.String()); err != nil {
				return err // a redirect to ftp:, file: and the like
			}
			req.URL.User = nil
			return nil
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, "", ErrBlocked
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("User-Agent", userAgent)
	resp, err := client.Do(req)
	if err != nil {
		if errors.Is(err, ErrBlocked) {
			return nil, "", ErrBlocked
		}
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, "", statusError(resp.StatusCode)
	}
	body, err = io.ReadAll(io.LimitReader(resp.Body, maxBody))
	return body, strings.ToLower(resp.Header.Get("Content-Type")), err
}

// transport sends no cookies and credentials of its own, uses no proxy (a proxy would resolve names where we cannot check them)
// and keeps nothing alive, so every request is checked afresh.
func (f *Fetcher) transport() *http.Transport {
	t := &http.Transport{
		Proxy:                  nil,
		DialContext:            f.dial,
		DisableKeepAlives:      true,
		TLSHandshakeTimeout:    5 * time.Second,
		ResponseHeaderTimeout:  5 * time.Second,
		MaxResponseHeaderBytes: 32 << 10,
	}
	if f.plainTLS {
		t.DialTLSContext = f.dial
	}
	return t
}

// dial resolves the host once, refuses it unless every answer is Public, and connects to an address it checked.
func (f *Fetcher) dial(ctx context.Context, _, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, ErrBlocked
	}
	var ips []netip.Addr
	if ip, err := netip.ParseAddr(host); err == nil {
		ips = []netip.Addr{ip}
	} else if ips, err = f.resolver.LookupNetIP(ctx, "ip", host); err != nil {
		return nil, err
	}
	if len(ips) == 0 {
		return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	for _, ip := range ips {
		if !Public(ip) {
			return nil, ErrBlocked
		}
	}
	var last error
	for _, ip := range ips {
		conn, err := f.connect(ctx, ip, port)
		if err == nil {
			return conn, nil
		}
		last = err
	}
	return nil, last
}

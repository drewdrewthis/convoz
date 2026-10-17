package unfurl

import (
	"encoding/json"
	"html"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Card is what the worker learned about one address.
type Card struct {
	Status      string // pending, ok or unavailable
	URL         string
	Kind        string // generic, github_pr or github_issue
	Site        string
	Title       string
	Description string
	Meta        map[string]any
}

const (
	maxTitle = 200
	maxDesc  = 300
)

var (
	metaRE  = regexp.MustCompile(`(?is)<meta\s[^>]*>`)
	attrRE  = regexp.MustCompile(`(?is)([a-z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))`)
	titleRE = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
)

// parsePage reads the title, description and site name a page declares about itself: Open Graph first, then the plain tags.
// It reads only what the page says; it never runs anything in it.
func parsePage(u *url.URL, page []byte) Card {
	meta := map[string]string{}
	for _, tag := range metaRE.FindAllString(string(page), -1) {
		attrs := map[string]string{}
		for _, m := range attrRE.FindAllStringSubmatch(tag, -1) {
			attrs[strings.ToLower(m[1])] = m[2] + m[3] + m[4]
		}
		name := strings.ToLower(attrs["property"] + attrs["name"])
		if _, seen := meta[name]; name != "" && !seen {
			meta[name] = attrs["content"]
		}
	}
	title := first(meta["og:title"], meta["twitter:title"])
	if title == "" {
		if m := titleRE.FindStringSubmatch(string(page)); m != nil {
			title = m[1]
		}
	}
	card := Card{Kind: "generic", URL: u.String(), Status: "ok",
		Site:        clip(first(meta["og:site_name"], u.Hostname()), 100),
		Title:       clip(first(title, u.Hostname()), maxTitle),
		Description: clip(first(meta["og:description"], meta["twitter:description"], meta["description"]), maxDesc)}
	return card
}

func first(list ...string) string {
	for _, s := range list {
		if s = tidy(s); s != "" {
			return s
		}
	}
	return ""
}

// tidy decodes HTML entities and folds runs of white space, so a title with a line break reads as one line.
func tidy(s string) string { return strings.Join(strings.Fields(html.UnescapeString(s)), " ") }

func clip(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	r := []rune(s)
	return string(r[:max-1]) + "…"
}

var githubRE = regexp.MustCompile(`^/([^/]+)/([^/]+)/(pull|issues)/(\d{1,9})/?$`)

// githubItem reads a GitHub pull request or issue address into the API address that holds its facts.
func githubItem(u *url.URL) (api *url.URL, repo, number, kind string, ok bool) {
	if u.Hostname() != "github.com" {
		return nil, "", "", "", false
	}
	m := githubRE.FindStringSubmatch(u.Path)
	if m == nil {
		return nil, "", "", "", false
	}
	kind, route := "github_issue", "issues"
	if m[3] == "pull" {
		kind, route = "github_pr", "pulls"
	}
	api = &url.URL{Scheme: "https", Host: "api.github.com", Path: "/repos/" + m[1] + "/" + m[2] + "/" + route + "/" + m[4]}
	return api, m[1] + "/" + m[2], m[4], kind, true
}

// parseGithub turns the API answer for a pull request or an issue into a card: the title, the first line of the text, and the state.
func parseGithub(u *url.URL, repo, number, kind string, data []byte) (Card, error) {
	var in struct {
		Title  string `json:"title"`
		Body   string `json:"body"`
		State  string `json:"state"`
		Merged bool   `json:"merged"`
	}
	if err := json.Unmarshal(data, &in); err != nil {
		return Card{}, err
	}
	state := in.State
	if in.Merged {
		state = "merged"
	}
	if state != "open" && state != "closed" && state != "merged" {
		state = "open"
	}
	n := 0
	for _, c := range number {
		n = n*10 + int(c-'0')
	}
	body, _, _ := strings.Cut(strings.TrimSpace(in.Body), "\n")
	return Card{Status: "ok", Kind: kind, URL: u.String(), Site: "GitHub", Title: clip(first(in.Title, repo+"#"+number), maxTitle),
		Description: clip(tidy(body), maxDesc), Meta: map[string]any{"repo": repo, "number": n, "state": state}}, nil
}

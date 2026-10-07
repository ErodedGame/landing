package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"testing"
	"time"
)

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func providerResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

func testApp(t *testing.T, transport transportFunc) *app {
	t.Helper()
	if transport == nil {
		transport = func(r *http.Request) (*http.Response, error) {
			if err := r.ParseMultipartForm(4096); err != nil {
				t.Fatal(err)
			}
			body, _ := json.Marshal(map[string]any{"member": map[string]any{"address": r.FormValue("address"), "subscribed": true}})
			return providerResponse(http.StatusOK, string(body)), nil
		}
	}
	c := config{
		apiKey: "test-api-key", listAddress: "alpha@mg.example.com",
		apiBaseURL: "https://api.mailgun.net/v3", rateLimit: 100,
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   time.Second,
		CheckRedirect: func(r *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	a, err := newApp(c, client)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func signupRequest(body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "http://example.com/signup", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r.Header.Set("Accept", "application/json")
	return r
}

func TestSignupAddsMember(t *testing.T) {
	calls := 0
	a := testApp(t, func(r *http.Request) (*http.Response, error) {
		calls++
		if r.Method != http.MethodPost || r.URL.String() != "https://api.mailgun.net/v3/lists/alpha@mg.example.com/members" {
			t.Fatalf("unexpected Mailgun request: %s %s", r.Method, r.URL)
		}
		user, key, ok := r.BasicAuth()
		if !ok || user != "api" || key != "test-api-key" {
			t.Fatal("missing Mailgun authentication")
		}
		if err := r.ParseMultipartForm(4096); err != nil {
			t.Fatal(err)
		}
		if r.FormValue("address") != "pilot+alpha@example.com" || r.FormValue("upsert") != "true" || r.FormValue("subscribed") != "true" {
			t.Fatal("incorrect Mailgun member fields")
		}
		return providerResponse(http.StatusOK, `{"member":{"address":"pilot+alpha@example.com","subscribed":true}}`), nil
	})
	body := url.Values{"email": {"  pilot+alpha@example.com  "}}.Encode()
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		a.handler().ServeHTTP(w, signupRequest(body))
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"ok":true`) {
			t.Fatalf("signup failed: %d %s", w.Code, w.Body.String())
		}
		if strings.Contains(w.Body.String(), "test-api-key") || strings.Contains(w.Body.String(), "pilot+alpha@example.com") {
			t.Fatal("receipt exposed private data")
		}
	}
	if calls != 2 {
		t.Fatalf("expected two idempotent member requests, got %d", calls)
	}
}

func TestSignupRejectsInvalidRequests(t *testing.T) {
	tests := []struct {
		name   string
		body   string
		change func(*http.Request)
		status int
	}{
		{"missing address", "", nil, http.StatusBadRequest},
		{"invalid address", "email=not-an-email", nil, http.StatusBadRequest},
		{"display name", url.Values{"email": {"Pilot <pilot@example.com>"}}.Encode(), nil, http.StatusBadRequest},
		{"non-ASCII address", url.Values{"email": {"pilót@example.com"}}.Encode(), nil, http.StatusBadRequest},
		{"duplicate field", "email=a%40example.com&email=b%40example.com", nil, http.StatusBadRequest},
		{"query-only address", "", func(r *http.Request) { r.URL.RawQuery = "email=a%40example.com" }, http.StatusBadRequest},
		{"malformed form", "email=%zz", nil, http.StatusBadRequest},
		{"oversized request", "email=" + strings.Repeat("x", 4096), nil, http.StatusRequestEntityTooLarge},
		{"unsupported content type", "{}", func(r *http.Request) { r.Header.Set("Content-Type", "application/json") }, http.StatusUnsupportedMediaType},
		{"foreign origin", "email=a%40example.com", func(r *http.Request) { r.Header.Set("Origin", "https://other.example") }, http.StatusForbidden},
		{"opaque origin", "email=a%40example.com", func(r *http.Request) { r.Header.Set("Origin", "null") }, http.StatusForbidden},
		{"cross-site request", "email=a%40example.com", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }, http.StatusForbidden},
		{"wrong method", "", func(r *http.Request) { r.Method = http.MethodGet }, http.StatusMethodNotAllowed},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a := testApp(t, func(r *http.Request) (*http.Response, error) {
				t.Fatal("invalid signup reached Mailgun")
				return nil, errors.New("unexpected request")
			})
			r := signupRequest(tt.body)
			if tt.change != nil {
				tt.change(r)
			}
			w := httptest.NewRecorder()
			a.handler().ServeHTTP(w, r)
			if w.Code != tt.status {
				t.Fatalf("got %d, want %d: %s", w.Code, tt.status, w.Body.String())
			}
		})
	}
}

func TestProviderFailuresNeverAcknowledge(t *testing.T) {
	for _, name := range []string{"rejected", "unavailable", "malformed receipt", "wrong member", "unsubscribed", "network error", "redirect"} {
		t.Run(name, func(t *testing.T) {
			calls := 0
			a := testApp(t, func(r *http.Request) (*http.Response, error) {
				calls++
				switch name {
				case "rejected":
					return providerResponse(http.StatusUnauthorized, "private upstream details"), nil
				case "unavailable":
					return providerResponse(http.StatusTooManyRequests, "private upstream details"), nil
				case "malformed receipt":
					return providerResponse(http.StatusOK, "not JSON"), nil
				case "wrong member":
					return providerResponse(http.StatusOK, `{"member":{"address":"other@example.com","subscribed":true}}`), nil
				case "unsubscribed":
					return providerResponse(http.StatusOK, `{"member":{"address":"pilot@example.com","subscribed":false}}`), nil
				case "redirect":
					response := providerResponse(http.StatusTemporaryRedirect, "")
					response.Header.Set("Location", "https://other.example/")
					return response, nil
				default:
					return nil, errors.New("private upstream details")
				}
			})
			w := httptest.NewRecorder()
			a.handler().ServeHTTP(w, signupRequest("email=pilot%40example.com"))
			if w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), `"ok":false`) || strings.Contains(w.Body.String(), "private upstream details") || calls != 1 {
				t.Fatalf("incorrect failure response: %d %s (calls %d)", w.Code, w.Body.String(), calls)
			}
		})
	}
}

func TestNativeFormAndEmbeddedAssets(t *testing.T) {
	a := testApp(t, nil)
	handler := a.handler()
	r := signupRequest("email=pilot%40example.com")
	r.Header.Set("Accept", "text/html")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/?signup=accepted" {
		t.Fatalf("native signup did not redirect: %d", w.Code)
	}
	for _, path := range []string{"/", "/?signup=accepted", "/styles.css", "/script.js", "/ship-model.js", "/ship-flight.js", "/assets/eroded-logo.svg", "/assets/fonts/SourceCodePro-Regular.ttf", "/healthz"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusOK || w.Body.Len() == 0 || strings.Contains(w.Body.String(), "test-api-key") {
			t.Fatalf("could not serve embedded resource %s: %d", path, w.Code)
		}
	}
	for _, path := range []string{"/main.go", "/main_test.go", "/go.mod", "/.env", "/README.md", "/assets/", "/assets/fonts/"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusNotFound {
			t.Fatalf("private file or directory exposed: %s (%d)", path, w.Code)
		}
	}
}

func TestRateLimitAndTrustedProxies(t *testing.T) {
	a := testApp(t, nil)
	a.limits = newRateLimiter(1)
	handler := a.handler()
	for i, status := range []int{http.StatusOK, http.StatusTooManyRequests} {
		r := signupRequest("email=pilot%40example.com")
		// Untrusted clients cannot evade limits with forwarded-address headers.
		r.Header.Set("X-Forwarded-For", []string{"192.0.2.10", "192.0.2.11"}[i])
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("attempt %d: got %d, want %d", i, w.Code, status)
		}
		if status == http.StatusTooManyRequests && w.Header().Get("Retry-After") != "60" {
			t.Fatal("rate limit omitted retry interval")
		}
	}
	a.config.trustedProxies = []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32"), netip.MustParsePrefix("10.0.0.0/8")}
	r := signupRequest("")
	r.RemoteAddr = "127.0.0.1:12345"
	r.Header.Set("X-Forwarded-For", "203.0.113.99, 192.0.2.20, 10.0.0.2")
	if ip := a.clientIP(r); ip != "192.0.2.20" {
		t.Fatalf("trusted proxy chain used spoofed address: %s", ip)
	}
	now := time.Now()
	limiter := newRateLimiter(1)
	if !limiter.allow("one", now) || limiter.allow("one", now) || !limiter.allow("two", now) || !limiter.allow("one", now.Add(time.Minute)) {
		t.Fatal("rate windows did not expire or isolate clients")
	}
}

func TestConfiguredOriginAndCanceledRequest(t *testing.T) {
	a := testApp(t, func(r *http.Request) (*http.Response, error) {
		return nil, r.Context().Err()
	})
	a.config.publicOrigin = "https://eroded.example.com"
	r := signupRequest("email=pilot%40example.com")
	r.Header.Set("Origin", "https://eroded.example.com")
	if !a.sameOrigin(r) {
		t.Fatal("canonical origin was rejected behind a proxy")
	}
	r.Header.Set("Origin", "http://eroded.example.com")
	if a.sameOrigin(r) {
		t.Fatal("different origin scheme was accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := a.subscribe(ctx, "pilot@example.com"); err == nil {
		t.Fatal("canceled request was acknowledged")
	}
}

func TestConfigValidation(t *testing.T) {
	for _, name := range []string{"HTTP_ADDR", "MAILGUN_API_KEY", "MAILGUN_LIST_ADDRESS", "MAILGUN_API_BASE_URL", "PUBLIC_URL", "SIGNUP_RATE_LIMIT", "TRUSTED_PROXY_CIDRS"} {
		t.Setenv(name, "")
	}
	t.Setenv("MAILGUN_API_KEY", "test-api-key")
	t.Setenv("MAILGUN_LIST_ADDRESS", "alpha@mg.example.com")
	c, err := loadConfig()
	if err != nil || c.addr != ":8080" || c.apiBaseURL != "https://api.mailgun.net/v3" || c.rateLimit != 5 {
		t.Fatalf("default config failed: %v", err)
	}
	for _, test := range []struct{ name, value string }{
		{"MAILGUN_API_KEY", ""}, {"MAILGUN_LIST_ADDRESS", "invalid"},
		{"MAILGUN_API_BASE_URL", "http://api.mailgun.net/v3"},
		{"MAILGUN_API_BASE_URL", "https://user:secret@api.mailgun.net/v3"},
		{"PUBLIC_URL", "https://example.com/path"}, {"SIGNUP_RATE_LIMIT", "0"},
		{"TRUSTED_PROXY_CIDRS", "anyone"},
	} {
		t.Run(test.name+test.value, func(t *testing.T) {
			t.Setenv(test.name, test.value)
			if _, err := loadConfig(); err == nil {
				t.Fatalf("invalid %s accepted", test.name)
			}
		})
	}
}

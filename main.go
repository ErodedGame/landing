package main

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"io/fs"
	"log"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/mail"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed index.html styles.css script.js ship-model.js ship-flight.js assets
var siteFiles embed.FS

type config struct {
	addr           string
	apiKey         string
	listAddress    string
	apiBaseURL     string
	publicOrigin   string
	rateLimit      int
	trustedProxies []netip.Prefix
}

func loadConfig() (config, error) {
	c := config{
		addr:        envDefault("HTTP_ADDR", ":8080"),
		apiKey:      strings.TrimSpace(os.Getenv("MAILGUN_API_KEY")),
		listAddress: strings.TrimSpace(os.Getenv("MAILGUN_LIST_ADDRESS")),
		apiBaseURL:  strings.TrimRight(envDefault("MAILGUN_API_BASE_URL", "https://api.mailgun.net/v3"), "/"),
		rateLimit:   5,
	}
	if c.apiKey == "" {
		return c, errors.New("MAILGUN_API_KEY is required")
	}
	if !validEmail(c.listAddress) {
		return c, errors.New("MAILGUN_LIST_ADDRESS must be a valid email address")
	}
	u, err := url.Parse(c.apiBaseURL)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return c, errors.New("MAILGUN_API_BASE_URL must be an HTTPS URL without credentials, query, or fragment")
	}
	if raw := strings.TrimSpace(os.Getenv("PUBLIC_URL")); raw != "" {
		u, err := url.Parse(raw)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
			return c, errors.New("PUBLIC_URL must be an HTTP or HTTPS origin")
		}
		c.publicOrigin = u.Scheme + "://" + u.Host
	}
	if raw := strings.TrimSpace(os.Getenv("SIGNUP_RATE_LIMIT")); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit < 1 {
			return c, errors.New("SIGNUP_RATE_LIMIT must be a positive integer")
		}
		c.rateLimit = limit
	}
	if raw := strings.TrimSpace(os.Getenv("TRUSTED_PROXY_CIDRS")); raw != "" {
		for _, item := range strings.Split(raw, ",") {
			prefix, err := netip.ParsePrefix(strings.TrimSpace(item))
			if err != nil {
				return c, errors.New("TRUSTED_PROXY_CIDRS must contain comma-separated IP networks")
			}
			c.trustedProxies = append(c.trustedProxies, prefix)
		}
	}
	return c, nil
}

func envDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

type app struct {
	config config
	client *http.Client
	page   *template.Template
	limits *rateLimiter
}

type pageData struct {
	Message    string
	Email      string
	Subscribed bool
}

func newApp(c config, client *http.Client) (*app, error) {
	page, err := template.ParseFS(siteFiles, "index.html")
	if err != nil {
		return nil, err
	}
	return &app{config: c, client: client, page: page, limits: newRateLimiter(c.rateLimit)}, nil
}

func (a *app) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		data := pageData{}
		if r.URL.Query().Get("signup") == "accepted" {
			data.Subscribed = true
			data.Message = "you're on the list. watch your inbox for alpha news."
		}
		a.render(w, http.StatusOK, data)
	})
	mux.HandleFunc("POST /signup", a.signup)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = io.WriteString(w, "ok\n")
	})
	files := http.FileServer(http.FS(siteFiles))
	for _, name := range []string{"styles.css", "script.js", "ship-model.js", "ship-flight.js"} {
		mux.Handle("GET /"+name, files)
	}
	mux.HandleFunc("GET /assets/", func(w http.ResponseWriter, r *http.Request) {
		info, err := fs.Stat(siteFiles, strings.TrimPrefix(r.URL.Path, "/"))
		if err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		files.ServeHTTP(w, r)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
		mux.ServeHTTP(w, r)
	})
}

func (a *app) render(w http.ResponseWriter, status int, data pageData) {
	var body bytes.Buffer
	if err := a.page.Execute(&body, data); err != nil {
		log.Print("could not render landing page")
		http.Error(w, "page unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = body.WriteTo(w)
}

func (a *app) signup(w http.ResponseWriter, r *http.Request) {
	if !a.sameOrigin(r) {
		a.reply(w, r, http.StatusForbidden, "please sign up from this website.", "")
		return
	}
	if !a.limits.allow(a.clientIP(r), time.Now()) {
		w.Header().Set("Retry-After", "60")
		a.reply(w, r, http.StatusTooManyRequests, "too many attempts. try again in a minute.", "")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || contentType != "application/x-www-form-urlencoded" {
		a.reply(w, r, http.StatusUnsupportedMediaType, "signup request could not be read. please try again.", "")
		return
	}
	if err := r.ParseForm(); err != nil {
		status := http.StatusBadRequest
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			status = http.StatusRequestEntityTooLarge
		}
		a.reply(w, r, status, "signup request could not be read. please try again.", "")
		return
	}
	addresses := r.PostForm["email"]
	if len(addresses) != 1 || !validEmail(strings.TrimSpace(addresses[0])) {
		a.reply(w, r, http.StatusBadRequest, "please enter a valid email address.", "")
		return
	}
	address := strings.TrimSpace(addresses[0])
	if err := a.subscribe(r.Context(), address); err != nil {
		// Never log submitted addresses, API credentials, or Mailgun response bodies.
		log.Printf("signup failed: %v", err)
		a.reply(w, r, http.StatusBadGateway, "signup is temporarily unavailable. please try again.", address)
		return
	}
	a.reply(w, r, http.StatusOK, "you're on the list. watch your inbox for alpha news.", "")
}

func validEmail(address string) bool {
	if len(address) > 254 || !strings.Contains(address, "@") {
		return false
	}
	for _, character := range address {
		if character <= ' ' || character >= 127 {
			return false
		}
	}
	parsed, err := mail.ParseAddress(address)
	return err == nil && parsed.Address == address
}

func (a *app) subscribe(ctx context.Context, address string) error {
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	for name, value := range map[string]string{"address": address, "subscribed": "true", "upsert": "true"} {
		if err := form.WriteField(name, value); err != nil {
			return errors.New("could not encode Mailgun request")
		}
	}
	if err := form.Close(); err != nil {
		return errors.New("could not encode Mailgun request")
	}
	endpoint := a.config.apiBaseURL + "/lists/" + url.PathEscape(a.config.listAddress) + "/members"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, &body)
	if err != nil {
		return errors.New("could not create Mailgun request")
	}
	req.SetBasicAuth("api", a.config.apiKey)
	req.Header.Set("Content-Type", form.FormDataContentType())
	resp, err := a.client.Do(req)
	if err != nil {
		return errors.New("Mailgun request did not complete")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("Mailgun returned HTTP %d", resp.StatusCode)
	}
	var receipt struct {
		Member struct {
			Address    string `json:"address"`
			Subscribed bool   `json:"subscribed"`
		} `json:"member"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 65536)).Decode(&receipt); err != nil || !strings.EqualFold(receipt.Member.Address, address) || !receipt.Member.Subscribed {
		return errors.New("Mailgun did not confirm the subscription")
	}
	return nil
}

func (a *app) reply(w http.ResponseWriter, r *http.Request, status int, message, email string) {
	w.Header().Set("Cache-Control", "no-store")
	if strings.Contains(r.Header.Get("Accept"), "application/json") {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(struct {
			OK      bool   `json:"ok"`
			Message string `json:"message"`
		}{status == http.StatusOK, message})
		return
	}
	if status == http.StatusOK {
		http.Redirect(w, r, "/?signup=accepted", http.StatusSeeOther)
		return
	}
	a.render(w, status, pageData{Message: message, Email: email})
}

func (a *app) sameOrigin(r *http.Request) bool {
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
			return false
		}
		if a.config.publicOrigin != "" {
			return strings.EqualFold(u.Scheme+"://"+u.Host, a.config.publicOrigin)
		}
		return strings.EqualFold(u.Host, r.Host)
	}
	return true
}

func (a *app) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	ip = ip.Unmap()
	if a.trustedProxy(ip) {
		forwards := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
		for i := len(forwards) - 1; i >= 0 && a.trustedProxy(ip); i-- {
			candidate, err := netip.ParseAddr(strings.TrimSpace(forwards[i]))
			if err != nil {
				return host
			}
			ip = candidate.Unmap()
		}
	}
	return ip.String()
}

func (a *app) trustedProxy(ip netip.Addr) bool {
	for _, prefix := range a.config.trustedProxies {
		if prefix.Contains(ip) {
			return true
		}
	}
	return false
}

type rateWindow struct {
	count int
	until time.Time
}

type rateLimiter struct {
	mu      sync.Mutex
	limit   int
	windows map[string]rateWindow
	swept   time.Time
}

func newRateLimiter(limit int) *rateLimiter {
	return &rateLimiter{limit: limit, windows: make(map[string]rateWindow)}
}

func (l *rateLimiter) allow(ip string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.swept) >= time.Minute {
		for key, window := range l.windows {
			if !now.Before(window.until) {
				delete(l.windows, key)
			}
		}
		l.swept = now
	}
	window, exists := l.windows[ip]
	if !exists || !now.Before(window.until) {
		if !exists && len(l.windows) >= 10000 {
			return false
		}
		window = rateWindow{until: now.Add(time.Minute)}
	}
	if window.count >= l.limit {
		return false
	}
	window.count++
	l.windows[ip] = window
	return true
}

func run() error {
	c, err := loadConfig()
	if err != nil {
		return err
	}
	client := &http.Client{
		Timeout: 10 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	a, err := newApp(c, client)
	if err != nil {
		return err
	}
	server := &http.Server{
		Addr:              c.addr,
		Handler:           a.handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	serverErrors := make(chan error, 1)
	go func() { serverErrors <- server.ListenAndServe() }()
	log.Printf("Eroded landing page listening on %s", c.addr)
	select {
	case err := <-serverErrors:
		return err
	case <-ctx.Done():
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return server.Shutdown(ctx)
	}
}

func main() {
	if err := run(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

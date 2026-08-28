package ws

import (
	"sync"
	"time"
)

// Limiter is a minimal fixed-window rate limiter (stdlib only).
// Suitable for P1/P5 minimal abuse protection without external deps.
type Limiter struct {
	mu      sync.Mutex
	windows map[string]*window
}

type window struct {
	count int
	start time.Time
}

// NewLimiter creates a Limiter.
func NewLimiter() *Limiter {
	return &Limiter{
		windows: make(map[string]*window),
	}
}

// Allow reports whether an event with key is allowed.
// limit is max events per dur. Fixed window: if now-start > dur, reset.
// Returns true if allowed, false if rate_limited.
func (l *Limiter) Allow(key string, limit int, dur time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	w, ok := l.windows[key]
	if !ok {
		l.windows[key] = &window{count: 1, start: now}
		return true
	}
	if now.Sub(w.start) > dur {
		w.start = now
		w.count = 1
		return true
	}
	if w.count >= limit {
		return false
	}
	w.count++
	return true
}

// Cleanup removes all windows for a connection when it closes.
// Keys are prefixed with perConn prefix; we delete any key containing connKey.
func (l *Limiter) CleanupConn(connKey string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for k := range l.windows {
		// perConn keys are like "<ptr>:send" or "<ptr>:create"
		if len(k) >= len(connKey) && k[:len(connKey)] == connKey {
			delete(l.windows, k)
		}
	}
}

// CleanupExpired removes IP windows older than 60s (lazy GC to avoid unbounded growth).
func (l *Limiter) CleanupExpired() {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	for k, w := range l.windows {
		if now.Sub(w.start) > 60*time.Second {
			delete(l.windows, k)
		}
	}
}

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
	now     func() time.Time
}

type window struct {
	count int
	start time.Time
	// dur is the window this key was created with, so GC can tell a 1-minute
	// counter from a 1-hour one instead of assuming a single expiry age.
	dur time.Duration
}

// NewLimiter creates a Limiter.
func NewLimiter() *Limiter {
	return NewLimiterWithNow(nil)
}

// NewLimiterWithNow creates a Limiter with a custom time source (for tests).
func NewLimiterWithNow(now func() time.Time) *Limiter {
	if now == nil {
		now = time.Now
	}
	return &Limiter{
		windows: make(map[string]*window),
		now:     now,
	}
}

// Allow reports whether an event with key is allowed.
// limit is max events per dur. Fixed window: if now-start > dur, reset.
// Returns true if allowed, false if rate_limited.
func (l *Limiter) Allow(key string, limit int, dur time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	w, ok := l.windows[key]
	if !ok {
		l.windows[key] = &window{count: 1, start: now, dur: dur}
		return true
	}
	if now.Sub(w.start) > dur {
		w.start = now
		w.count = 1
		w.dur = dur
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

// CleanupExpired drops windows that have run past their own duration. A single
// fixed age would be wrong here: the hourly per-IP create budget must survive
// far longer than the one-minute counters, and deleting it early silently
// restores that limit to roughly one-per-minute.
func (l *Limiter) CleanupExpired() {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	for k, w := range l.windows {
		if now.Sub(w.start) > w.dur {
			delete(l.windows, k)
		}
	}
}

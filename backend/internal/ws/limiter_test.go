package ws

import (
	"testing"
	"time"
)

func TestLimiterAllow(t *testing.T) {
	l := NewLimiter()
	key := "test:send"
	// 10/s
	for i := 0; i < 10; i++ {
		if !l.Allow(key, 10, time.Second) {
			t.Fatalf("expected allow at %d", i)
		}
	}
	if l.Allow(key, 10, time.Second) {
		t.Fatal("expected rate_limited at 11")
	}
}

func TestLimiterWindowReset(t *testing.T) {
	l := NewLimiter()
	key := "test:window"
	if !l.Allow(key, 2, 50*time.Millisecond) {
		t.Fatal("first")
	}
	if !l.Allow(key, 2, 50*time.Millisecond) {
		t.Fatal("second")
	}
	if l.Allow(key, 2, 50*time.Millisecond) {
		t.Fatal("third should be limited")
	}
	time.Sleep(60 * time.Millisecond)
	if !l.Allow(key, 2, 50*time.Millisecond) {
		t.Fatal("after window should allow")
	}
}

// TestLimiterCleanupRespectsWindowDuration pins the fix for CleanupExpired
// assuming every window was one minute old. That silently reset the hourly
// per-IP create budget roughly every minute, degrading 20/hour into ~20/minute.
func TestLimiterCleanupRespectsWindowDuration(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	now := base
	l := NewLimiterWithNow(func() time.Time { return now })

	for i := 0; i < 20; i++ {
		if !l.Allow("1.2.3.4:createHour", 20, time.Hour) {
			t.Fatalf("hourly budget should still allow at %d", i)
		}
	}
	if l.Allow("1.2.3.4:createHour", 20, time.Hour) {
		t.Fatal("21st create within the hour should be refused")
	}
	l.Allow("1.2.3.4:create", 5, time.Minute)

	// 90s on: past the minute window's own age, deep inside the hourly one.
	now = base.Add(90 * time.Second)
	l.CleanupExpired()

	if got := len(l.windows); got != 1 {
		t.Fatalf("expected the minute window collected and the hourly one kept, %d left", got)
	}
	if l.Allow("1.2.3.4:createHour", 20, time.Hour) {
		t.Fatal("hourly create budget survived collection but lost its count")
	}

	// the hourly window must still be collectable eventually, or GC never helps
	now = base.Add(61 * time.Minute)
	l.CleanupExpired()
	if got := len(l.windows); got != 0 {
		t.Fatalf("expected full collection after 61m, %d left", got)
	}
}

func TestLimiterCleanupConn(t *testing.T) {
	l := NewLimiter()
	l.Allow("conn1:send", 10, time.Second)
	l.Allow("conn1:create", 5, time.Minute)
	l.Allow("conn2:send", 10, time.Second)
	l.CleanupConn("conn1")
	if l.Allow("conn1:send", 10, time.Second) {
		// after cleanup, first should allow again (not counted as 11)
	} else {
		t.Fatal("cleanup should reset")
	}
	// conn2 should still be limited if we fill it
	for i := 0; i < 9; i++ {
		l.Allow("conn2:send", 10, time.Second)
	}
	if l.Allow("conn2:send", 10, time.Second) {
		t.Fatal("conn2 should still be limited")
	}
}

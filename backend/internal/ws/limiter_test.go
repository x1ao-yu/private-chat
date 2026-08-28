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

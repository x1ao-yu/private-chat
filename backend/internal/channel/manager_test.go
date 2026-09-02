package channel

import (
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestExpireEmptyTTL(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	now := base
	m := NewWithNow(func() time.Time { return now })

	m.Create("empty1")
	if !m.Exists("empty1") {
		t.Fatal("should exist after create")
	}
	// 9m: not expired
	now = base.Add(9 * time.Minute)
	if expired := m.Expire(now); len(expired) != 0 {
		t.Fatalf("should not expire at 9m, got %v", expired)
	}
	if !m.Exists("empty1") {
		t.Fatal("should still exist at 9m")
	}
	// 11m: expired
	now = base.Add(11 * time.Minute)
	expired := m.Expire(now)
	if len(expired) != 1 || expired[0] != "empty1" {
		t.Fatalf("should expire at 11m, got %v", expired)
	}
	if m.Exists("empty1") {
		t.Fatal("should be gone after expire")
	}
}

func TestExpireIdleTTL(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	now := base
	m := NewWithNow(func() time.Time { return now })

	// simulate a channel with a member (use nil conn as placeholder - allowed for map key)
	var conn websocket.Conn
	m.Join("active1", &conn, "peer-1")
	// 23h: not expired even though not empty, because idle TTL is 24h
	now = base.Add(23 * time.Hour)
	if expired := m.Expire(now); len(expired) != 0 {
		t.Fatalf("should not expire at 23h, got %v", expired)
	}
	if !m.Exists("active1") {
		t.Fatal("should still exist at 23h")
	}
	// 25h: expired (idle >24h)
	now = base.Add(25 * time.Hour)
	expired := m.Expire(now)
	if len(expired) != 1 || expired[0] != "active1" {
		t.Fatalf("should expire at 25h, got %v", expired)
	}
	if m.Exists("active1") {
		t.Fatal("should be gone after idle expire")
	}
	// reverse index cleaned: LeaveAll should not panic
	m.LeaveAll(&conn)
}

func TestJoinRefreshesTTL(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	now := base
	m := NewWithNow(func() time.Time { return now })
	m.Create("refresh1")
	// 9m later, join
	now = base.Add(9 * time.Minute)
	var conn websocket.Conn
	m.Join("refresh1", &conn, "peer-1")
	// 15m from start (6m since join): empty would have expired but now has member and refreshed
	now = base.Add(15 * time.Minute)
	if expired := m.Expire(now); len(expired) != 0 {
		t.Fatalf("should not expire after join refresh, got %v", expired)
	}
	if m.Count("refresh1") != 1 {
		t.Fatalf("expected count 1, got %d", m.Count("refresh1"))
	}
	// 35h from start (26h since join): should idle-expire
	now = base.Add(35 * time.Hour)
	expired := m.Expire(now)
	if len(expired) != 1 {
		t.Fatalf("should idle-expire, got %v", expired)
	}
}

func TestTouchRefreshesTTL(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	now := base
	m := NewWithNow(func() time.Time { return now })
	m.Create("touch1")
	now = base.Add(9 * time.Minute)
	m.Touch("touch1")
	// 15m: should not expire because touch at 9m
	now = base.Add(15 * time.Minute)
	if expired := m.Expire(now); len(expired) != 0 {
		t.Fatalf("touch should refresh, got %v", expired)
	}
	// 20m: 11m since touch -> empty expire
	now = base.Add(20 * time.Minute)
	expired := m.Expire(now)
	if len(expired) != 1 || expired[0] != "touch1" {
		t.Fatalf("should expire 11m after touch, got %v", expired)
	}
}

func TestExpireCleansMultiple(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	now := base
	m := NewWithNow(func() time.Time { return now })
	m.Create("a")
	m.Create("b")
	m.Create("c")
	now = base.Add(11 * time.Minute)
	expired := m.Expire(now)
	if len(expired) != 3 {
		t.Fatalf("expected 3 expired, got %v", expired)
	}
}

func TestExpireDoesNotAffectFresh(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	now := base
	m := NewWithNow(func() time.Time { return now })
	m.Create("old")
	now = base.Add(5 * time.Minute)
	m.Create("new")
	now = base.Add(11 * time.Minute)
	expired := m.Expire(now)
	if len(expired) != 1 || expired[0] != "old" {
		t.Fatalf("only old should expire, got %v", expired)
	}
	if !m.Exists("new") {
		t.Fatal("new should still exist")
	}
}

func TestLeaveKeepsEmptyChannel(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	now := base
	m := NewWithNow(func() time.Time { return now })
	var conn websocket.Conn
	m.Create("keep1")
	m.Join("keep1", &conn, "peer-1")
	m.Leave("keep1", &conn)
	if !m.Exists("keep1") {
		t.Fatal("channel should survive last member leaving (rejoin window)")
	}
	if m.Count("keep1") != 0 {
		t.Fatalf("expected count 0, got %d", m.Count("keep1"))
	}
	// empty channel is cleaned only by the EmptyTTL sweep
	now = base.Add(11 * time.Minute)
	expired := m.Expire(now)
	if len(expired) != 1 || expired[0] != "keep1" {
		t.Fatalf("sweep should expire empty channel at 11m, got %v", expired)
	}
	if m.Exists("keep1") {
		t.Fatal("should be gone after sweep")
	}
}

func TestLeaveAllKeepsEmptyChannel(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	now := base
	m := NewWithNow(func() time.Time { return now })
	var c1, c2 websocket.Conn
	m.Create("keep2")
	m.Join("keep2", &c1, "peer-1")
	m.Join("keep2", &c2, "peer-2")
	m.LeaveAll(&c1)
	m.LeaveAll(&c2)
	if !m.Exists("keep2") {
		t.Fatal("channel should survive all members disconnecting")
	}
	if m.Count("keep2") != 0 {
		t.Fatalf("expected count 0, got %d", m.Count("keep2"))
	}
	now = base.Add(11 * time.Minute)
	if expired := m.Expire(now); len(expired) != 1 {
		t.Fatalf("sweep should expire, got %v", expired)
	}
}

func TestRejoinAfterLeave(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	now := base
	m := NewWithNow(func() time.Time { return now })
	var c1, c2 websocket.Conn
	m.Create("rejoin1")
	m.Join("rejoin1", &c1, "peer-1")
	m.Leave("rejoin1", &c1)
	// a new connection joins within the EmptyTTL window -> channel resurrects
	m.Join("rejoin1", &c2, "peer-2")
	if m.Count("rejoin1") != 1 {
		t.Fatalf("expected count 1 after rejoin, got %d", m.Count("rejoin1"))
	}
}

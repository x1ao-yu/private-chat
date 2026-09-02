package channel

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// TTLs for P4 Privacy: empty rooms 10min, idle rooms 24h.
const (
	EmptyTTL = 10 * time.Minute
	IdleTTL  = 24 * time.Hour
)

type channelInfo struct {
	conns      map[*websocket.Conn]string
	createdAt  time.Time
	lastActive time.Time
}

// Manager keeps in-memory channel -> connections mapping.
// No persistence, purely in-memory (SECURITY.md: minimize storage).
// Single-instance only: restart drops all state. No disk, no DB.
type Manager struct {
	mu       sync.RWMutex
	channels map[string]*channelInfo
	// reverse index: conn -> set of channelIds (for cleanup)
	connChannels map[*websocket.Conn]map[string]struct{}
	now          func() time.Time
}

func New() *Manager {
	return NewWithNow(nil)
}

// NewWithNow creates a Manager with a custom time source (for tests).
func NewWithNow(now func() time.Time) *Manager {
	if now == nil {
		now = time.Now
	}
	return &Manager{
		channels:     make(map[string]*channelInfo),
		connChannels: make(map[*websocket.Conn]map[string]struct{}),
		now:          now,
	}
}

// GenerateID creates a random channel id (8 bytes hex, 16 chars)
func GenerateID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Create creates an empty channel (no members) for P3 Create semantics.
// Empty channels expire after EmptyTTL (10m); all channels expire after IdleTTL (24h) without activity.
func (m *Manager) Create(channelID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.channels[channelID]; !ok {
		now := m.now()
		m.channels[channelID] = &channelInfo{
			conns:      make(map[*websocket.Conn]string),
			createdAt:  now,
			lastActive: now,
		}
	}
}

// Join adds conn to channel with clientID.
func (m *Manager) Join(channelID string, conn *websocket.Conn, clientID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	info, ok := m.channels[channelID]
	if !ok {
		now := m.now()
		info = &channelInfo{
			conns:      make(map[*websocket.Conn]string),
			createdAt:  now,
			lastActive: now,
		}
		m.channels[channelID] = info
	}
	info.conns[conn] = clientID
	info.lastActive = m.now()
	if _, ok := m.connChannels[conn]; !ok {
		m.connChannels[conn] = make(map[string]struct{})
	}
	m.connChannels[conn][channelID] = struct{}{}
}

// Touch updates lastActive for a channel (e.g., on send_message).
func (m *Manager) Touch(channelID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if info, ok := m.channels[channelID]; ok {
		info.lastActive = m.now()
	}
}

// Leave removes conn from channel. The channel is kept even with 0 members;
// expiry is solely the sweep's job (EmptyTTL 10m) so transient disconnects
// (e.g. client reconnect) can rejoin instead of hitting a deleted channel.
func (m *Manager) Leave(channelID string, conn *websocket.Conn) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if info, ok := m.channels[channelID]; ok {
		delete(info.conns, conn)
	}
	if chans, ok := m.connChannels[conn]; ok {
		delete(chans, channelID)
		if len(chans) == 0 {
			delete(m.connChannels, conn)
		}
	}
}

// LeaveAll removes conn from all channels (on disconnect). Channels are kept
// even when emptied; expiry is solely the sweep's job (EmptyTTL 10m).
func (m *Manager) LeaveAll(conn *websocket.Conn) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	chans, ok := m.connChannels[conn]
	if !ok {
		return nil
	}
	var affected []string
	for ch := range chans {
		if info, ok := m.channels[ch]; ok {
			delete(info.conns, conn)
			affected = append(affected, ch)
		}
	}
	delete(m.connChannels, conn)
	return affected
}

// Count returns online count for channel.
func (m *Manager) Count(channelID string) int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if info, ok := m.channels[channelID]; ok {
		return len(info.conns)
	}
	return 0
}

// Snapshot returns a copy of conns for channel to broadcast without holding lock during Write.
func (m *Manager) Snapshot(channelID string) map[*websocket.Conn]string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	info, ok := m.channels[channelID]
	if !ok {
		return nil
	}
	cp := make(map[*websocket.Conn]string, len(info.conns))
	for c, id := range info.conns {
		cp[c] = id
	}
	return cp
}

// Expire removes channels that exceeded TTLs. Returns expired channelIds.
// - empty (0 members) after EmptyTTL (10m)
// - any channel after IdleTTL (24h) without activity (Join/Send/Touch)
func (m *Manager) Expire(now time.Time) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var expired []string
	for id, info := range m.channels {
		isEmpty := len(info.conns) == 0
		elapsed := now.Sub(info.lastActive)
		shouldExpire := false
		if isEmpty && elapsed > EmptyTTL {
			shouldExpire = true
		} else if elapsed > IdleTTL {
			shouldExpire = true
		}
		if shouldExpire {
			// clean reverse index
			for conn := range info.conns {
				if chans, ok := m.connChannels[conn]; ok {
					delete(chans, id)
					if len(chans) == 0 {
						delete(m.connChannels, conn)
					}
				}
			}
			delete(m.channels, id)
			expired = append(expired, id)
		}
	}
	return expired
}

// ExpireNow is a convenience for production ticker (uses m.now()).
func (m *Manager) ExpireNow() []string {
	return m.Expire(m.now())
}

// Exists reports whether channel exists.
func (m *Manager) Exists(channelID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.channels[channelID]
	return ok
}

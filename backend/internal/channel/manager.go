package channel

import (
	"crypto/rand"
	"encoding/hex"
	"sync"

	"github.com/coder/websocket"
)

// Manager keeps in-memory channel -> connections mapping.
// No persistence, purely in-memory (SECURITY.md: minimize storage).
type Manager struct {
	mu       sync.RWMutex
	channels map[string]map[*websocket.Conn]string // channelId -> conn -> clientID
	// reverse index: conn -> set of channelIds (for cleanup)
	connChannels map[*websocket.Conn]map[string]struct{}
}

func New() *Manager {
	return &Manager{
		channels:     make(map[string]map[*websocket.Conn]string),
		connChannels: make(map[*websocket.Conn]map[string]struct{}),
	}
}

// GenerateID creates a random channel id (8 bytes hex, 16 chars)
func GenerateID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Create creates an empty channel (no members) for P3 Create semantics.
// Empty channels persist until last member leaves; GC deferred to P4.
func (m *Manager) Create(channelID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.channels[channelID]; !ok {
		m.channels[channelID] = make(map[*websocket.Conn]string)
	}
}

// Join adds conn to channel with clientID.
func (m *Manager) Join(channelID string, conn *websocket.Conn, clientID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.channels[channelID]; !ok {
		m.channels[channelID] = make(map[*websocket.Conn]string)
	}
	m.channels[channelID][conn] = clientID
	if _, ok := m.connChannels[conn]; !ok {
		m.connChannels[conn] = make(map[string]struct{})
	}
	m.connChannels[conn][channelID] = struct{}{}
}

// Leave removes conn from channel.
func (m *Manager) Leave(channelID string, conn *websocket.Conn) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if conns, ok := m.channels[channelID]; ok {
		delete(conns, conn)
		if len(conns) == 0 {
			delete(m.channels, channelID)
		}
	}
	if chans, ok := m.connChannels[conn]; ok {
		delete(chans, channelID)
		if len(chans) == 0 {
			delete(m.connChannels, conn)
		}
	}
}

// LeaveAll removes conn from all channels (on disconnect).
func (m *Manager) LeaveAll(conn *websocket.Conn) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	chans, ok := m.connChannels[conn]
	if !ok {
		return nil
	}
	var affected []string
	for ch := range chans {
		if conns, ok := m.channels[ch]; ok {
			delete(conns, conn)
			affected = append(affected, ch)
			if len(conns) == 0 {
				delete(m.channels, ch)
			}
		}
	}
	delete(m.connChannels, conn)
	return affected
}

// Count returns online count for channel.
func (m *Manager) Count(channelID string) int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.channels[channelID])
}

// Snapshot returns a copy of conns for channel to broadcast without holding lock during Write.
func (m *Manager) Snapshot(channelID string) map[*websocket.Conn]string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	conns, ok := m.channels[channelID]
	if !ok {
		return nil
	}
	cp := make(map[*websocket.Conn]string, len(conns))
	for c, id := range conns {
		cp[c] = id
	}
	return cp
}

// Exists reports whether channel exists.
func (m *Manager) Exists(channelID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.channels[channelID]
	return ok
}

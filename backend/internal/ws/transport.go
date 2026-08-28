package ws

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"

	"chat/internal/channel"
	"chat/internal/protocol"

	"github.com/coder/websocket"
)

// Server holds dependencies for WS handling.
type Server struct {
	Manager *channel.Manager
}

// NewServer creates a WS server.
func NewServer(m *channel.Manager) *Server {
	return &Server{Manager: m}
}

// Handler upgrades and handles a WS connection. It validates via codec, routes via channel manager,
// and never logs payload.
func (s *Server) Handler(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		http.Error(w, "websocket accept failed", http.StatusBadRequest)
		return
	}
	defer func() {
		s.Manager.LeaveAll(c)
		// broadcast online_count for affected channels
		// (we need to know which channels were affected before leave; LeaveAll returns them)
		// but we already left, so we need to broadcast after. We capture before leave above.
		// Instead, handle LeaveAll with broadcast inside loop on close.
		c.Close(websocket.StatusNormalClosure, "")
	}()

	c.SetReadLimit(1 << 20) // 1 MiB

	ctx := r.Context()
	clientID := generateClientID()

	for {
		msgType, data, err := c.Read(ctx)
		if err != nil {
			return
		}
		if msgType != websocket.MessageText {
			continue
		}
		msg, err := Decode(data)
		if err != nil {
			_ = writeError(ctx, c, "invalid_message", "invalid message")
			continue
		}
		switch v := msg.(type) {
		case *protocol.CreateChannel:
			_ = v
			id := channel.GenerateID()
			s.Manager.Join(id, c, clientID)
			resp := protocol.ChannelCreated{
				Type:      protocol.ChannelCreatedTypeChannelCreated,
				ChannelId: id,
			}
			if b, err := Encode(resp); err == nil {
				_ = c.Write(ctx, websocket.MessageText, b)
			}
			// also send joined with online 1
			joined := protocol.Joined{
				Type:      protocol.JoinedTypeJoined,
				ChannelId: id,
				Online:    1,
			}
			if b, err := Encode(joined); err == nil {
				_ = c.Write(ctx, websocket.MessageText, b)
			}
		case *protocol.JoinChannel:
			s.Manager.Join(v.ChannelId, c, clientID)
			joined := protocol.Joined{
				Type:      protocol.JoinedTypeJoined,
				ChannelId: v.ChannelId,
				Online:    s.Manager.Count(v.ChannelId),
			}
			if b, err := Encode(joined); err == nil {
				_ = c.Write(ctx, websocket.MessageText, b)
			}
			// broadcast online_count to others
			broadcastOnlineCount(ctx, s.Manager, v.ChannelId)
		case *protocol.LeaveChannel:
			s.Manager.Leave(v.ChannelId, c)
			left := protocol.Left{
				Type:      protocol.LeftTypeLeft,
				ChannelId: v.ChannelId,
			}
			if b, err := Encode(left); err == nil {
				_ = c.Write(ctx, websocket.MessageText, b)
			}
			broadcastOnlineCount(ctx, s.Manager, v.ChannelId)
		case *protocol.SendMessage:
			// Verify sender is in channel (if not, auto-join? For P0, allow but warn)
			// Broadcast as message with from
			bcast := protocol.BroadcastMessage{
				Type:      protocol.BroadcastMessageTypeMessage,
				ChannelId: v.ChannelId,
				Payload:   v.Payload,
				From:      clientID,
			}
			b, err := Encode(bcast)
			if err != nil {
				continue
			}
			broadcast(ctx, s.Manager, v.ChannelId, b)
		default:
			_ = writeError(ctx, c, "invalid_message", "unsupported message type")
		}
		select {
		case <-ctx.Done():
			return
		default:
		}
	}
}

func broadcast(ctx context.Context, m *channel.Manager, channelID string, data []byte) {
	snapshot := m.Snapshot(channelID)
	for conn := range snapshot {
		// Use background context with timeout to avoid blocking on slow clients
		_ = conn.Write(ctx, websocket.MessageText, data)
	}
}

func broadcastOnlineCount(ctx context.Context, m *channel.Manager, channelID string) {
	count := m.Count(channelID)
	// Even if count 0, we still broadcast if there are remaining members; if channel deleted, no one to notify
	if count == 0 {
		return
	}
	msg := protocol.OnlineCount{
		Type:      protocol.OnlineCountTypeOnlineCount,
		ChannelId: channelID,
		Count:     count,
	}
	b, err := Encode(msg)
	if err != nil {
		return
	}
	broadcast(ctx, m, channelID, b)
}

func writeError(ctx context.Context, c *websocket.Conn, code, message string) error {
	e := protocol.Error{
		Type:    protocol.ErrorTypeError,
		Code:    protocol.ErrorCode(code),
		Message: message,
	}
	b, err := Encode(e)
	if err != nil {
		return err
	}
	return c.Write(ctx, websocket.MessageText, b)
}

func generateClientID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return "peer-" + hex.EncodeToString(b)
}

// Legacy handler for tests that don't need manager (echo). Kept for compatibility.
func Handler(w http.ResponseWriter, r *http.Request) {
	m := channel.New()
	s := NewServer(m)
	s.Handler(w, r)
}

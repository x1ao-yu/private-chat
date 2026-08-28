package ws

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"time"

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
// and never logs payload. Leave authority is WS lifecycle + native Ping/Pong heartbeat.
func (s *Server) Handler(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		http.Error(w, "websocket accept failed", http.StatusBadRequest)
		return
	}
	defer func() {
		affected := s.Manager.LeaveAll(c)
		for _, ch := range affected {
			broadcastOnlineCount(context.Background(), s.Manager, ch)
		}
		c.Close(websocket.StatusNormalClosure, "")
	}()

	c.SetReadLimit(1 << 20) // 1 MiB

	ctx := r.Context()
	clientID := generateClientID()

	// heartbeat via native Ping/Pong control frames (no JSON)
	pingCtx, pingCancel := context.WithCancel(context.Background())
	defer pingCancel()
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-pingCtx.Done():
				return
			case <-ticker.C:
				pCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				err := c.Ping(pCtx)
				cancel()
				if err != nil {
					_ = c.Close(websocket.StatusGoingAway, "heartbeat timeout")
					return
				}
			}
		}
	}()

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
			// collision guard (P1 hardening)
			for i := 0; i < 3 && s.Manager.Exists(id); i++ {
				id = channel.GenerateID()
			}
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
			if !s.Manager.Exists(v.ChannelId) {
				_ = writeError(ctx, c, "channel_not_found", "channel not found")
				continue
			}
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
			if !s.Manager.Exists(v.ChannelId) {
				_ = writeError(ctx, c, "channel_not_found", "channel not found")
				continue
			}
			if snap := s.Manager.Snapshot(v.ChannelId); snap == nil {
				_ = writeError(ctx, c, "channel_not_found", "channel not found")
				continue
			} else if _, ok := snap[c]; !ok {
				_ = writeError(ctx, c, "channel_not_found", "not a member")
				continue
			}
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
		cCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = conn.Write(cCtx, websocket.MessageText, data)
		cancel()
	}
	_ = ctx // keep signature compatible, heartbeat uses background
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

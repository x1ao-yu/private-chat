package ws

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"testing"
	"time"

	"chat/internal/channel"
	"chat/internal/protocol"

	"github.com/coder/websocket"
)

func newTestServer(t *testing.T) (string, func()) {
	t.Helper()
	m := channel.New()
	srv := NewServer(m)
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", srv.Handler)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	httpSrv := &http.Server{Handler: mux}
	go httpSrv.Serve(ln) //nolint:errcheck
	return "ws://" + ln.Addr().String() + "/ws", func() {
		httpSrv.Close()
		ln.Close()
	}
}

func TestCreateChannel(t *testing.T) {
	url, closeFn := newTestServer(t)
	defer closeFn()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	if err := c.Write(ctx, websocket.MessageText, []byte(`{"type":"create_channel"}`)); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read channel_created: %v", err)
	}
	var msg map[string]interface{}
	if err := json.Unmarshal(data, &msg); err != nil {
		t.Fatal(err)
	}
	if msg["type"] != "channel_created" {
		t.Fatalf("expected channel_created got %v", msg)
	}
	chID := msg["channelId"].(string)
	if chID == "" {
		t.Fatal("missing channelId")
	}
	// Create is empty - need explicit join to become member
	joinB, _ := json.Marshal(map[string]string{"type": "join_channel", "channelId": chID})
	if err := c.Write(ctx, websocket.MessageText, joinB); err != nil {
		t.Fatalf("join write: %v", err)
	}
	_, data, err = c.Read(ctx)
	if err != nil {
		t.Fatalf("read joined: %v", err)
	}
	var joined protocol.Joined
	if err := json.Unmarshal(data, &joined); err != nil {
		t.Fatalf("joined unmarshal: %v", err)
	}
	if joined.Type != protocol.JoinedTypeJoined || joined.Online != 1 {
		t.Fatalf("unexpected joined: %+v", joined)
	}
}

func TestJoinAndBroadcast(t *testing.T) {
	url, closeFn := newTestServer(t)
	defer closeFn()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	c1, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial c1: %v", err)
	}
	defer c1.Close(websocket.StatusNormalClosure, "")
	c2, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial c2: %v", err)
	}
	defer c2.Close(websocket.StatusNormalClosure, "")

	// c1 creates channel (empty)
	if err := c1.Write(ctx, websocket.MessageText, []byte(`{"type":"create_channel"}`)); err != nil {
		t.Fatal(err)
	}
	_, data, _ := c1.Read(ctx) // channel_created
	var cc protocol.ChannelCreated
	_ = json.Unmarshal(data, &cc)
	chID := cc.ChannelId

	// c1 joins its own channel
	join1, _ := json.Marshal(map[string]string{"type": "join_channel", "channelId": chID})
	if err := c1.Write(ctx, websocket.MessageText, join1); err != nil {
		t.Fatal(err)
	}
	_, data, _ = c1.Read(ctx) // joined 1
	_, data, _ = c1.Read(ctx) // online_count 1
	var oc1 protocol.OnlineCount
	_ = json.Unmarshal(data, &oc1)

	// c2 joins same channel
	joinMsg, _ := json.Marshal(map[string]string{"type": "join_channel", "channelId": chID})
	if err := c2.Write(ctx, websocket.MessageText, joinMsg); err != nil {
		t.Fatal(err)
	}
	_, data, err = c2.Read(ctx)
	if err != nil {
		t.Fatalf("c2 read joined: %v", err)
	}
	var joined protocol.Joined
	_ = json.Unmarshal(data, &joined)
	if joined.Online != 2 {
		t.Fatalf("expected online 2 got %d", joined.Online)
	}
	// c2 also receives online_count broadcast (joined triggers broadcast to all)
	_, data, err = c2.Read(ctx)
	if err != nil {
		t.Fatalf("c2 read online_count: %v", err)
	}
	var oc2 protocol.OnlineCount
	if err := json.Unmarshal(data, &oc2); err != nil || oc2.Count != 2 {
		t.Fatalf("expected c2 online_count 2 got %v err %v", oc2, err)
	}
	// c1 should receive online_count broadcast
	_, data, err = c1.Read(ctx)
	if err != nil {
		t.Fatalf("c1 read online_count: %v", err)
	}
	var oc protocol.OnlineCount
	if err := json.Unmarshal(data, &oc); err != nil || oc.Count != 2 {
		t.Fatalf("expected online_count 2 got %v err %v", oc, err)
	}

	// c1 sends message
	send := map[string]string{"type": "send_message", "channelId": chID, "payload": "hello"}
	b, _ := json.Marshal(send)
	if err := c1.Write(ctx, websocket.MessageText, b); err != nil {
		t.Fatal(err)
	}
	// both should receive broadcast
	_, data, err = c1.Read(ctx)
	if err != nil {
		t.Fatalf("c1 read broadcast: %v", err)
	}
	var bm1 protocol.BroadcastMessage
	_ = json.Unmarshal(data, &bm1)
	if bm1.Payload != "hello" || bm1.ChannelId != chID {
		t.Fatalf("c1 broadcast mismatch: %+v", bm1)
	}
	_, data, err = c2.Read(ctx)
	if err != nil {
		t.Fatalf("c2 read broadcast: %v", err)
	}
	var bm2 protocol.BroadcastMessage
	_ = json.Unmarshal(data, &bm2)
	if bm2.Payload != "hello" {
		t.Fatalf("c2 payload mismatch")
	}
	// from should be set and not empty, and should be same for both?
	if bm1.From == "" || bm2.From == "" {
		t.Fatal("from missing")
	}
}

func TestDisconnectBroadcastsOnlineCount(t *testing.T) {
	url, closeFn := newTestServer(t)
	defer closeFn()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	c1, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial c1: %v", err)
	}
	defer c1.Close(websocket.StatusNormalClosure, "")
	c2, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial c2: %v", err)
	}

	// c1 creates (empty)
	if err := c1.Write(ctx, websocket.MessageText, []byte(`{"type":"create_channel"}`)); err != nil {
		t.Fatal(err)
	}
	_, data, _ := c1.Read(ctx)
	var cc protocol.ChannelCreated
	_ = json.Unmarshal(data, &cc)
	chID := cc.ChannelId
	// c1 joins its own channel
	join1, _ := json.Marshal(map[string]string{"type": "join_channel", "channelId": chID})
	if err := c1.Write(ctx, websocket.MessageText, join1); err != nil {
		t.Fatal(err)
	}
	_, _, _ = c1.Read(ctx) // joined 1
	_, _, _ = c1.Read(ctx) // online_count 1

	// c2 joins
	joinMsg, _ := json.Marshal(map[string]string{"type": "join_channel", "channelId": chID})
	if err := c2.Write(ctx, websocket.MessageText, joinMsg); err != nil {
		t.Fatal(err)
	}
	_, _, _ = c2.Read(ctx) // joined 2
	_, _, _ = c2.Read(ctx) // online_count 2
	_, _, _ = c1.Read(ctx) // online_count 2

	// c2 disconnects (should trigger LeaveAll + broadcast)
	_ = c2.Close(websocket.StatusNormalClosure, "")
	// c1 should receive online_count 1
	ctx2, cancel2 := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel2()
	_, data, err = c1.Read(ctx2)
	if err != nil {
		t.Fatalf("c1 read after c2 disconnect: %v", err)
	}
	var oc protocol.OnlineCount
	if err := json.Unmarshal(data, &oc); err != nil {
		t.Fatalf("online_count unmarshal: %v data %s", err, string(data))
	}
	if oc.Count != 1 || oc.ChannelId != chID {
		t.Fatalf("expected count 1 got %+v", oc)
	}
}

func TestJoinNonExistent(t *testing.T) {
	url, closeFn := newTestServer(t)
	defer closeFn()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	if err := c.Write(ctx, websocket.MessageText, []byte(`{"type":"join_channel","channelId":"nonexistent123"}`)); err != nil {
		t.Fatal(err)
	}
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read error: %v", err)
	}
	var e protocol.Error
	if err := json.Unmarshal(data, &e); err != nil {
		t.Fatalf("error unmarshal: %v", err)
	}
	if e.Code != protocol.ErrorCodeChannelNotFound {
		t.Fatalf("expected channel_not_found got %v", e.Code)
	}
}

func TestSendWithoutJoin(t *testing.T) {
	url, closeFn := newTestServer(t)
	defer closeFn()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c1, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c1.Close(websocket.StatusNormalClosure, "")
	c2, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.Close(websocket.StatusNormalClosure, "")

	// c1 creates channel (empty) and joins
	if err := c1.Write(ctx, websocket.MessageText, []byte(`{"type":"create_channel"}`)); err != nil {
		t.Fatal(err)
	}
	_, data, _ := c1.Read(ctx)
	var cc protocol.ChannelCreated
	_ = json.Unmarshal(data, &cc)
	chID := cc.ChannelId
	join1, _ := json.Marshal(map[string]string{"type": "join_channel", "channelId": chID})
	if err := c1.Write(ctx, websocket.MessageText, join1); err != nil {
		t.Fatal(err)
	}
	_, _, _ = c1.Read(ctx) // joined
	_, _, _ = c1.Read(ctx) // online_count

	// c2 tries to send without joining
	send := map[string]string{"type": "send_message", "channelId": chID, "payload": "hello"}
	b, _ := json.Marshal(send)
	if err := c2.Write(ctx, websocket.MessageText, b); err != nil {
		t.Fatal(err)
	}
	_, data, err = c2.Read(ctx)
	if err != nil {
		t.Fatalf("read error: %v", err)
	}
	var e protocol.Error
	if err := json.Unmarshal(data, &e); err != nil {
		t.Fatalf("error unmarshal: %v", err)
	}
	if e.Code != protocol.ErrorCodeChannelNotFound {
		t.Fatalf("expected channel_not_found for send without join, got %v", e.Code)
	}
}

func TestSendToNonExistent(t *testing.T) {
	url, closeFn := newTestServer(t)
	defer closeFn()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	b, _ := json.Marshal(map[string]string{"type": "send_message", "channelId": "ghost12345", "payload": "hi"})
	if err := c.Write(ctx, websocket.MessageText, b); err != nil {
		t.Fatal(err)
	}
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var e protocol.Error
	_ = json.Unmarshal(data, &e)
	if e.Code != protocol.ErrorCodeChannelNotFound {
		t.Fatalf("expected channel_not_found, got %v", e.Code)
	}
}

func TestCreateRateLimited(t *testing.T) {
	url, closeFn := newTestServer(t)
	defer closeFn()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	// 5 creates should succeed (per-conn 5/min + per-IP 5/min)
	for i := 0; i < 5; i++ {
		if err := c.Write(ctx, websocket.MessageText, []byte(`{"type":"create_channel"}`)); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
		_, _, _ = c.Read(ctx) // channel_created (empty, no joined)
	}
	// 6th should be rate_limited
	if err := c.Write(ctx, websocket.MessageText, []byte(`{"type":"create_channel"}`)); err != nil {
		t.Fatal(err)
	}
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read rate_limited: %v", err)
	}
	var e protocol.Error
	_ = json.Unmarshal(data, &e)
	if e.Code != protocol.ErrorCodeRateLimited {
		t.Fatalf("expected rate_limited, got %v", e.Code)
	}
}

func TestSendRateLimited(t *testing.T) {
	url, closeFn := newTestServer(t)
	defer closeFn()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	// create channel (empty)
	if err := c.Write(ctx, websocket.MessageText, []byte(`{"type":"create_channel"}`)); err != nil {
		t.Fatal(err)
	}
	_, data, _ := c.Read(ctx)
	var cc protocol.ChannelCreated
	_ = json.Unmarshal(data, &cc)
	chID := cc.ChannelId
	// join to become member
	joinB, _ := json.Marshal(map[string]string{"type": "join_channel", "channelId": chID})
	if err := c.Write(ctx, websocket.MessageText, joinB); err != nil {
		t.Fatal(err)
	}
	_, _, _ = c.Read(ctx) // joined
	_, _, _ = c.Read(ctx) // online_count

	// send 10 messages should succeed (per-conn 10/s)
	for i := 0; i < 10; i++ {
		b, _ := json.Marshal(map[string]string{"type": "send_message", "channelId": chID, "payload": "hi"})
		if err := c.Write(ctx, websocket.MessageText, b); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
		_, _, _ = c.Read(ctx) // broadcast
	}
	// 11th should be rate_limited
	b, _ := json.Marshal(map[string]string{"type": "send_message", "channelId": chID, "payload": "hi"})
	if err := c.Write(ctx, websocket.MessageText, b); err != nil {
		t.Fatal(err)
	}
	_, data, err = c.Read(ctx)
	if err != nil {
		t.Fatalf("read rate_limited: %v", err)
	}
	var e protocol.Error
	_ = json.Unmarshal(data, &e)
	if e.Code != protocol.ErrorCodeRateLimited {
		t.Fatalf("expected rate_limited, got %v", e.Code)
	}
}

func TestInvalidMessage(t *testing.T) {
	url, closeFn := newTestServer(t)
	defer closeFn()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	if err := c.Write(ctx, websocket.MessageText, []byte(`{"type":"unknown"}`)); err != nil {
		t.Fatal(err)
	}
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read error: %v", err)
	}
	var e protocol.Error
	if err := json.Unmarshal(data, &e); err != nil {
		t.Fatalf("error unmarshal: %v", err)
	}
	if e.Code != protocol.ErrorCodeInvalidMessage {
		t.Fatalf("expected invalid_message code got %v", e.Code)
	}
}

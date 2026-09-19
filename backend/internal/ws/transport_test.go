package ws

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"chat/internal/channel"
	"chat/internal/protocol"

	"github.com/coder/websocket"
)

func newTestServer(t *testing.T) (string, func()) {
	t.Helper()
	return newTestServerWithXFF(t, false)
}

func newTestServerWithXFF(t *testing.T, trustXFF bool) (string, func()) {
	t.Helper()
	m := channel.New()
	srv := NewServer(m)
	srv.trustXFF = trustXFF
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

// createOnce dials with the given X-Forwarded-For and attempts one create_channel,
// reporting whether the server accepted it.
func createOnce(t *testing.T, url, xff string) bool {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	h := http.Header{}
	if xff != "" {
		h.Set("X-Forwarded-For", xff)
	}
	c, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: h})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "")
	if err := c.Write(ctx, websocket.MessageText, []byte(`{"type":"create_channel"}`)); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	// a local struct, not protocol.Error: the generated types enforce required
	// fields, so unmarshalling a successful channel_created into them fails
	var msg struct {
		Type string `json:"type"`
		Code string `json:"code"`
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		t.Fatalf("unmarshal: %v data %s", err, data)
	}
	return msg.Type != "error" || msg.Code != "rate_limited"
}

// TestCreateRateLimitPerClientIP pins that the limiter buckets by the real client
// address rather than the proxy's. Five creates exhaust one IP's per-minute
// budget; a second connection from that same IP must be refused, while a
// different client IP is unaffected.
func TestCreateRateLimitPerClientIP(t *testing.T) {
	url, closeFn := newTestServerWithXFF(t, true)
	defer closeFn()

	for i := 0; i < 5; i++ {
		if !createOnce(t, url, "203.0.113.1") {
			t.Fatalf("create %d should be allowed within the 5/min budget", i+1)
		}
	}
	if createOnce(t, url, "203.0.113.1") {
		t.Fatal("6th create from the same client IP should be rate limited")
	}
	// a distinct client IP gets its own budget even though the peer address is shared
	if !createOnce(t, url, "203.0.113.2") {
		t.Fatal("a different client IP must not inherit the exhausted budget")
	}
	// only the right-most entry counts, so prepending cannot buy a fresh bucket
	if createOnce(t, url, "198.51.100.77, 203.0.113.1") {
		t.Fatal("prepending a novel XFF hop must not escape the bucket of the real client")
	}
}

// TestCreateRateLimitIgnoresXFFWhenNotTrusted pins the safe default: with
// TRUST_PROXY_XFF unset a directly reachable backend must key on the peer
// address, so spoofing X-Forwarded-For buys no extra budget.
func TestCreateRateLimitIgnoresXFFWhenNotTrusted(t *testing.T) {
	url, closeFn := newTestServer(t)
	defer closeFn()

	for i := 0; i < 5; i++ {
		if !createOnce(t, url, "") {
			t.Fatalf("create %d should be allowed within the 5/min budget", i+1)
		}
	}
	// same peer address, forged header: still the same bucket
	if createOnce(t, url, "198.51.100.99") {
		t.Fatal("forged X-Forwarded-For must not bypass the limit when the proxy is not trusted")
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
		t.Fatalf("dial: %v", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	if err := c.Write(ctx, websocket.MessageText, []byte(`{"type":"unknown"}`)); err != nil {
		t.Fatalf("write: %v", err)
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

// createAndJoinTwo creates a channel and joins it from two connections.
// All join handshakes are drained so callers read only post-join traffic.
func createAndJoinTwo(t *testing.T, url string) (context.Context, *websocket.Conn, *websocket.Conn, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	c1, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial c1: %v", err)
	}
	t.Cleanup(func() { c1.Close(websocket.StatusNormalClosure, "") })
	c2, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial c2: %v", err)
	}
	t.Cleanup(func() { c2.Close(websocket.StatusNormalClosure, "") })

	if err := c1.Write(ctx, websocket.MessageText, []byte(`{"type":"create_channel"}`)); err != nil {
		t.Fatalf("write create: %v", err)
	}
	_, data, err := c1.Read(ctx)
	if err != nil {
		t.Fatalf("read channel_created: %v", err)
	}
	var cc protocol.ChannelCreated
	_ = json.Unmarshal(data, &cc)
	chID := cc.ChannelId

	if err := writeJSON(ctx, c1, map[string]string{"type": "join_channel", "channelId": chID}); err != nil {
		t.Fatalf("write join1: %v", err)
	}
	_, _, _ = c1.Read(ctx) // joined 1
	_, _, _ = c1.Read(ctx) // online_count 1

	if err := writeJSON(ctx, c2, map[string]string{"type": "join_channel", "channelId": chID}); err != nil {
		t.Fatalf("write join2: %v", err)
	}
	_, _, _ = c2.Read(ctx) // joined 2
	_, _, _ = c2.Read(ctx) // online_count 2 (broadcast)
	_, _, _ = c1.Read(ctx) // online_count 2 (broadcast)
	return ctx, c1, c2, chID
}

func writeJSON(ctx context.Context, c *websocket.Conn, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.Write(ctx, websocket.MessageText, b)
}

// relayFrame mirrors the wire shape of key_updated/room_name_updated/nickname_updated.
type relayFrame struct {
	Type      string `json:"type"`
	ChannelId string `json:"channelId"`
	Payload   string `json:"payload"`
	From      string `json:"from"`
	Self      *bool  `json:"self"`
}

// assertRelayed reads one broadcast frame on each connection and checks verbatim
// relay with per-recipient self flag (true for the sender, false for the other).
func assertRelayed(t *testing.T, ctx context.Context, wantType, chID, payload string, sender, other *websocket.Conn) {
	t.Helper()
	for i, c := range []*websocket.Conn{sender, other} {
		_, data, err := c.Read(ctx)
		if err != nil {
			t.Fatalf("%s conn %d read: %v", wantType, i, err)
		}
		var m relayFrame
		if err := json.Unmarshal(data, &m); err != nil {
			t.Fatalf("%s conn %d unmarshal: %v", wantType, i, err)
		}
		if m.Type != wantType || m.ChannelId != chID || m.Payload != payload {
			t.Fatalf("%s conn %d unexpected relay: %+v", wantType, i, m)
		}
		if m.From == "" {
			t.Fatalf("%s conn %d missing from", wantType, i)
		}
		wantSelf := i == 0
		if m.Self == nil || *m.Self != wantSelf {
			t.Fatalf("%s conn %d expected self=%v got %v", wantType, i, wantSelf, m.Self)
		}
	}
}

func TestKeyUpdateRelay(t *testing.T) {
	url, closeFn := newTestServer(t)
	defer closeFn()
	ctx, c1, c2, chID := createAndJoinTwo(t, url)

	payload := "AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.CCCCCCCCCCCCCCCCCCCCCCCCCCCC"
	if err := writeJSON(ctx, c1, map[string]string{"type": "key_update", "channelId": chID, "payload": payload}); err != nil {
		t.Fatalf("write key_update: %v", err)
	}
	assertRelayed(t, ctx, "key_updated", chID, payload, c1, c2)
}

func TestSetRoomNameAndNicknameRelay(t *testing.T) {
	url, closeFn := newTestServer(t)
	defer closeFn()
	ctx, c1, c2, chID := createAndJoinTwo(t, url)

	cases := []struct{ sendType, wantType string }{
		{"set_room_name", "room_name_updated"},
		{"set_nickname", "nickname_updated"},
	}
	for _, tc := range cases {
		payload := "DDDDDDDDDDDDDDDDDDDDDD.EEEEEEEEEEEEEEEEEEEEEE.FFFFFFFFFFFFFFFFFFFFFFFFFFFF"
		if err := writeJSON(ctx, c1, map[string]string{"type": tc.sendType, "channelId": chID, "payload": payload}); err != nil {
			t.Fatalf("write %s: %v", tc.sendType, err)
		}
		assertRelayed(t, ctx, tc.wantType, chID, payload, c1, c2)
	}
}

func TestKeyUpdateWithoutJoin(t *testing.T) {
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

	// c1 creates channel and joins so it exists
	if err := c1.Write(ctx, websocket.MessageText, []byte(`{"type":"create_channel"}`)); err != nil {
		t.Fatalf("write create: %v", err)
	}
	_, data, _ := c1.Read(ctx)
	var cc protocol.ChannelCreated
	_ = json.Unmarshal(data, &cc)
	chID := cc.ChannelId
	if err := writeJSON(ctx, c1, map[string]string{"type": "join_channel", "channelId": chID}); err != nil {
		t.Fatalf("write join1: %v", err)
	}
	_, _, _ = c1.Read(ctx) // joined
	_, _, _ = c1.Read(ctx) // online_count

	// c2 sends key_update without joining
	if err := writeJSON(ctx, c2, map[string]string{"type": "key_update", "channelId": chID, "payload": "x.y.z"}); err != nil {
		t.Fatalf("write key_update: %v", err)
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
		t.Fatalf("expected channel_not_found for key_update without join, got %v", e.Code)
	}
}

// TestRejoinAfterLeave is the protocol-level regression for the self-destruct
// bug: a room must survive its last member leaving (EmptyTTL window) so a
// reconnecting/rejoining client gets `joined`, not channel_not_found.
func TestRejoinAfterLeave(t *testing.T) {
	url, closeFn := newTestServer(t)
	defer closeFn()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c1, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial c1: %v", err)
	}
	defer c1.Close(websocket.StatusNormalClosure, "")

	// create + join
	if err := c1.Write(ctx, websocket.MessageText, []byte(`{"type":"create_channel"}`)); err != nil {
		t.Fatalf("write create: %v", err)
	}
	_, data, _ := c1.Read(ctx)
	var cc protocol.ChannelCreated
	_ = json.Unmarshal(data, &cc)
	chID := cc.ChannelId
	if err := writeJSON(ctx, c1, map[string]string{"type": "join_channel", "channelId": chID}); err != nil {
		t.Fatalf("write join1: %v", err)
	}
	_, _, _ = c1.Read(ctx) // joined
	_, _, _ = c1.Read(ctx) // online_count

	// last member leaves the channel (WS stays open)
	if err := writeJSON(ctx, c1, map[string]string{"type": "leave_channel", "channelId": chID}); err != nil {
		t.Fatalf("write leave: %v", err)
	}
	_, data, err = c1.Read(ctx)
	if err != nil {
		t.Fatalf("read left: %v", err)
	}
	var left protocol.Left
	if err := json.Unmarshal(data, &left); err != nil {
		t.Fatalf("left unmarshal: %v", err)
	}
	// online_count broadcast is suppressed at count 0 — no further frame expected

	// a fresh connection rejoins the same channel within the EmptyTTL window
	c2, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial c2: %v", err)
	}
	defer c2.Close(websocket.StatusNormalClosure, "")
	if err := writeJSON(ctx, c2, map[string]string{"type": "join_channel", "channelId": chID}); err != nil {
		t.Fatalf("write rejoin: %v", err)
	}
	_, data, err = c2.Read(ctx)
	if err != nil {
		t.Fatalf("read rejoin: %v", err)
	}
	var joined protocol.Joined
	if err := json.Unmarshal(data, &joined); err != nil {
		t.Fatalf("joined unmarshal: %v data %s", err, string(data))
	}
	if joined.Type != protocol.JoinedTypeJoined || joined.Online != 1 {
		t.Fatalf("expected joined(1) after rejoin, got %+v", joined)
	}
}

// TestOriginVerification pins the CSWSH defence: the handler must refuse a
// handshake whose Origin does not match the request Host, and accept one that
// does. Browser clients always connect to their own origin, so this cannot be
// re-enabled by loosening the check.
func TestOriginVerification(t *testing.T) {
	rawURL, closeFn := newTestServer(t)
	defer closeFn()

	dial := func(origin string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		h := http.Header{}
		if origin != "" {
			h.Set("Origin", origin)
		}
		c, _, err := websocket.Dial(ctx, rawURL, &websocket.DialOptions{HTTPHeader: h})
		if err == nil {
			c.Close(websocket.StatusNormalClosure, "")
		}
		return err
	}

	host := strings.TrimPrefix(strings.TrimPrefix(rawURL, "ws://"), "wss://")

	if err := dial("http://evil.example"); err == nil {
		t.Fatal("expected handshake from a foreign origin to be rejected")
	}
	if err := dial("http://" + host); err != nil {
		t.Fatalf("expected same-origin handshake to be accepted: %v", err)
	}
	// non-browser clients send no Origin; those stay allowed
	if err := dial(""); err != nil {
		t.Fatalf("expected origin-less handshake to be accepted: %v", err)
	}
}

// TestClientIP pins which address the rate limiter buckets a client under. With
// TRUST_PROXY_XFF unset the peer address wins even when a client supplies
// X-Forwarded-For; with it set, only the right-most XFF entry — the one the
// trusted proxy appended — is believed, so a client cannot pick its own bucket.
func TestClientIP(t *testing.T) {
	newReq := func(remoteAddr, xff string) *http.Request {
		r := &http.Request{RemoteAddr: remoteAddr, Header: http.Header{}}
		if xff != "" {
			r.Header.Set("X-Forwarded-For", xff)
		}
		return r
	}

	direct := &Server{} // default: never believe client headers
	behindProxy := &Server{trustXFF: true}

	tests := []struct {
		name string
		srv  *Server
		req  *http.Request
		want string
	}{
		{"peer address when no XFF", behindProxy, newReq("203.0.113.7:5555", ""), "203.0.113.7"},
		{"XFF ignored when not trusted", direct, newReq("203.0.113.7:5555", "198.51.100.9"), "203.0.113.7"},
		{"single hop", behindProxy, newReq("10.0.0.2:5555", "203.0.113.7"), "203.0.113.7"},
		{"right-most hop wins", behindProxy, newReq("10.0.0.2:5555", "1.1.1.1, 203.0.113.7"), "203.0.113.7"},
		{"prepending cannot forge a bucket", behindProxy, newReq("10.0.0.2:5555", "1.1.1.1, 1.1.1.2, 203.0.113.7"), "203.0.113.7"},
		{"unparseable XFF falls back to peer", behindProxy, newReq("10.0.0.2:5555", "not-an-ip"), "10.0.0.2"},
		{"blank last entry falls back to peer", behindProxy, newReq("10.0.0.2:5555", "203.0.113.7, "), "10.0.0.2"},
		{"ipv6 peer", behindProxy, newReq("[2001:db8::1]:5555", ""), "2001:db8::1"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.srv.clientIP(tc.req); got != tc.want {
				t.Fatalf("clientIP = %q, want %q", got, tc.want)
			}
		})
	}
}

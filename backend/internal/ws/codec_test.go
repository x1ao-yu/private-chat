package ws

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"chat/internal/protocol"
)

func TestDecodeValid(t *testing.T) {
	cases := []struct {
		json string
		want string // expected type value
	}{
		{`{"type":"create_channel"}`, "create_channel"},
		{`{"type":"join_channel","channelId":"abc123"}`, "join_channel"},
		{`{"type":"send_message","channelId":"abc123","payload":"hello"}`, "send_message"},
		{`{"type":"channel_created","channelId":"abc123"}`, "channel_created"},
		{`{"type":"message","channelId":"abc123","payload":"hello","from":"peer1"}`, "message"},
		{`{"type":"error","code":"invalid_message","message":"bad"}`, "error"},
	}
	for _, c := range cases {
		v, err := Decode([]byte(c.json))
		if err != nil {
			t.Fatalf("Decode %q failed: %v", c.json, err)
		}
		// peek type via json
		var peek typePeek
		_ = json.Unmarshal([]byte(c.json), &peek)
		if peek.Type != c.want {
			t.Fatalf("expected type %q got %q", c.want, peek.Type)
		}
		// ensure Encode round-trips
		data, err := Encode(v)
		if err != nil {
			t.Fatalf("Encode failed: %v", err)
		}
		var m map[string]interface{}
		if err := json.Unmarshal(data, &m); err != nil {
			t.Fatalf("marshal produced invalid json: %v", err)
		}
		if m["type"] != c.want {
			t.Fatalf("encode type mismatch: want %q got %v", c.want, m["type"])
		}
	}
}

func TestDecodeInvalid(t *testing.T) {
	invalid := []string{
		`{"type":"unknown_type"}`,
		`{"type":"join_channel","channelId":"bad id with spaces"}`,
		`{"type":"join_channel"}`,
		`{"type":"send_message","channelId":"abc","payload":"` + string(make([]byte, 9000)) + `"}`,
		`not json`,
		`{"channelId":"abc"}`,
	}
	for _, s := range invalid {
		if _, err := Decode([]byte(s)); err == nil {
			t.Fatalf("expected error for %q", s)
		}
	}
}

func TestDecodeExamples(t *testing.T) {
	// Validate all files in protocol/examples can be decoded
	entries, err := os.ReadDir("../../..//protocol/examples")
	if err != nil {
		// try alternative relative path from backend dir
		entries, err = os.ReadDir(filepath.Join("..", "..", "..", "protocol", "examples"))
		if err != nil {
			t.Fatalf("read examples: %v", err)
		}
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join("..", "..", "..", "protocol", "examples", e.Name()))
		if err != nil {
			data, err = os.ReadFile(filepath.Join("../../../protocol/examples", e.Name()))
			if err != nil {
				t.Fatalf("read %s: %v", e.Name(), err)
			}
		}
		if _, err := Decode(data); err != nil {
			t.Fatalf("example %s failed to decode: %v (data %s)", e.Name(), err, string(data))
		}
	}
}

func TestEncodeValidation(t *testing.T) {
	// Test that generated validation catches invalid channelId via Unmarshal
	bad := []byte(`{"type":"join_channel","channelId":"bad!"}`)
	if _, err := Decode(bad); err == nil {
		t.Fatal("expected validation error for bad channelId")
	}
	// Test that protocol struct validation also fails if we try to encode then decode
	// Create a valid struct then check encode succeeds
	v := protocol.JoinChannel{
		Type:      protocol.JoinChannelTypeJoinChannel,
		ChannelId: "valid123",
	}
	data, err := Encode(v)
	if err != nil {
		t.Fatalf("encode valid: %v", err)
	}
	if _, err := Decode(data); err != nil {
		t.Fatalf("decode of encoded valid: %v", err)
	}
}

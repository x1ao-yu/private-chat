package ws

import (
	"encoding/json"
	"fmt"

	"chat/internal/protocol"
)

// AnyMessage is a union of all protocol messages.
// For P0 we use raw JSON peek to dispatch, leveraging generated UnmarshalJSON validation.

type typePeek struct {
	Type string `json:"type"`
}

// Decode decodes raw JSON into the appropriate protocol struct based on "type".
// Returns one of the generated types (e.g., *protocol.CreateChannel, *protocol.JoinChannel, etc.)
// or error if type unknown or validation fails.
func Decode(raw []byte) (interface{}, error) {
	var peek typePeek
	if err := json.Unmarshal(raw, &peek); err != nil {
		return nil, fmt.Errorf("invalid json: %w", err)
	}
	switch peek.Type {
	case "create_channel":
		var v protocol.CreateChannel
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		return &v, nil
	case "join_channel":
		var v protocol.JoinChannel
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		return &v, nil
	case "leave_channel":
		var v protocol.LeaveChannel
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		return &v, nil
	case "send_message":
		var v protocol.SendMessage
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		return &v, nil
	case "key_update":
		var v protocol.KeyUpdate
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		return &v, nil
	case "key_updated":
		var v protocol.KeyUpdated
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		return &v, nil
	case "channel_created":
		var v protocol.ChannelCreated
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		return &v, nil
	case "joined":
		var v protocol.Joined
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		return &v, nil
	case "left":
		var v protocol.Left
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		return &v, nil
	case "message":
		var v protocol.BroadcastMessage
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		return &v, nil
	case "online_count":
		var v protocol.OnlineCount
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		return &v, nil
	case "error":
		var v protocol.Error
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		return &v, nil
	default:
		return nil, fmt.Errorf("unknown message type: %q", peek.Type)
	}
}

// Encode marshals a protocol message to JSON.
func Encode(v interface{}) ([]byte, error) {
	return json.Marshal(v)
}

// IsClientMessage reports whether type is a client->server message.
func IsClientMessage(typeStr string) bool {
	switch typeStr {
	case "create_channel", "join_channel", "leave_channel", "send_message", "key_update":
		return true
	default:
		return false
	}
}

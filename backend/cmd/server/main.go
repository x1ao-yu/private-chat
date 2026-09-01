package main

import (
	"log"
	"net/http"
	"time"

	"chat/internal/channel"
	"chat/internal/ws"
)

func main() {
	manager := channel.New()
	srv := ws.NewServer(manager)

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/ws", srv.Handler)

	// P4: room expiration — single-instance, in-memory only, restart drops state.
	// Empty rooms 10m, idle rooms 24h. Sweep every 1m. Log only count + channelIds (no peer-id/payload).
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			expired := manager.ExpireNow()
			if len(expired) > 0 {
				log.Printf("expired %d channels", len(expired))
			}
		}
	}()

	addr := ":8080"
	log.Printf("backend listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("listen: %v", err)
	}
}

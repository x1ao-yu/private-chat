package main

import (
	"context"
	"log"
	"net/http"
	"os/signal"
	"syscall"
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
	httpSrv := &http.Server{Addr: addr, Handler: mux}

	// graceful shutdown for container stop (SIGTERM): stop accepting, drain
	// briefly, then exit — in-memory state is dropped by design
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	listenErr := make(chan error, 1)
	go func() {
		log.Printf("backend listening on %s", addr)
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			listenErr <- err
		}
	}()

	select {
	case err := <-listenErr:
		log.Fatalf("listen: %v", err)
	case <-ctx.Done():
		log.Printf("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := httpSrv.Shutdown(shutdownCtx); err != nil {
			log.Printf("shutdown: %v", err)
		}
	}
}
